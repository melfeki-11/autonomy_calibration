import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const rootDir = path.resolve(new URL("../..", import.meta.url).pathname);
export const dataDir = path.join(rootDir, "data");
export const evalsDir = path.join(rootDir, "evals");
export const vendorDir = path.join(rootDir, "vendor", "SWE-bench_Pro-os");

export const DEFAULT_BASE_URL = "https://litellm-proxy.ml-serving-internal.scale.com";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT = "low";
export const DEFAULT_ASK_HUMAN_MODEL = "bedrock/qwen.qwen3-32b-v1:0";
export const DEFAULT_ASK_HUMAN_SEED = 20260501;
export const AWS_SECRET_ID = "team/GENAIML/secret-store-key";
export const AWS_REGION = "us-west-2";
export const DEFAULT_AWS_PROFILE = "production-developer";
export const CODEX_LITELLM_PROVIDER = "litellm";

export function cpuCount() {
  return os.availableParallelism?.() || os.cpus()?.length || 1;
}

export function defaultGenerateConcurrency(totalJobs) {
  if (totalJobs <= 0) return 0;
  const fromEnv = Number(process.env.HARNESS_CONCURRENCY || "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) return Math.min(totalJobs, fromEnv);
  const maxConcurrency = Number(process.env.HARNESS_MAX_CONCURRENCY || 8);
  const cap = Number.isInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 8;
  const workerMemoryGb = Number(process.env.HARNESS_GENERATE_WORKER_MEMORY_GB || 12);
  const memoryBased =
    Number.isFinite(workerMemoryGb) && workerMemoryGb > 0
      ? Math.max(1, Math.floor(os.totalmem() / (workerMemoryGb * 1024 ** 3)))
      : Number.POSITIVE_INFINITY;
  return Math.min(totalJobs, cap, Math.max(1, Math.floor(cpuCount() / 24)), memoryBased);
}

export function defaultEvalWorkers() {
  const fromEnv = Number(process.env.SWEBENCH_EVAL_WORKERS || "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.min(8, Math.max(1, Math.floor(cpuCount() / 32)));
}

export function getBaseUrl() {
  return process.env.LITELLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
}

export function getResponsesBaseUrl() {
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

async function readAwsSecretKey(secretKeyName) {
  const args = [
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    AWS_SECRET_ID,
    "--region",
    process.env.AWS_REGION || AWS_REGION,
    "--query",
    "SecretString",
    "--output",
    "text",
  ];
  args.splice(0, 0, "--profile", process.env.AWS_PROFILE || DEFAULT_AWS_PROFILE);
  const { stdout } = await execFileAsync("aws", args, { maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return parsed[secretKeyName];
}

export async function getLiteLLMKey() {
  const envKey =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.HIL_BENCH ||
    process.env.LITELLM_PROXY_API_KEY ||
    process.env.LITELLM_API_KEY;
  if (envKey) return envKey;
  const key = await readAwsSecretKey("HIL_BENCH");
  if (!key) {
    throw new Error(
      "Could not find LiteLLM key in ANTHROPIC_AUTH_TOKEN, HIL_BENCH, LITELLM_PROXY_API_KEY, LITELLM_API_KEY, or AWS Secrets Manager. Set AWS_PROFILE=production-developer if needed."
    );
  }
  return key;
}

export async function claudeEnv(extra = {}) {
  const token = await getLiteLLMKey();
  const baseUrl = getBaseUrl();
  return {
    ...process.env,
    ...extra,
    AWS_PROFILE: process.env.AWS_PROFILE || DEFAULT_AWS_PROFILE,
    HIL_BENCH: token,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: baseUrl,
    LITELLM_BASE_URL: baseUrl,
  };
}

export async function codexClientOptions(extraEnv = {}) {
  const token = await getLiteLLMKey();
  const baseUrl = getBaseUrl();
  const responsesBaseUrl = getResponsesBaseUrl();
  return {
    apiKey: token,
    env: {
      ...process.env,
      ...extraEnv,
      AWS_PROFILE: process.env.AWS_PROFILE || DEFAULT_AWS_PROFILE,
      HIL_BENCH: token,
      CODEX_API_KEY: token,
      OPENAI_API_KEY: token,
      LITELLM_BASE_URL: baseUrl,
      CODEX_LITELLM_BASE_URL: responsesBaseUrl,
    },
    config: {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: true },
      model_provider: CODEX_LITELLM_PROVIDER,
      model_providers: {
        [CODEX_LITELLM_PROVIDER]: {
          name: "LiteLLM",
          base_url: responsesBaseUrl,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
          requires_openai_auth: true,
        },
      },
    },
  };
}
