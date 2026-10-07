/**
 * Tests for ctx-handoff: fallback-model logic and config resolution.
 *
 * Runs the real extension against a mocked pi API (ExtensionAPI + ctx),
 * so the actual handler code is exercised end-to-end.
 *
 * Run: npm test (uses tsx)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/ctx-handoff.ts";

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

interface MockModel {
	provider: string;
	id: string;
	maxTokens?: number;
}

type CompleteBehavior = (model: { id: string }, calls: unknown[]) => Promise<unknown>;

function loadExtension() {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const commands: Record<string, { description: string; handler: (...args: unknown[]) => unknown }> = {};
	const pi = {
		on: (name: string, fn: (...args: unknown[]) => unknown) => {
			handlers[name] = fn;
		},
		registerCommand: (name: string, def: { description: string; handler: (...args: unknown[]) => unknown }) => {
			commands[name] = def;
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return { handlers, commands };
}

function makeCtx(opts: {
	models: MockModel[];
	complete: CompleteBehavior;
	cwd: string;
	notifications?: Array<[string, string]>;
}) {
	const calls: Array<{ modelId: string; context: unknown; options: unknown }> = [];
	const notifications = opts.notifications ?? [];
	return {
		calls,
		ctx: {
			hasUI: true,
			cwd: opts.cwd,
			ui: {
				notify: (message: string, level: string) => notifications.push([message, level]),
				setStatus: () => {},
			},
			getContextUsage: () => ({ percent: 50 }),
			compact: () => {},
			modelRegistry: {
				find: (provider: string, id: string) =>
					opts.models.find((m) => m.provider === provider && m.id === id)
						? { id, maxTokens: opts.models.find((m) => m.provider === provider && m.id === id)!.maxTokens ?? 32768 }
						: undefined,
				complete: async (model: { id: string }, context: unknown, options: unknown) => {
					calls.push({ modelId: model.id, context, options });
					return opts.complete(model, calls);
				},
			},
		},
	};
}

const SUMMARY_TEXT = "## Goal\nFix the login bug\n\n## Progress\n### Done\n- [x] work";

function okComplete(text = SUMMARY_TEXT): CompleteBehavior {
	return async () => ({
		content: [{ type: "text", text }],
		usage: { inputTokens: 10, outputTokens: 5 },
	});
}

function makeEvent(overrides: Record<string, unknown> = {}) {
	return {
		reason: "threshold",
		customInstructions: undefined,
		signal: new AbortController().signal,
		preparation: {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [
				{ role: "user", content: [{ type: "text", text: "Fix the login bug in auth.ts" }], timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "Looking at src/auth.ts now." }], timestamp: 2 },
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 123456,
			previousSummary: undefined,
			fileOps: { read: new Set(["src/auth.ts"]), written: new Set(), edited: new Set(["src/login.ts"]) },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		...overrides,
	};
}

// ----------------------------------------------------------------------------
// Config fixtures: isolated HOME + project dir, no env interference
// ----------------------------------------------------------------------------

const ENV_KEYS = [
	"PI_HANDOFF_PROVIDER",
	"PI_HANDOFF_MODEL",
	"PI_HANDOFF_THRESHOLD",
	"PI_HANDOFF_FALLBACK_PROVIDER",
	"PI_HANDOFF_FALLBACK_MODEL",
];

const savedEnv: Record<string, string | undefined> = {};
const savedHome = process.env.HOME;

function setupEnv(globalConfig?: Record<string, unknown>, projectConfig?: Record<string, unknown>) {
	const root = mkdtempSync(path.join(tmpdir(), "ctx-handoff-test-"));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(path.join(project, ".pi"), { recursive: true });

	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.HOME = home;

	if (globalConfig) {
		writeFileSync(path.join(home, ".pi", "agent", "ctx-handoff.json"), JSON.stringify(globalConfig));
	}
	if (projectConfig) {
		writeFileSync(path.join(project, ".pi", "ctx-handoff.json"), JSON.stringify(projectConfig));
	}
	return { root, home, project };
}

function teardownEnv(root: string) {
	rmSync(root, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	process.env.HOME = savedHome;
}

// Standard config used by most scenarios: primary qwen + fallback gemma.
const CONFIG = {
	provider: "prov-a",
	modelId: "model-primary",
	fallbackProvider: "prov-b",
	fallbackModelId: "model-fallback",
};

const MODELS: MockModel[] = [
	{ provider: "prov-a", id: "model-primary" },
	{ provider: "prov-b", id: "model-fallback" },
];

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

async function runCompact(
	scenario: {
		models?: MockModel[];
		complete: CompleteBehavior;
		eventOverrides?: Record<string, unknown>;
		globalConfig?: Record<string, unknown>;
		projectConfig?: Record<string, unknown>;
	},
) {
	const { handlers } = loadExtension();
	const env = setupEnv(scenario.globalConfig ?? CONFIG, scenario.projectConfig);
	try {
		const notifications: Array<[string, string]> = [];
		const { ctx, calls } = makeCtx({
			models: scenario.models ?? MODELS,
			complete: scenario.complete,
			cwd: env.project,
			notifications,
		});
		const result = await handlers["session_before_compact"](makeEvent(scenario.eventOverrides), ctx);
		return { result, calls, notifications };
	} finally {
		teardownEnv(env.root);
	}
}

test("primary model works — no fallback involved", async () => {
	const { result, calls, notifications } = await runCompact({ complete: okComplete() });
	assert.ok(result?.compaction, "compaction returned");
	assert.equal(calls.length, 1, "only one LLM call");
	assert.equal(calls[0].modelId, "model-primary");
	assert.ok(result.compaction.summary.includes("Fix the login bug"));
	assert.ok(!notifications.some(([, level]) => level === "warning" || level === "error"));
});

test("summary gets native file-list appendix and details", async () => {
	const { result } = await runCompact({ complete: okComplete() });
	assert.ok(result.compaction.summary.includes("<read-files>\nsrc/auth.ts\n</read-files>"));
	assert.ok(result.compaction.summary.includes("<modified-files>\nsrc/login.ts\n</modified-files>"));
	assert.deepEqual(result.compaction.details, { readFiles: ["src/auth.ts"], modifiedFiles: ["src/login.ts"] });
	assert.equal(result.compaction.firstKeptEntryId, "kept-1");
	assert.equal(result.compaction.tokensBefore, 123456);
	assert.deepEqual(result.compaction.usage, { inputTokens: 10, outputTokens: 5 });
});

test("primary model missing — falls back to fallback model", async () => {
	const { result, calls, notifications } = await runCompact({
		models: [MODELS[1]], // only fallback registered
		complete: okComplete(),
	});
	assert.ok(result?.compaction, "fallback produced compaction");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].modelId, "model-fallback");
	assert.ok(notifications.some(([m]) => m.includes("not found — trying fallback model-fallback")));
});

test("primary request fails — retries on fallback", async () => {
	let called = false;
	const { result, calls, notifications } = await runCompact({
		complete: async (model) => {
			if (!called) {
				called = true;
				throw new Error("connection refused");
			}
			return { content: [{ type: "text", text: SUMMARY_TEXT }], usage: { inputTokens: 1, outputTokens: 1 } };
		},
	});
	assert.ok(result?.compaction, "fallback produced compaction");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].modelId, "model-primary");
	assert.equal(calls[1].modelId, "model-fallback");
	assert.ok(notifications.some(([m, l]) => l === "warning" && m.includes("trying fallback")));
});

test("primary returns empty summary — retries on fallback", async () => {
	let called = false;
	const { result, calls } = await runCompact({
		complete: async (model) => {
			const empty = !called;
			called = true;
			return {
				content: [{ type: "text", text: empty ? "   " : SUMMARY_TEXT }],
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		},
	});
	assert.ok(result?.compaction, "fallback produced compaction");
	assert.equal(calls.length, 2);
	assert.equal(calls[1].modelId, "model-fallback");
});

test("both models missing — default compaction (undefined)", async () => {
	const { result, calls, notifications } = await runCompact({
		models: [],
		complete: okComplete(),
	});
	assert.equal(result, undefined);
	assert.equal(calls.length, 0);
	assert.ok(notifications.some(([m, l]) => l === "warning" && m.includes("not found")));
});

test("both models fail — default compaction (undefined)", async () => {
	const { result, calls, notifications } = await runCompact({
		complete: async () => {
			throw new Error("boom");
		},
	});
	assert.equal(result, undefined);
	assert.equal(calls.length, 2);
	assert.ok(notifications.some(([, l]) => l === "error"));
});

test("user abort during primary — no fallback attempt", async () => {
	const controller = new AbortController();
	const { result, calls } = await runCompact({
		complete: async () => {
			controller.abort();
			throw new Error("request aborted");
		},
		eventOverrides: { signal: controller.signal },
	});
	assert.equal(result, undefined);
	assert.equal(calls.length, 1, "fallback must not be tried after abort");
});

test("plain /compact (manual, no marker) is not routed through handoff", async () => {
	const { calls } = await runCompact({
		complete: okComplete(),
		eventOverrides: { reason: "manual", customInstructions: undefined },
	});
	assert.equal(calls.length, 0, "no model calls for plain /compact");
});

test("manual /handoff (marker) routes through handoff model", async () => {
	const { result, calls } = await runCompact({
		complete: okComplete(),
		eventOverrides: {
			reason: "manual",
			customInstructions: "__ctx_handoff_manual__ Produce a structured context checkpoint summary.",
		},
	});
	assert.ok(result?.compaction);
	assert.equal(calls.length, 1);
	// The routing marker must not leak into the prompt.
	const prompt = (calls[0].context as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content[0].text;
	assert.ok(!prompt.includes("__ctx_handoff_manual__"), "marker stripped from prompt");
	assert.ok(prompt.includes("Additional focus:"));
});

test("previous summary selects the native UPDATE prompt", async () => {
	const { calls } = await runCompact({
		complete: okComplete(),
		eventOverrides: {
			preparation: {
				...makeEvent().preparation,
				previousSummary: "## Goal\nold goal",
			},
		},
	});
	const prompt = (calls[0].context as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content[0].text;
	assert.ok(prompt.includes("NEW conversation messages"), "uses UPDATE_SUMMARIZATION_PROMPT");
	assert.ok(prompt.includes("<previous-summary>\n## Goal\nold goal\n</previous-summary>"));
});

test("no fallback configured — primary failure goes straight to default compaction", async () => {
	const { result, calls, notifications } = await runCompact({
		globalConfig: { provider: "prov-a", modelId: "model-primary" },
		complete: async () => {
			throw new Error("boom");
		},
	});
	assert.equal(result, undefined);
	assert.equal(calls.length, 1, "no second attempt without configured fallback");
	assert.ok(notifications.some(([m, l]) => l === "error" && m.includes("using default compaction")));
});

test("project config overrides global per field; omitted fields inherit", async () => {
	const { result, calls } = await runCompact({
		globalConfig: CONFIG,
		projectConfig: { modelId: "model-fallback" }, // swap primary, keep fallback
		complete: okComplete(),
	});
	assert.ok(result?.compaction);
	assert.equal(calls[0].modelId, "model-fallback", "project modelId wins");
});

test("env vars override config files", async () => {
	const env = setupEnv(CONFIG);
	try {
		process.env.PI_HANDOFF_MODEL = "model-fallback";
		const { handlers } = loadExtension();
		const notifications: Array<[string, string]> = [];
		const { ctx, calls } = makeCtx({ models: MODELS, complete: okComplete(), cwd: env.project, notifications });
		const result = await handlers["session_before_compact"](makeEvent(), ctx);
		assert.ok(result?.compaction);
		assert.equal(calls[0].modelId, "model-fallback", "env PI_HANDOFF_MODEL wins over files");
	} finally {
		teardownEnv(env.root);
	}
});

test("project config in a parent directory is discovered from a subdirectory cwd", async () => {
	const env = setupEnv(CONFIG, { modelId: "model-fallback" });
	const sub = path.join(env.project, "src", "deep");
	mkdirSync(sub, { recursive: true });
	try {
		const { handlers } = loadExtension();
		const { ctx, calls } = makeCtx({ models: MODELS, complete: okComplete(), cwd: sub });
		const result = await handlers["session_before_compact"](makeEvent(), ctx);
		assert.ok(result?.compaction);
		assert.equal(calls[0].modelId, "model-fallback", "walked up to project root");
	} finally {
		teardownEnv(env.root);
	}
});

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.error(`  ✗ ${name}`);
		console.error(`    ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed > 0 ? 1 : 0);
