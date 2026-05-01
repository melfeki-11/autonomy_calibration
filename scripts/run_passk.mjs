#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  dataDir,
  evalsDir,
} from "../src/shared/config.mjs";

function parseArgs(argv) {
  const args = {
    input: path.join(dataDir, "swebench_pro_samples.jsonl"),
    samples: path.join(dataDir, "swebench_pro_samples.csv"),
    harness: "all",
    runId: `passk-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    k: 3,
    limit: 1,
    claudeModel: process.env.CLAUDE_CODE_MODEL || DEFAULT_CLAUDE_MODEL,
    codexModel: process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL,
    codexReasoningEffort: process.env.CODEX_MODEL_REASONING_EFFORT || DEFAULT_CODEX_REASONING_EFFORT,
    concurrency: undefined,
    evalWorkers: undefined,
    attemptTimeoutMs: Number(process.env.HARNESS_ATTEMPT_TIMEOUT_MS || 900000),
    reuseExistingEval: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--samples") args.samples = argv[++i];
    else if (arg === "--harness") args.harness = argv[++i];
    else if (arg === "--run-id") args.runId = argv[++i];
    else if (arg === "--k") args.k = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--claude-model") args.claudeModel = argv[++i];
    else if (arg === "--codex-model") args.codexModel = argv[++i];
    else if (arg === "--codex-reasoning-effort") args.codexReasoningEffort = argv[++i];
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--eval-workers") args.evalWorkers = Number(argv[++i]);
    else if (arg === "--attempt-timeout-ms") args.attemptTimeoutMs = Number(argv[++i]);
    else if (arg === "--reuse-existing-eval") args.reuseExistingEval = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.k) || args.k < 1) throw new Error("--k must be a positive integer");
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit must be a positive integer");
  if (args.concurrency !== undefined && (!Number.isInteger(args.concurrency) || args.concurrency < 1)) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (args.evalWorkers !== undefined && (!Number.isInteger(args.evalWorkers) || args.evalWorkers < 1)) {
    throw new Error("--eval-workers must be a positive integer");
  }
  if (!Number.isInteger(args.attemptTimeoutMs) || args.attemptTimeoutMs < 0) {
    throw new Error("--attempt-timeout-ms must be a non-negative integer");
  }
  return args;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${signal || code}`));
    });
  });
}

function selectedHarnesses(harness) {
  if (harness === "all") return ["claude-code", "codex"];
  return [harness];
}

async function countJsonlRows(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).length;
}

const args = parseArgs(process.argv.slice(2));
const harnesses = selectedHarnesses(args.harness);
const runDir = path.join(evalsDir, args.runId);
const availableRows = await countJsonlRows(args.input);
if (args.limit > availableRows) {
  throw new Error(`Requested --limit ${args.limit}, but ${args.input} contains only ${availableRows} samples. Run npm run download-samples -- --limit ${args.limit} first.`);
}

console.log("SWE-bench Pro pass@k run");
console.log(`  run_id: ${args.runId}`);
console.log(`  data: ${args.input}`);
console.log(`  available_data_size: ${availableRows}`);
console.log(`  selected_data_size: ${args.limit}`);
console.log(`  k: ${args.k}`);
console.log(`  harnesses: ${harnesses.join(", ")}`);
if (harnesses.includes("claude-code")) console.log(`  claude-code model: ${args.claudeModel}`);
if (harnesses.includes("codex")) {
  console.log(`  codex model: ${args.codexModel}`);
  console.log(`  codex reasoning effort: ${args.codexReasoningEffort}`);
}
console.log(`  attempt_timeout_ms: ${args.attemptTimeoutMs}`);

const generateArgs = [
  "src/cli/generate.mjs",
  "--input",
  args.input,
  "--harness",
  args.harness,
  "--k",
  String(args.k),
  "--limit",
  String(args.limit),
  "--run-id",
  args.runId,
  "--claude-model",
  args.claudeModel,
  "--codex-model",
  args.codexModel,
  "--model-reasoning-effort",
  args.codexReasoningEffort,
  "--attempt-timeout-ms",
  String(args.attemptTimeoutMs),
];
if (args.concurrency) generateArgs.push("--concurrency", String(args.concurrency));

const evaluateArgs = ["scripts/evaluate_official.py", "--run-id", args.runId, "--samples", args.samples];
if (args.evalWorkers) evaluateArgs.push("--num-workers", String(args.evalWorkers));
if (args.reuseExistingEval) evaluateArgs.push("--reuse-existing");

await run(process.execPath, generateArgs);
await run("python3", evaluateArgs);
await run("python3", ["scripts/summarize_passk.py", "--run-id", args.runId, "--samples", args.samples, "--k", String(args.k)]);

const summaryPath = path.join(runDir, "summary.md");
const summary = await fs.readFile(summaryPath, "utf8");
console.log("");
console.log(summary.trim());
