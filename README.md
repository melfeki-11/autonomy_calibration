# autonomy_calibration

Harness for evaluating coding-agent SDKs on SWE-bench Pro tasks with official evaluator results and pass@k aggregation.

The repo currently compares:

- Claude Code via `@anthropic-ai/claude-agent-sdk`, default model `claude-sonnet-4-6`
- Codex via `@openai/codex-sdk`, default model `gpt-5.5` with reasoning effort `low`

Both harnesses use LiteLLM credentials from `HIL_BENCH` or the shared AWS secret fallback. The primary output is a per-harness pass@k summary over official SWE-bench Pro evaluation artifacts, plus full per-attempt trajectories for inspection.

## Quick Run

After setup, this single command runs generation, official evaluation, and pass@k summarization:

```sh
npm run passk -- --limit 1 --k 3 --harness all
```

It prints the available local data size, selected data size, pass@k value, harnesses, models, and final pass@k numbers. Defaults are:

- `--limit 1`
- `--k 3`
- `--harness all`
- `--claude-model claude-sonnet-4-6`
- `--codex-model gpt-5.5`
- `--codex-reasoning-effort low`
- `--attempt-timeout-ms 900000`

Useful variants:

```sh
npm run passk -- --limit 5 --k 3 --harness claude-code --run-id claude-k3-n5
npm run passk -- --limit 5 --k 3 --harness codex --run-id codex-k3-n5
npm run passk -- --limit 10 --k 5 --harness all --run-id both-k5-n10
npm run passk -- --limit 3 --k 3 --harness all --claude-model claude-sonnet-4-6 --codex-model gpt-5.5 --codex-reasoning-effort low
```

To run the full public SWE-bench Pro test split, first download all 731 public rows, then launch pass@3:

```sh
npm run download-samples -- --limit 731
npm run passk -- --limit 731 --k 3 --harness all
```

The runner refuses to start if `--limit` is larger than the number of rows in the local JSONL, so a full-set command cannot silently run only the smaller default sample.

`npm run passk` writes artifacts under `evals/<run_id>/`, then prints `summary.md`. The generated `metrics.json` contains the machine-readable observed pass@k and unbiased pass@k values. `summary.md` includes per-task success/failure and attempt status, and its final lines are a compact `Final Results` block with pass@k for each harness so `tail evals/<run_id>/summary.md` shows the headline numbers.

## Setup

```sh
npm install
python3 -m pip install -r requirements.txt
npm run setup-vendor
npm run download-samples
```

`setup-vendor` clones `https://github.com/scaleapi/SWE-bench_Pro-os.git` into `vendor/SWE-bench_Pro-os`. Override with `SWEBENCH_PRO_REPO` if you need a fork.

`download-samples` defaults to `--limit 5` across matching rows. Use `npm run download-samples -- --limit 731` for the public SWE-bench Pro test split, or add `--repo <owner/name>` to focus on a repository. Add `--single-repo` only when you intentionally want a low-friction sample from one repository.

It creates:

- `data/swebench_pro_samples.jsonl` for generation
- `data/swebench_pro_samples.csv` for the official evaluator
- `data/sample_manifest.json` describing the deterministic sample

## Credentials

Runtime credentials stay out of files. The shared loader checks:

1. `ANTHROPIC_AUTH_TOKEN`
2. `HIL_BENCH`
3. `LITELLM_PROXY_API_KEY`
4. `LITELLM_API_KEY`
5. AWS Secrets Manager key `HIL_BENCH` inside `team/GENAIML/secret-store-key` in `us-west-2`

Recommended devbox defaults:

```sh
export AWS_PROFILE=production-developer
export ANTHROPIC_BASE_URL=https://litellm-proxy.ml-serving-internal.scale.com
export LITELLM_BASE_URL=https://litellm-proxy.ml-serving-internal.scale.com
```

The Node credential loader defaults AWS secret lookup to `AWS_PROFILE=production-developer` when the variable is unset.

## Repository Layout

- `src/cli/generate.mjs`: normalized prediction generation CLI.
- `src/harnesses/claude-code/`: Claude Code SDK adapter.
- `src/harnesses/codex/`: Codex SDK adapter.
- `src/shared/`: credentials, dataset prompts, git/workspace helpers, redaction, bounded concurrency, and artifact utilities.
- `scripts/run_passk.mjs`: one-command generate/evaluate/summarize runner.
- `scripts/evaluate_official.py`: wrapper around the official SWE-bench Pro evaluator.
- `scripts/summarize_passk.py` and `scripts/passk.py`: per-attempt result parsing and pass@k aggregation.
- `scripts/download_samples.py`: deterministic SWE-bench Pro sample downloader.
- `scripts/setup_vendor.py`: official evaluator checkout setup.
- `scripts/probe_*.mjs` and `test_litellm.py`: LiteLLM, Claude Code, and Codex connectivity probes.
- `tests/`: unit tests for concurrency and pass@k/evaluator parsing.
- `data/`: sampled dataset rows and manifests.
- `evals/`: generated attempts, normalized predictions, evaluator logs, summaries, and metrics.
- `vendor/`: official SWE-bench Pro evaluator checkout.

## Agent Harnesses

Claude Code uses the Anthropic SDK with the LiteLLM token exposed as `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`. It enforces the attempt workspace boundary through the SDK permission hook.

Codex uses the Codex SDK with a named OpenAI-compatible LiteLLM provider at `/v1`:

```text
model_provider = litellm
wire_api = responses
requires_openai_auth = true
```

This keeps Codex on the LiteLLM Responses/Codex protocol path and avoids falling back to local Codex login.

Probe the endpoints directly with:

```sh
npm run probe:litellm
npm run probe:claude
npm run probe:codex
```

## Artifacts

Each attempt emits:

```text
evals/<run_id>/trajectories/<harness>/<instance_id>/attempt-<i>/
  attempt.json
  prompt.md
  trajectory.jsonl
  patch.diff
  prediction.json
```

`trajectory.jsonl` is the manual inspection record. It captures attempt metadata, checkout commands, SDK-visible messages/events, tool calls/results as exposed by the SDK, SDK errors, final submission metadata, and patch/prediction paths. Private hidden model chain-of-thought is not available unless an SDK emits reasoning summaries, but all SDK-visible reasoning summaries, decisions, commands, submissions, and errors are preserved verbatim in JSONL.

If a stale attempt directory already exists, a fresh non-resume run archives it under `evals/<run_id>/stale-attempts/` before writing a new trajectory.

`predictions.json` is normalized for the official evaluator:

```json
{ "instance_id": "...", "patch": "diff --git ...", "prefix": "...", "harness": "...", "attempt_index": 1 }
```

## Pass@k Correctness

The summarizer reports:

- observed top-k pass rate: whether any of the first `k` attempts for an instance passed
- standard unbiased pass@k estimator: `1 - C(n-c, k) / C(n, k)` when `n >= k`
- per-task success/failure with attempt-level statuses
- a final tail block with pass@k and unbiased pass@k per harness

Runs generated with `--harness all` are summarized per harness, so Claude Code and Codex attempts for the same instance are never mixed. Multi-attempt runs use per-prefix official evaluator artifacts instead of the evaluator's top-level `eval_results.json`, because that file is keyed only by `instance_id`. Stale evaluator outputs older than `predictions.json` or the latest evaluator command are rejected.

Generation failures and SDK timeouts are included as failed attempts with empty patches and `sdk_error` populated, so pass@k denominators stay correct.

## Concurrency

Generation uses a bounded worker pool. Default concurrency is the minimum of:

- total jobs
- `HARNESS_MAX_CONCURRENCY`, default `8`
- `floor(cpu_count / 24)`
- available memory divided by `HARNESS_GENERATE_WORKER_MEMORY_GB`, default `12`

Override with `--concurrency` on `npm run passk` or `npm run generate`, or set `HARNESS_CONCURRENCY`.

Official evaluation defaults to `min(8, floor(cpu_count / 32))` workers. Override with `--eval-workers` on `npm run passk`, `--num-workers` on `scripts/evaluate_official.py`, or `SWEBENCH_EVAL_WORKERS`.

By default `repo` inside each attempt is a symlink to an isolated `/tmp` checkout, avoiding expensive EFS copies while preserving the documented attempt path. Set `HARNESS_WORKSPACE_PLACEMENT=copy` if a physical checkout under `evals/` is required.

## Lower-Level Commands

The one-command runner is preferred for normal use, but the phases can be run independently:

```sh
npm run generate -- --harness all --k 3 --limit 1 --run-id both-pass3-smoke
python3 scripts/evaluate_official.py --run-id both-pass3-smoke
python3 scripts/summarize_passk.py --run-id both-pass3-smoke --k 3
```

Evaluation removes exact per-prefix evaluator artifacts and forces the official evaluator's `--redo` flag by default, so reusing a `RUN_ID` cannot silently reuse stale per-attempt outputs. Use `--reuse-existing` or `--reuse-existing-eval` only when you intentionally want cached evaluator artifacts.

The compatibility smoke scripts are aliases around the same flow:

```sh
npm run smoke:pass3:generate
npm run smoke:pass3:evaluate
npm run smoke:pass3:summarize
```

## Tests

```sh
npm test
```

The test suite covers bounded generation concurrency, pass@k formulas, per-harness aggregation, stale evaluator output rejection, ambiguous instance-keyed fallback protection, large SWE-bench CSV fields, xdist/ANSI evaluator log parsing, and summary tail rendering.
