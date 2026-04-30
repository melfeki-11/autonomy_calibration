#!/usr/bin/env node
import path from "node:path";
import { DEFAULT_CODEX_REASONING_EFFORT, dataDir, defaultGenerateConcurrency, evalsDir } from "../shared/config.mjs";
import { loadSamples } from "../shared/dataset.mjs";
import { appendJsonl, ensureDir, writeJsonAtomic, writeText } from "../shared/io.mjs";
import { collectRunPredictions, comparePredictions } from "../shared/predictions.mjs";
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
    modelReasoningEffort: process.env.CODEX_MODEL_REASONING_EFFORT || DEFAULT_CODEX_REASONING_EFFORT,
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
    else if (arg === "--model-reasoning-effort") args.modelReasoningEffort = argv[++i];
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

function predictionKey(prediction) {
  return `${prediction.harness || ""}\0${prediction.instance_id || ""}\0${prediction.attempt_index || 0}`;
}

function predictionPrefix(args, harnessName, instanceId, attemptIndex) {
  return `${args.runId}__${harnessName}__${instanceId}__attempt-${attemptIndex}`;
}

async function writeFailurePrediction({ job, args, runDir, error }) {
  const instanceId = job.row.instance_id;
  const attemptDir = path.join(runDir, "trajectories", job.harness.name, instanceId, `attempt-${job.attemptIndex}`);
  const trajectoryFile = path.join(attemptDir, "trajectory.jsonl");
  const prefix = predictionPrefix(args, job.harness.name, instanceId, job.attemptIndex);
  const errorText = String(error?.stack || error);
  const prediction = {
    instance_id: instanceId,
    patch: "",
    prefix,
    harness: job.harness.name,
    attempt_index: job.attemptIndex,
    run_id: args.runId,
    sdk_error: errorText,
    generation_failed: true,
  };
  await ensureDir(attemptDir);
  await appendJsonl(trajectoryFile, { type: "attempt_error", timestamp: new Date().toISOString(), error: errorText });
  await writeText(path.join(attemptDir, "patch.diff"), "");
  await writeJsonAtomic(path.join(attemptDir, "prediction.json"), prediction);
  await appendJsonl(trajectoryFile, {
    type: "submission",
    timestamp: new Date().toISOString(),
    prediction_path: path.join(attemptDir, "prediction.json"),
    patch_path: path.join(attemptDir, "patch.diff"),
    prefix,
    patch_bytes: 0,
    sdk_error: errorText,
    generation_failed: true,
  });
  await appendJsonl(trajectoryFile, { type: "attempt_end", timestamp: new Date().toISOString(), patch_bytes: 0, sdk_error: errorText, generation_failed: true });
  return prediction;
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
const completedByKey = new Map();
let progressWrite = Promise.resolve();
console.log(`Starting ${jobs.length} attempts across ${selectedHarnesses.map((h) => h.name).join(", ")} with concurrency=${concurrency}`);

function completedPredictions() {
  return [...completedByKey.values()].sort(comparePredictions);
}

function queueProgressWrite() {
  progressWrite = progressWrite.then(async () => {
    const predictions = completedPredictions();
    await writeJsonAtomic(path.join(runDir, "predictions.json"), predictions);
    await writeJsonAtomic(path.join(runDir, "generation-progress.json"), {
      run_id: args.runId,
      harness: args.harness,
      total_jobs: jobs.length,
      completed_predictions: predictions.length,
      failed_jobs: failures.length,
      concurrency,
      attempt_timeout_ms: args.attemptTimeoutMs,
      model_reasoning_effort: args.modelReasoningEffort,
      failures,
    });
  });
  return progressWrite;
}

await runBounded(jobs, concurrency, async (job, _jobIndex, workerId) => {
  const model = args.model || job.harness.defaultModel;
  const jobArgs = { ...args, model };
  console.log(`[worker ${workerId}] ${job.harness.name} ${job.row.instance_id} attempt ${job.attemptIndex}/${args.k}`);
  try {
    const prediction = await job.harness.runAttempt({ row: job.row, attemptIndex: job.attemptIndex, args: jobArgs, runDir });
    if (prediction) completedByKey.set(predictionKey(prediction), prediction);
  } catch (error) {
    const failure = { harness: job.harness.name, instance_id: job.row.instance_id, attempt_index: job.attemptIndex, error: String(error?.stack || error) };
    failures.push(failure);
    console.error(`[worker ${workerId}] failed ${failure.harness} ${failure.instance_id} attempt ${failure.attempt_index}: ${failure.error}`);
    const prediction = await writeFailurePrediction({ job, args: jobArgs, runDir, error });
    completedByKey.set(predictionKey(prediction), prediction);
  }
  await queueProgressWrite();
});

await progressWrite;
const predictions = await collectRunPredictions(runDir);
await writeJsonAtomic(path.join(runDir, "predictions.json"), predictions);
await writeJsonAtomic(path.join(runDir, "generation-progress.json"), {
  run_id: args.runId,
  harness: args.harness,
  total_jobs: jobs.length,
  completed_predictions: predictions.length,
  failed_jobs: failures.length,
  concurrency,
  attempt_timeout_ms: args.attemptTimeoutMs,
  model_reasoning_effort: args.modelReasoningEffort,
  failures,
});
await writeJsonAtomic(path.join(runDir, "attempts-index.json"), {
  run_id: args.runId,
  harness: args.harness,
  generated_at: new Date().toISOString(),
  concurrency,
  attempt_timeout_ms: args.attemptTimeoutMs,
  model_reasoning_effort: args.modelReasoningEffort,
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
