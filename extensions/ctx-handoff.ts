/**
 * ctx-handoff — context compaction via a dedicated summarizer model
 *
 * A pi (https://github.com/earendil-works/pi) extension that keeps your
 * context small by summarizing it with a *different* model than the one
 * running the conversation — e.g. a cheap local model via LM Studio —
 * while producing summaries that are byte-for-byte compatible with pi's
 * native `/compact`.
 *
 * How it works:
 * - turn_end: watches ctx.getContextUsage() and fires a handoff compaction
 *   when usage crosses the threshold (default 90% of the context window).
 *   Also shows a `ctx NN%` footer status.
 * - session_before_compact: serializes the messages that pi already selected
 *   for summarization and asks the configured handoff model for a summary,
 *   using pi's *native* summarization prompts, native token budget formula,
 *   and native <read-files>/<modified-files> appendix — so summary quality
 *   matches the built-in compaction. Only the model differs.
 * - /handoff command: trigger the same compaction manually at any time.
 *
 * On any failure (model missing, empty output, network error, user abort)
 * it falls through to pi's default compaction by returning undefined.
 *
 * Configuration (first match wins, per field):
 *   1. Environment: PI_HANDOFF_PROVIDER, PI_HANDOFF_MODEL, PI_HANDOFF_THRESHOLD
 *   2. Project file: <project>/.pi/ctx-handoff.json (found by walking up
 *      from the session's working directory; nearest wins)
 *      { "provider": "lm-studio", "modelId": "qwen/qwen3.8-27b", "threshold": 90 }
 *   3. Global file: ~/.pi/agent/ctx-handoff.json
 *   4. Defaults: lm-studio / qwen/qwen3.8-27b / 90
 *
 * Project files let each repository pick its own summarizer model and
 * threshold (e.g. a beefier model for a huge codebase, a lower threshold
 * for long agent runs) without touching global settings. Config is read
 * per event, so edits apply to the next compaction without a reload.
 *
 * The model must be registered in pi (providers/models in ~/.pi/agent/models.json
 * or project .pi/models.json) and resolvable via the model registry.
 *
 * Placement: ~/.pi/agent/extensions/ctx-handoff.ts, or install this package
 * with `pi install git:github.com/anvarazizov/pi-ctx-handoff`. Reload with /reload.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

interface HandoffConfig {
	provider: string;
	modelId: string;
	/** Context usage percent (0–100) that triggers a handoff compaction. */
	threshold: number;
}

const DEFAULT_CONFIG: HandoffConfig = {
	provider: "lm-studio",
	modelId: "qwen/qwen3.8-27b",
	threshold: 90,
};

function readConfigFile(filePath: string): Partial<HandoffConfig> {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as Partial<HandoffConfig>;
	} catch {
		// Missing or unreadable — other config sources still apply.
		return {};
	}
}

/**
 * Project-local config: <dir>/.pi/ctx-handoff.json, discovered by walking up
 * from the session's working directory (mirrors pi's project discovery, so
 * launching pi from a subdirectory still finds the project root). The
 * nearest file wins.
 */
function findProjectConfig(cwd: string): Partial<HandoffConfig> {
	let dir = path.resolve(cwd);
	for (;;) {
		const config = readConfigFile(path.join(dir, ".pi", "ctx-handoff.json"));
		if (Object.keys(config).length > 0) return config;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

/**
 * Resolve the effective config. Per field, highest priority first:
 * env vars → project .pi/ctx-handoff.json → global ~/.pi/agent/ctx-handoff.json
 * → defaults. Read per event so config edits apply without a reload.
 */
function loadConfig(cwd: string): HandoffConfig {
	const global = readConfigFile(path.join(homedir(), ".pi", "agent", "ctx-handoff.json"));
	const project = findProjectConfig(cwd);
	const merged = { ...global, ...project };

	const envThreshold = process.env.PI_HANDOFF_THRESHOLD
		? Number(process.env.PI_HANDOFF_THRESHOLD)
		: NaN;

	const config: HandoffConfig = {
		provider: process.env.PI_HANDOFF_PROVIDER ?? merged.provider ?? DEFAULT_CONFIG.provider,
		modelId: process.env.PI_HANDOFF_MODEL ?? merged.modelId ?? DEFAULT_CONFIG.modelId,
		threshold: Number.isFinite(envThreshold)
			? envThreshold
			: (merged.threshold ?? DEFAULT_CONFIG.threshold),
	};

	if (!Number.isFinite(config.threshold) || config.threshold <= 0 || config.threshold > 100) {
		config.threshold = DEFAULT_CONFIG.threshold;
	}
	return config;
}

// Marker injected into customInstructions by the /handoff command so the
// session_before_compact handler can route a manual compaction through the
// handoff path instead of pi's default summarizer. Plain /compact stays
// on the default path.
const MANUAL_HANDOFF_MARKER = "__ctx_handoff_manual__";

// ----------------------------------------------------------------------------
// Native pi summarization bits (copied verbatim from
// packages/coding-agent/src/core/compaction/ — not exported from the package
// root, so inlined here; keep in sync with pi upgrades).
// ----------------------------------------------------------------------------

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

// Native file-list helpers (compaction/utils.ts): same cumulative
// read/modified tracking the default compaction appends to its summary.
function computeFileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ----------------------------------------------------------------------------
// Extension
// ----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Config is resolved per event (each handler has ctx.cwd), so project
	// configs apply in the right session and edits don't need a reload.
	const cfg = (ctx: ExtensionContext): HandoffConfig => loadConfig(ctx.cwd);

	// Armed-flag model: fire once when over threshold, then stay disarmed
	// until compaction completes (which re-arms). This correctly handles a
	// session that *starts* already above threshold (e.g. resumed), which a
	// rising-edge detector would miss (null → 4210 is not a "crossing").
	let armed = true;
	let handoffInFlight = false;

	const trigger = (ctx: ExtensionContext, manual = false) => {
		const config = cfg(ctx);
		if (handoffInFlight) return;
		handoffInFlight = true;
		if (ctx.hasUI) {
			const label = manual ? "manual handoff" : `ctx ≥ ${config.threshold}% — handoff`;
			ctx.ui.notify(`${label} to ${config.modelId}`, "info");
		}
		ctx.compact({
			customInstructions: manual
				? `${MANUAL_HANDOFF_MARKER} Produce a structured context checkpoint summary so the main agent can continue after compaction.`
				: "Produce a structured context checkpoint summary so the main agent can continue after compaction.",
			onComplete: () => {
				handoffInFlight = false;
				armed = true; // re-arm after a completed compaction
				if (ctx.hasUI) ctx.ui.notify("Handoff compaction completed", "info");
			},
			onError: (error: Error) => {
				handoffInFlight = false;
				if (ctx.hasUI) ctx.ui.notify(`Handoff compaction failed: ${error.message}`, "error");
			},
		});
	};

	// --- Detector: fire once when over threshold, re-arm after compaction ---
	// Also updates the footer status with the current ctx % each turn.
	// percent is 0–100 (see pi's agent-session.js: `(tokens/contextWindow)*100`),
	// so the threshold is in percent and displays must NOT multiply by 100.
	const fmtStatus = (ctx: ExtensionContext, pct: number | null): string => {
		if (pct === null) return "ctx ?%";
		const tag = pct >= cfg(ctx).threshold ? " ⚡handoff" : "";
		return `ctx ${Math.round(pct)}%${tag}`;
	};

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const pct = usage?.percent ?? null;
		if (ctx.hasUI) ctx.ui.setStatus("ctx-handoff", fmtStatus(ctx, pct));
		if (pct === null) return;
		// Fire on the first turn we're over threshold while armed; the
		// in-flight + armed flags keep it from re-firing every turn while
		// we wait for compaction to finish, and re-arming after completion
		// lets it fire again on the next cycle.
		if (pct >= cfg(ctx).threshold && armed && !handoffInFlight) {
			armed = false;
			trigger(ctx);
		}
	});

	// --- Handoff summary via the handoff model ------------------------------
	// Mirrors pi's native generateSummaryWithUsage(): same system prompt,
	// same SUMMARIZATION/UPDATE prompt, same "Additional focus" handling for
	// customInstructions, same maxTokens formula, same <read-files>/
	// <modified-files> appendix — only the model differs.
	pi.on("session_before_compact", async (event, ctx) => {
		// Route through the handoff path for:
		//  - auto-threshold compactions (our threshold trigger, and pi's own)
		//  - manual compactions invoked via the /handoff command (marker)
		// Plain /compact (reason "manual", no marker) and overflow recovery
		// (reason "overflow") use pi's default summarizer — predictable.
		const isManualHandoff =
			event.reason === "manual" && event.customInstructions?.includes(MANUAL_HANDOFF_MARKER);
		if (event.reason !== "threshold" && !isManualHandoff) return;

		const config = cfg(ctx);
		const { preparation, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
			fileOps,
			settings,
		} = preparation;

		const model = ctx.modelRegistry.find(config.provider, config.modelId);
		if (!model) {
			if (ctx.hasUI)
				ctx.ui.notify(
					`Handoff model ${config.provider}/${config.modelId} not found — using default compaction`,
					"warning",
				);
			return; // fall through to default compaction
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) return;

		// Same token budget as native compaction:
		// min(0.8 * reserveTokens, model max output), where reserveTokens is
		// the effective setting (respects settings.json + per-model overrides).
		const maxTokens = Math.min(
			Math.floor(0.8 * settings.reserveTokens),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);

		// Strip our routing marker; keep the rest as a native-style focus hint.
		const customInstructions = event.customInstructions
			?.replaceAll(MANUAL_HANDOFF_MARKER, "")
			.trim();

		// Native prompt assembly (compaction.ts generateSummaryWithUsage):
		let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		if (customInstructions) {
			basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
		}

		const conversationText = serializeConversation(convertToLlm(allMessages));
		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += basePrompt;

		const summaryMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		if (ctx.hasUI)
			ctx.ui.notify(
				`Handoff: summarizing ${allMessages.length} messages (~${tokensBefore.toLocaleString()} tokens, max ${maxTokens.toLocaleString()} out) via ${config.modelId}...`,
				"info",
			);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					// Same system prompt as native compaction.
					systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
					messages: summaryMessages,
				},
				{
					maxTokens,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(), // one-off prompt, not reused
				},
			);

			if (signal.aborted) return; // user cancelled → default compaction

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				if (ctx.hasUI) ctx.ui.notify("Handoff summary was empty — using default compaction", "warning");
				return;
			}

			// Same file-list appendix as native compaction, so the next
			// context keeps cumulative read/modified file tracking.
			const { readFiles, modifiedFiles } = computeFileLists(fileOps);

			if (ctx.hasUI) ctx.ui.notify("Handoff summary ready — applying compaction", "info");

			return {
				compaction: {
					summary: summary + formatFileOperations(readFiles, modifiedFiles),
					firstKeptEntryId, // keep the recent ~20k tail
					tokensBefore,
					usage: response.usage, // counted in session totals
					details: { readFiles, modifiedFiles }, // native details format
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI)
				ctx.ui.notify(`Handoff generation failed: ${message} — using default compaction`, "error");
			return; // fall through to default compaction
		}
	});

	// --- Manual /handoff command --------------------------------------------
	pi.registerCommand("handoff", {
		description: "Trigger a context-handoff compaction now (summary via the handoff model)",
		handler: async (_args, ctx) => {
			const config = cfg(ctx);
			const usage = ctx.getContextUsage();
			const pct = usage?.percent ?? null;
			// If over threshold, the auto-detector fires on the next turn_end;
			// /handoff is mainly for forcing it *now* when below threshold or the
			// detector hasn't run yet. The in-flight flag dedups, so just proceed.
			if (pct !== null && pct >= config.threshold && ctx.hasUI) {
				ctx.ui.notify(
					`ctx at ${Math.round(pct)}% — firing handoff now`,
					"info",
				);
			}
			trigger(ctx, true);
		},
	});
}
