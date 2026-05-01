# Autonomy Substrate Milestone

This repo currently keeps the existing SWE-bench Pro pass@k flow intact while adding an opt-in human-interaction substrate for underspecified tasks.

## Current Architecture

- `scripts/run_passk.mjs` runs generation, official SWE-bench Pro evaluation, and `scripts/summarize_passk.py`.
- `scripts/passk.py` implements observed and unbiased pass@k aggregation.
- `src/cli/generate.mjs` builds per-harness, per-attempt jobs and writes normalized predictions.
- `src/harnesses/claude-code/index.mjs` runs Claude Code through `@anthropic-ai/claude-agent-sdk`.
- `src/harnesses/codex/index.mjs` runs Codex through `@openai/codex-sdk` exec mode by default, or the experimental Codex app-server transport for clarification-aware runs.
- `src/shared/human_input.mjs` owns deterministic `ask_human`, approval routing, registry loading, cache/replay, and human-facing event logs.
- `src/shared/io.mjs` preserves the legacy JSONL event payloads and enriches trajectory JSONL records with normalized trace fields.
- `scripts/process_metrics.py` computes deterministic process metrics from saved traces without rerunning agents or calling an LLM.

## Human-Facing SDK Paths

Claude Code:

- `canUseTool` is captured as an approval/permission path.
- `onElicitation` is captured as elicitation and routed through `ask_human`.
- The built-in `AskUserQuestion` tool is intercepted through `canUseTool` when emitted and routed through `ask_human`.
- A harness-provided always-loaded MCP tool, `human_input.ask_human`, is exposed for clarification. This is the reliable clarification path because normal user dialogs are not otherwise a direct SDK callback.

Codex:

- Exec transport is preserved for non-interactive pass@k runs and does not support clarification callbacks.
- App-server transport is used for clarification-aware runs.
- App-server requests captured now include `item/tool/requestUserInput`, `mcpServer/elicitation/request`, command/file/permissions approval requests, and legacy exec/apply-patch approval requests.
- Unknown app-server requests are logged as raw SDK requests and receive an empty response instead of being silently erased.

## Registry And Determinism

`ask_human` is a registry selector, not a truth generator. It sends only sorted candidate descriptions/trigger questions to `bedrock/qwen.qwen3-32b-v1:0` via the existing LiteLLM config path by default, asks for strict JSON containing one `blocker_id`, validates that ID against the registry, and returns the stored resolution verbatim. Unknown, invalid, provider failure, replay-cache miss, unsupported request types, or registry-exfiltration requests return exactly `I don't know`.

Approval/permission events do not call `ask_human`. They first check explicit approval registry entries, then use a conservative deterministic fallback that allows safe workspace-bounded reads/searches/tests/file edits and denies outside-workspace, network/secrets, destructive, publishing, or ambiguous actions.

## Smoke Fixtures

`scripts/prepare_clarification_smoke.mjs` creates a tiny local SWE-bench-Pro-format fixture whose public issue omits a product convention. `data/clarification_smoke_kb.json` contains the missing convention. Live Claude/Codex plumbing is exercised through `npm run smoke:clarification:generate` followed by `npm run smoke:clarification:verify`.

Latest local validation on May 1, 2026: `npm test` passed, `bedrock/qwen.qwen3-32b-v1:0` returned `PONG` through LiteLLM, a live `ask_human` call selected `prefix-format-convention` with the exact registry resolution and replayed from cache, and the full Claude/Codex smoke run `clarification-smoke-bedrock-live` passed verification. Both harnesses asked a clarification, `ask_human` answered from the registry, both patches passed hidden tests, ASK-F1 was `1.0000`, blocker recall was `1.0000`, and trace completeness checks were all true.

## Readiness Bar

- `npm test` must pass.
- `LITELLM_MODEL=bedrock/qwen.qwen3-32b-v1:0 npm run probe:litellm` must succeed through the configured LiteLLM path.
- `npm run smoke:clarification:generate` and `npm run smoke:clarification:verify` must produce real Claude Code and Codex trajectories, live selector decisions, final patches/submissions, hidden-test results, `process_metrics.json`, and `process_summary.md`.
- Replay/cache-only runs and mocked unit tests do not count as acceptance evidence.

## Remaining Gaps

- The LLM-as-judge failure taxonomy is intentionally not implemented yet.
- Codex app-server protocol coverage is based on the installed CLI/app-server methods and should be re-audited when the package is upgraded.
- Claude Code native user-dialog interception is best-effort through `AskUserQuestion` tool detection plus the harness MCP tool; unsupported future user-input paths should be added as explicit normalized event handlers.
- More realistic HiL-Bench-style task registries should be added after this substrate is exercised on a small number of fixtures.

## Next Stages

- Add more HiL-Bench-style underspecified tasks.
- Expand the registry beyond blocker entries into explicit decision-point entries.
- Add more harness adapters without changing the normalized trace schema.
- Build an LLM-as-judge failure taxonomy over saved trajectories.
- Calibrate task difficulty without tuning tasks until agents ask; no-ask remains a measured failure.
