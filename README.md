# autonomy_calibration

Shared harness for running coding agents against SWE-bench Pro and aggregating official evaluator results.

Default agents:

- Claude Code: `claude-sonnet-4-6`
- Codex: `gpt-5.5` with reasoning effort `low`

## Layout

- `src/shared/`: credentials, dataset prompts, git/workspace helpers, redaction, bounded concurrency, and artifact utilities.
- `src/harnesses/claude-code/`: Claude Code SDK adapter using `@anthropic-ai/claude-agent-sdk`.
- `src/harnesses/codex/`: Codex SDK adapter using `@openai/codex-sdk` and `@openai/codex`.
- `scripts/`: SWE-bench Pro sample download, official evaluator wrapper, pass@k summary, probes, and smoke fixtures.
- `data/`: sampled dataset rows and manifests.
- `evals/`: generated attempts, normalized predictions, evaluator logs, and metrics.
- `vendor/`: official SWE-bench Pro evaluator checkout from `scaleapi/SWE-bench_Pro-os`.

Each attempt emits `attempt.json`, `prompt.md`, `trajectory.jsonl`, `patch.diff`, and `prediction.json` under:

```text
evals/<run_id>/trajectories/<harness>/<instance_id>/attempt-<i>/
```

`trajectory.jsonl` is the manual inspection record for the attempt. It captures attempt metadata, checkout commands, SDK-visible messages/events, tool calls/results as exposed by the SDK, SDK errors, the final submission record, and patch/prediction paths. Private hidden model chain-of-thought is not available unless the SDK emits reasoning summaries, but all SDK-visible thinking summaries, decisions, commands, submissions, and errors are preserved verbatim in JSONL.

If an interrupted or stale attempt directory already exists, a fresh non-skipped attempt archives it under `evals/<run_id>/stale-attempts/` before writing a new `trajectory.jsonl`, so reruns do not append unrelated events into the active attempt record.

`predictions.json` is normalized for the official evaluator with records containing at least:

```json
{ "instance_id": "...", "patch": "diff --git ...", "prefix": "..." }
```

## Credentials

Runtime credentials stay out of files. The shared loader checks:

1. `ANTHROPIC_AUTH_TOKEN`
2. `HIL_BENCH`
3. `LITELLM_PROXY_API_KEY`
4. `LITELLM_API_KEY`
5. AWS Secrets Manager key `HIL_BENCH` inside `team/GENAIML/secret-store-key` in `us-west-2`

Recommended defaults on the devbox:

```sh
export AWS_PROFILE=production-developer
export ANTHROPIC_BASE_URL=https://litellm-proxy.ml-serving-internal.scale.com
export LITELLM_BASE_URL=https://litellm-proxy.ml-serving-internal.scale.com
```

The Node credential loader also defaults AWS secret lookup to `AWS_PROFILE=production-developer` when the variable is not already set, matching the probe defaults.

## Setup

```sh
npm install
python3 -m pip install -r requirements.txt
npm run setup-vendor
npm run download-samples
```

`setup-vendor` clones `https://github.com/scaleapi/SWE-bench_Pro-os.git` by default. Override with `SWEBENCH_PRO_REPO` if you need a fork.

## Probes

```sh
npm run probe:litellm
npm run probe:claude
npm run probe:codex
```

The Codex probe intentionally uses the LiteLLM proxy by default. Codex is configured as a named OpenAI-compatible LiteLLM provider at `/v1` with `wire_api="responses"` and `requires_openai_auth=true`. This avoids the bare `openai_base_url` path where the current proxy rejects the Responses websocket upgrade at `/responses`; the CLI can then use the HTTP Responses/SSE-compatible path instead of falling back to local Codex login.

## Generate

```sh
npm run generate -- --harness claude-code --k 1 --limit 5 --run-id claude-k1-smoke
npm run generate -- --harness codex --k 1 --limit 5 --run-id codex-k1-smoke
npm run generate -- --harness all --k 1 --limit 5 --run-id both-k1-smoke
npm run smoke:pass3:generate
```

Generation concurrency defaults to the minimum of total jobs, `HARNESS_MAX_CONCURRENCY` (default `8`), `floor(cpu_count / 24)`, and a memory budget using `HARNESS_GENERATE_WORKER_MEMORY_GB` (default `12`). Override explicitly with `--concurrency` or `HARNESS_CONCURRENCY`. For smoke tests against flaky or incompatible SDK endpoints, bound attempts with `--attempt-timeout-ms` or `HARNESS_ATTEMPT_TIMEOUT_MS`; timed-out attempts and setup failures still write the standard prediction/artifact contract with `sdk_error`.

Claude Code defaults to `claude-sonnet-4-6`. Codex defaults to `gpt-5.5` with reasoning effort `low`; override with `--model` and `--model-reasoning-effort`. `--max-turns` is enforced by Claude Code. The current Codex TypeScript SDK does not expose a max-turn limiter, so Codex attempts should be bounded with `--attempt-timeout-ms` for smoke tests and scheduler control.

By default `repo` is a symlink to an isolated `/tmp` checkout, which avoids expensive EFS copies while preserving the documented attempt path. Set `HARNESS_WORKSPACE_PLACEMENT=copy` if a physical checkout under `evals/` is required.

## Evaluate And Summarize

```sh
python3 scripts/evaluate_official.py --run-id claude-k1-smoke
python3 scripts/summarize_passk.py --run-id claude-k1-smoke --k 1
npm run smoke:pass3:evaluate
npm run smoke:pass3:summarize
```

The evaluator worker count defaults to `min(8, floor(cpu_count / 32))`; override with `--num-workers` or `SWEBENCH_EVAL_WORKERS`. Evaluation removes exact per-prefix evaluator artifacts and forces the official evaluator's `--redo` flag by default so reusing a `RUN_ID` cannot silently reuse stale per-attempt outputs; pass `--reuse-existing` only when you intentionally want cached evaluator artifacts. The summarizer reports observed top-k pass rate and the standard unbiased pass@k estimator `1 - C(n-c, k) / C(n, k)` when `n >= k`. Runs generated with `--harness all` are summarized per harness so Claude Code and Codex attempts for the same instance are not mixed. For multi-attempt runs, the wrapper uses per-attempt official output/log artifacts instead of the evaluator's top-level `eval_results.json`, which is keyed only by `instance_id`; it also rejects stale evaluator outputs older than `predictions.json` or the latest evaluator command and strips ANSI/xdist terminal artifacts before comparing required SWE-bench test names.

## Pass@3 Smoke

The canonical one-problem, three-attempt-per-agent smoke is:

```sh
npm run smoke:pass3:generate
npm run smoke:pass3:evaluate
npm run smoke:pass3:summarize
```

This creates six attempts total under `evals/both-pass3-smoke/` by default: three Claude Code attempts and three Codex attempts for the first sampled SWE-bench Pro instance. Set `RUN_ID=<name>` to write a different smoke run. The generated `metrics.json` and `summary.md` report pass@3 separately for `claude-code` and `codex`; missing evaluator outputs are counted as failed attempts and listed explicitly.
