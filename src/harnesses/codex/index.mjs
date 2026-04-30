import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { archiveExistingAttempt } from "../../shared/attempts.mjs";
import { DEFAULT_CODEX_MODEL, codexClientOptions } from "../../shared/config.mjs";
import { promptForInstance, publicMetadata } from "../../shared/dataset.mjs";
import { attemptWorkspace, cloneCheckout, diff } from "../../shared/git.mjs";
import { appendJsonl, ensureDir, pathExists, writeJson, writeJsonAtomic, writeText } from "../../shared/io.mjs";

export const harness = {
  name: "codex",
  defaultModel: DEFAULT_CODEX_MODEL,
  runAttempt,
};

function compatibilityHint(error) {
  const text = String(error?.stack || error);
  if (/404|not found|responses|unsupported|unauthorized|401|model_not_found|invalid/i.test(text)) {
    return `${text}\n\nCodex is configured to use the LiteLLM proxy by default. If this fails before tool execution, verify that the proxy supports the OpenAI Responses API/Codex protocol for the selected model. The harness intentionally does not fall back to local Codex login.`;
  }
  return text;
}

async function runAttempt({ row, attemptIndex, args, runDir }) {
  const instanceId = row.instance_id;
  const attemptDir = path.join(runDir, "trajectories", harness.name, instanceId, `attempt-${attemptIndex}`);
  const trajectoryFile = path.join(attemptDir, "trajectory.jsonl");
  const workspaceDir = attemptWorkspace(attemptDir);
  const predictionPrefix = `${args.runId}__${harness.name}__${instanceId}__attempt-${attemptIndex}`;
  const predictionPath = path.join(attemptDir, "prediction.json");

  if (args.resume && (await pathExists(predictionPath))) {
    const fs = await import("node:fs/promises");
    const prediction = JSON.parse(await fs.readFile(predictionPath, "utf8"));
    await appendJsonl(trajectoryFile, { type: "attempt_resume_skip", timestamp: new Date().toISOString(), prediction_path: predictionPath });
    return prediction;
  }

  const archivedTo = await archiveExistingAttempt({ runDir, attemptDir, harnessName: harness.name, instanceId, attemptIndex });
  await ensureDir(attemptDir);
  if (archivedTo) {
    await appendJsonl(trajectoryFile, {
      type: "attempt_archive_previous",
      timestamp: new Date().toISOString(),
      archived_to: archivedTo,
      reason: args.resume ? "resume_incomplete_attempt" : "fresh_rerun",
    });
  }
  const prompt = `${promptForInstance(row)}\nUse the available shell/editing tools to make the fix. Do not ask for approval; work only inside this checkout.`;
  await writeText(path.join(attemptDir, "prompt.md"), prompt);
  await writeJson(path.join(attemptDir, "attempt.json"), {
    run_id: args.runId,
    harness: harness.name,
    instance_id: instanceId,
    attempt_index: attemptIndex,
    prefix: predictionPrefix,
    model: args.model,
    model_reasoning_effort: args.modelReasoningEffort,
    max_turns: args.maxTurns,
    max_turns_enforced: false,
    attempt_timeout_ms: args.attemptTimeoutMs,
    metadata_shown_to_agent: publicMetadata(row),
    started_at: new Date().toISOString(),
  });
  await appendJsonl(trajectoryFile, { type: "attempt_start", timestamp: new Date().toISOString(), instance_id: instanceId, attempt_index: attemptIndex, prompt });

  await cloneCheckout({ row, workspaceDir, trajectoryFile });

  let sdkError = null;
  const attemptTimeoutMs = Number(args.attemptTimeoutMs || 0);
  const abortController = attemptTimeoutMs > 0 ? new AbortController() : null;
  const timeoutId = abortController
    ? setTimeout(() => abortController.abort(new Error(`Codex attempt timed out after ${attemptTimeoutMs}ms`)), attemptTimeoutMs)
    : null;
  try {
    const codexHome = path.join(attemptDir, ".codex-home");
    const attemptHome = path.join(attemptDir, ".home");
    const ansibleLocalTemp = path.join(attemptDir, ".ansible-tmp");
    await ensureDir(codexHome);
    await ensureDir(attemptHome);
    await ensureDir(ansibleLocalTemp);
    const options = await codexClientOptions({ CODEX_HOME: codexHome, HOME: attemptHome, ANSIBLE_LOCAL_TEMP: ansibleLocalTemp });
    const codex = new Codex(options);
    const thread = codex.startThread({
      workingDirectory: workspaceDir,
      skipGitRepoCheck: false,
      model: args.model,
      modelReasoningEffort: args.modelReasoningEffort,
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      approvalPolicy: "never",
    });
    const turnOptions = {};
    if (abortController) turnOptions.signal = abortController.signal;
    const { events } = await thread.runStreamed(prompt, turnOptions);
    for await (const event of events) {
      await appendJsonl(trajectoryFile, { type: "sdk_event", timestamp: new Date().toISOString(), event });
    }
  } catch (error) {
    const hint = compatibilityHint(error);
    sdkError = abortController?.signal.aborted ? `Codex attempt timed out after ${attemptTimeoutMs}ms.\n\n${hint}` : hint;
    await appendJsonl(trajectoryFile, { type: "sdk_error", timestamp: new Date().toISOString(), error: sdkError });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const patch = await diff(workspaceDir, trajectoryFile);
  await writeText(path.join(attemptDir, "patch.diff"), patch);
  const prediction = { instance_id: instanceId, patch, prefix: predictionPrefix, harness: harness.name, attempt_index: attemptIndex, run_id: args.runId, sdk_error: sdkError };
  await writeJsonAtomic(predictionPath, prediction);
  await appendJsonl(trajectoryFile, {
    type: "submission",
    timestamp: new Date().toISOString(),
    prediction_path: predictionPath,
    patch_path: path.join(attemptDir, "patch.diff"),
    prefix: predictionPrefix,
    patch_bytes: Buffer.byteLength(patch),
    sdk_error: sdkError,
  });
  await appendJsonl(trajectoryFile, { type: "attempt_end", timestamp: new Date().toISOString(), patch_bytes: Buffer.byteLength(patch), sdk_error: sdkError });
  return prediction;
}
