# ctx-handoff

A [pi](https://github.com/earendil-works/pi) extension that compacts your context with a **dedicated summarizer model** — for example a cheap local model via LM Studio — while producing summaries that are **identical in quality to pi's native `/compact`**.

```
main model (expensive, big context)          handoff model (cheap, fast)
┌───────────────────────────┐                ┌──────────────────────────┐
│ works on the task         │   when ctx     │ summarizes the old       │
│ keeps the last ~20k tok…  │   hits 90% ──▶ │ context with pi's native │
│                           │                │ prompt & token budget    │
└───────────────────────────┘                └──────────────────────────┘
```

## Why

- **Cost**: summarization is a one-off bulk job — a small local model handles it fine, so compaction costs nothing from your main model's quota.
- **Latency**: pi stops, compacts, and continues; a fast local summarizer makes that pause short.
- **No quality loss**: the extension reuses pi's own compaction machinery — the same prompts, the same token budget, the same file-tracking appendix — only the model that writes the summary differs.

## How it works

| Piece | Behavior |
|---|---|
| `turn_end` hook | Watches context usage each turn. When it crosses the threshold (default **90%**), fires a handoff compaction once, then re-arms. Shows a `ctx NN%` footer status (with `⚡handoff` when armed-hot). |
| `session_before_compact` hook | Intercepts the compaction pi already prepared (same cut point, same kept tail of ~20k recent tokens), serializes the messages pi selected, and asks the configured **handoff model** for the summary. If the handoff model is missing or fails and a **fallback model** is configured, the request is retried once on the fallback. |
| `/handoff` command | Fires the same compaction manually, at any context level. |
| Fallback | If the handoff model is missing, the summary is empty, the request fails, or you cancel — the extension steps aside and pi's **default compaction** runs instead. Nothing breaks. With a configured fallback model, a failed primary gets one retry on the fallback first (user aborts never escalate). |

Plain `/compact` and overflow-recovery compactions always use pi's default summarizer; only threshold-triggered and `/handoff` compactions go through the handoff model.

## Native-quality parity

The summary is generated exactly like pi's built-in compaction:

- **System prompt**: pi's own `SUMMARIZATION_SYSTEM_PROMPT`.
- **Prompts**: pi's native `SUMMARIZATION_PROMPT` (first compaction) and `UPDATE_SUMMARIZATION_PROMPT` (iterative updates via `<previous-summary>`), with the same `<conversation>` tag layout and `Additional focus:` handling for custom instructions.
- **Token budget**: the same formula — `min(0.8 × reserveTokens, model max output)` — where `reserveTokens` comes from your `settings.json`, including per-model `compaction.modelOverrides`.
- **File tracking**: the same cumulative `<read-files>` / `<modified-files>` appendix, recorded in the compaction entry's `details` like native compaction does.

> [!NOTE]
> The prompts are copied verbatim from pi's source (they are not exported by the package). When upgrading pi, it's worth re-diffing `packages/coding-agent/src/core/compaction/` against the copies in the extension.

## Install

### As a pi package (recommended)

```bash
pi install git:github.com/anvarazizov/pi-ctx-handoff
```

Update later with `pi update --extensions`, remove with `pi remove`.

Or try it once without installing:

```bash
pi -e git:github.com/anvarazizov/pi-ctx-handoff
```

### Manually

Copy [`extensions/ctx-handoff.ts`](extensions/ctx-handoff.ts) to `~/.pi/agent/extensions/` (global) or `<project>/.pi/extensions/` (per-project), then run `/reload` inside pi.

## Configure

The handoff model must be registered in pi (see `~/.pi/agent/models.json` or the [custom models docs](https://github.com/earendil-works/pi)). Configuration resolves per field, highest priority first:

1. **Environment variables** — override everything
2. **Project file** — `<project>/.pi/ctx-handoff.json` (found by walking up from the session's working directory, so launching pi from a subdirectory works; nearest file wins)
3. **Global file** — `~/.pi/agent/ctx-handoff.json`
4. **Defaults**

**Global file** — `~/.pi/agent/ctx-handoff.json`:

```json
{
	"provider": "lm-studio",
	"modelId": "qwen/qwen3.8-27b",
	"threshold": 90,
	"fallbackProvider": "lm-studio",
	"fallbackModelId": "google/gemma-4-26b"
}
```

**Fallback model** — optional. When `fallbackProvider` + `fallbackModelId` are set, a missing or failing primary summarizer gets one retry on the fallback before compaction falls back to pi's default. Handy when the primary summarizer is a local server that's sometimes down: configure a second local server (or a cheap API model) as the safety net. Leave both fields out (or empty) to disable.

**Per-project override** — `<project>/.pi/ctx-handoff.json`. Any field you set overrides the global file; fields you omit fall through. Useful for giving one repository a beefier summarizer or a lower threshold for long agent runs:

```json
{
	"modelId": "qwen/qwen3.8-72b",
	"threshold": 80
}
```

Config is re-read on every event, so edits apply to the next compaction without restarting pi.

**Environment variables** (override both files):

| Variable | Meaning | Default |
|---|---|---|
| `PI_HANDOFF_PROVIDER` | pi provider id of the summarizer model | `lm-studio` |
| `PI_HANDOFF_MODEL` | model id within that provider | `qwen/qwen3.8-27b` |
| `PI_HANDOFF_THRESHOLD` | context usage % that triggers compaction (1–100) | `90` |
| `PI_HANDOFF_FALLBACK_PROVIDER` | fallback summarizer provider (optional) | — |
| `PI_HANDOFF_FALLBACK_MODEL` | fallback summarizer model id (optional) | — |

Pick any model you like — a small local Qwen/Gemma via LM Studio, Gemini Flash, or a cheap API model. It just needs to follow the structured-summary format reliably.

## Usage

Nothing to do — it runs itself. You'll see:

- a footer status like `ctx 74%`, turning into `ctx 92% ⚡handoff` at the threshold;
- a compaction notification when the handoff fires, then the session continues from the summary + recent tail.

Force it early with `/handoff` if you want to free context before a big task.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Handoff model … not found" | The provider/model pair isn't registered in pi. Check `models.json`, or fix `PI_HANDOFF_PROVIDER` / `PI_HANDOFF_MODEL` / the config file. Compaction falls back to pi's default in the meantime. |
| "Handoff summary was empty" | The model returned no text — often a context limit on the summarizer. Use a model with enough input context (the serialized conversation can be long). |
| "generation hit the token cap" style truncation | Increase `compaction.reserveTokens` in `settings.json` or pick a model with a higher output limit. |
| Summary format looks off | Your model ignores the format instructions; try a stronger instruct model. |

## Development

```bash
git clone https://github.com/anvarazizov/pi-ctx-handoff
cd pi-ctx-handoff
npm install
npm run typecheck
```

The repo is a standard pi package: pi discovers the extension in `extensions/` automatically. CI type-checks on every push.

## Compatibility

Built and tested against pi **1.0.x**. The extension only relies on stable extension APIs (`turn_end`, `session_before_compact`, `ctx.compact`, `ctx.modelRegistry`, `registerCommand`) plus pi's documented compaction formats.

## License

[MIT](LICENSE)
