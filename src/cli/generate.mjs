#!/usr/bin/env node
import path from "node:path";
import { dataDir, defaultGenerateConcurrency, evalsDir } from "../shared/config.mjs";
import { loadSamples } from "../shared/dataset.mjs";
import { ensureDir, writeJson } from "../shared/io.mjs";
import { collectRunPredictions } from "../shared/predictions.mjs";
import { runBounded } from "../shared/worker_pool.mjs";
import { resolveHarnesses } from "../harnesses/index.mjs";

function parseArgs(argv) {
  const args = {
    input: path.join(dataDir, "swebench_pro_samples.jsonl"),
    harness: "claude-code",
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    k: 1,
    limit: undefined,
    model: undefined,
    maxTurns: 40,
    permissionMode: "acceptEdits",
    concurrency: undefined,
    attemptTimeoutMs: Number(process.env.HARNESS_ATTEMPT_TIMEOUT_MS || 0),
    resume: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--harness") args.harness = argv[++i];
    else if (arg === "--run-id") args.runId = argv[++i];
    else if (arg === "--k") args.k = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (arg === "--permission-mode") args.permissionMode = argv[++i];
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--attempt-timeout-ms") args.attemptTimeoutMs = Number(argv[++i]);
    else if (arg === "--resume") args.resume = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.k) || args.k < 1) throw new Error("--k must be a positive integer");
  if (args.concurrency !== undefined && (!Number.isInteger(args.concurrency) || args.concurrency < 1)) throw new Error("--concurrency must be a positive integer");
  if (!Number.isInteger(args.attemptTimeoutMs) || args.attemptTimeoutMs < 0) throw new Error("--attempt-timeout-ms must be a non-negative integer");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const selectedHarnesses = resolveHarnesses(args.harness);
const allSamples = await loadSamples(args.input);
const samples = args.limit ? allSamples.slice(0, args.limit) : allSamples;
const runDir = path.join(evalsDir, args.runId);
await ensureDir(runDir);

const jobs = [];
for (const harness of selectedHarnesses) {
  for (const [sampleIndex, row] of samples.entries()) {
    for (let attemptIndex = 1; attemptIndex <= args.k; attemptIndex += 1) {
      jobs.push({ harness, row, sampleIndex, attemptIndex });
    }
  }
}

const concurrency = args.concurrency || defaultGenerateConcurrency(jobs.length);
const failures = [];
console.log(`Starting ${jobs.length} attempts across ${selectedHarnesses.map((h) => h.name).join(", ")} with concurrency=${concurrency}`);

await runBounded(jobs, concurrency, async (job, _jobIndex, workerId) => {
  const model = args.model || job.harness.defaultModel;
  const jobArgs = { ...args, model };
  console.log(`[worker ${workerId}] ${job.harness.name} ${job.row.instance_id} attempt ${job.attemptIndex}/${args.k}`);
  try {
    await job.harness.runAttempt({ row: job.row, attemptIndex: job.attemptIndex, args: jobArgs, runDir });
  } catch (error) {
    const failure = { harness: job.harness.name, instance_id: job.row.instance_id, attempt_index: job.attemptIndex, error: String(error?.stack || error) };
    failures.push(failure);
    console.error(`[worker ${workerId}] failed ${failure.harness} ${failure.instance_id} attempt ${failure.attempt_index}: ${failure.error}`);
  }
  const completedPredictions = await collectRunPredictions(runDir);
  await writeJson(path.join(runDir, "predictions.json"), completedPredictions);
  await writeJson(path.join(runDir, "generation-progress.json"), {
    run_id: args.runId,
    harness: args.harness,
    total_jobs: jobs.length,
    completed_predictions: completedPredictions.length,
    failed_jobs: failures.length,
    concurrency,
    attempt_timeout_ms: args.attemptTimeoutMs,
    failures,
  });
});

const predictions = await collectRunPredictions(runDir);
await writeJson(path.join(runDir, "predictions.json"), predictions);
await writeJson(path.join(runDir, "attempts-index.json"), {
  run_id: args.runId,
  harness: args.harness,
  generated_at: new Date().toISOString(),
  concurrency,
  attempt_timeout_ms: args.attemptTimeoutMs,
  failed_jobs: failures,
  predictions: predictions.map((prediction) => ({
    harness: prediction.harness,
    instance_id: prediction.instance_id,
    prefix: prediction.prefix,
    attempt_index: prediction.attempt_index,
    patch_bytes: Buffer.byteLength(prediction.patch || ""),
    sdk_error: prediction.sdk_error,
  })),
});
console.log(`Wrote ${predictions.length} predictions to ${path.join(runDir, "predictions.json")}`);
