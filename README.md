# autonomy_calibration

Shared harness for running coding agents against SWE-bench Pro and aggregating official evaluator results.

## Layout

- `src/shared/`: credentials, dataset prompts, git/workspace helpers, redaction, bounded concurrency, and artifact utilities.
- `src/harnesses/claude-code/`: Claude Code SDK adapter using `@anthropic-ai/claude-agent-sdk`.
- `src/harnesses/codex/`: Codex SDK adapter using `@openai/codex-sdk` and `@openai/codex`.
- `scripts/`: SWE-bench Pro sample download, official evaluator wrapper, pass@k summary, probes, and smoke fixtures.
- `data/`: sampled dataset rows and manifests.
- `evals/`: generated attempts, normalized predictions, evaluator logs, and metrics.
- `vendor/`: official SWE-bench Pro evaluator checkout.

Each attempt emits `attempt.json`, `prompt.md`, `trajectory.jsonl`, `patch.diff`, and `prediction.json` under:

```text
evals/<run_id>/trajectories/<harness>/<instance_id>/attempt-<i>/
```

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

## Setup

```sh
npm install
python3 -m pip install -r requirements.txt
npm run setup-vendor
npm run download-samples
```

## Probes

```sh
npm run probe:litellm
npm run probe:claude
npm run probe:codex
```

The Codex probe intentionally uses the LiteLLM proxy by default. If the proxy does not support the Responses API used by Codex, the probe exits with a clear compatibility error and does not fall back to local Codex login.

## Generate

```sh
npm run generate -- --harness claude-code --k 1 --limit 5 --run-id claude-k1-smoke
npm run generate -- --harness codex --k 1 --limit 5 --run-id codex-k1-smoke
npm run generate -- --harness all --k 1 --limit 5 --run-id both-k1-smoke
```

Generation concurrency defaults to `min(total_jobs, 8, max(1, floor(cpu_count / 24)))`; override with `--concurrency` or `HARNESS_CONCURRENCY`. For smoke tests against flaky or incompatible SDK endpoints, bound attempts with `--attempt-timeout-ms` or `HARNESS_ATTEMPT_TIMEOUT_MS`; timed-out attempts still write the standard prediction/artifact contract with `sdk_error`.

By default `repo` is a symlink to an isolated `/tmp` checkout, which avoids expensive EFS copies while preserving the documented attempt path. Set `HARNESS_WORKSPACE_PLACEMENT=copy` if a physical checkout under `evals/` is required.

## Evaluate And Summarize

```sh
python3 scripts/evaluate_official.py --run-id claude-k1-smoke
python3 scripts/summarize_passk.py --run-id claude-k1-smoke --k 1
```

The summarizer reports observed top-k pass rate and the standard unbiased pass@k estimator `1 - C(n-c, k) / C(n, k)` when `n >= k`.
