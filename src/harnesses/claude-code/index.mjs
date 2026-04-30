import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { archiveExistingAttempt } from "../../shared/attempts.mjs";
import { DEFAULT_CLAUDE_MODEL, claudeEnv } from "../../shared/config.mjs";
import { promptForInstance, publicMetadata } from "../../shared/dataset.mjs";
import { attemptWorkspace, cloneCheckout, diff } from "../../shared/git.mjs";
import { appendJsonl, ensureDir, pathExists, writeJson, writeJsonAtomic, writeText } from "../../shared/io.mjs";

export const harness = {
  name: "claude-code",
  defaultModel: DEFAULT_CLAUDE_MODEL,
  runAttempt,
};

async function runAttempt({ row, attemptIndex, args, runDir }) {
  const instanceId = row.instance_id;
  const attemptDir = path.join(runDir, "trajectories", harness.name, instanceId, `attempt-${attemptIndex}`);
  const trajectoryFile = path.join(attemptDir, "trajectory.jsonl");
  const workspaceDir = attemptWorkspace(attemptDir);
  const predictionPrefix = `${args.runId}__${harness.name}__${instanceId}__attempt-${attemptIndex}`;
  const predictionPath = path.join(attemptDir, "prediction.json");

  if (args.resume && (await pathExists(predictionPath))) {
    const prediction = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(predictionPath, "utf8")));
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
  const prompt = promptForInstance(row);
  await writeText(path.join(attemptDir, "prompt.md"), prompt);
  await writeJson(path.join(attemptDir, "attempt.json"), {
    run_id: args.runId,
    harness: harness.name,
    instance_id: instanceId,
    attempt_index: attemptIndex,
    prefix: predictionPrefix,
    model: args.model,
    max_turns: args.maxTurns,
    attempt_timeout_ms: args.attemptTimeoutMs,
    permission_mode: args.permissionMode,
    metadata_shown_to_agent: publicMetadata(row),
    started_at: new Date().toISOString(),
  });
  await appendJsonl(trajectoryFile, { type: "attempt_start", timestamp: new Date().toISOString(), instance_id: instanceId, attempt_index: attemptIndex, prompt });

  await cloneCheckout({ row, workspaceDir, trajectoryFile });

  const attemptHome = path.join(attemptDir, ".home");
  const ansibleLocalTemp = path.join(attemptDir, ".ansible-tmp");
  await ensureDir(attemptHome);
  await ensureDir(ansibleLocalTemp);
  const env = await claudeEnv({ CLAUDE_CONFIG_DIR: path.join(attemptDir, ".claude-config"), HOME: attemptHome, ANSIBLE_LOCAL_TEMP: ansibleLocalTemp });
  let sdkError = null;
  const attemptTimeoutMs = Number(args.attemptTimeoutMs || 0);
  const abortController = attemptTimeoutMs > 0 ? new AbortController() : null;
  const timeoutId = abortController
    ? setTimeout(() => abortController.abort(new Error(`Claude Code attempt timed out after ${attemptTimeoutMs}ms`)), attemptTimeoutMs)
    : null;
  try {
    for await (const message of query({
      prompt,
      options: {
        ...(abortController ? { abortController } : {}),
        cwd: workspaceDir,
        model: args.model,
        maxTurns: args.maxTurns,
        permissionMode: args.permissionMode,
        env,
        canUseTool: async (_toolName, _input, permission) => {
          if (permission.blockedPath) {
            const blockedPath = path.resolve(permission.blockedPath);
            const allowedRoot = path.resolve(workspaceDir);
            if (blockedPath !== allowedRoot && !blockedPath.startsWith(`${allowedRoot}${path.sep}`)) {
              return { behavior: "deny", toolUseID: permission.toolUseID, message: `Denied access outside attempt workspace: ${blockedPath}` };
            }
          }
          return { behavior: "allow", updatedInput: _input || {}, toolUseID: permission.toolUseID, decisionClassification: "user_temporary" };
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "You are running inside an automated SWE-bench Pro harness. Use tools freely inside the attempt workspace. Do not reveal or request secrets. Leave only the intended source patch in the working tree.",
        },
      },
    })) {
      await appendJsonl(trajectoryFile, { type: "sdk_message", timestamp: new Date().toISOString(), message });
    }
  } catch (error) {
    const text = String(error?.stack || error);
    sdkError = abortController?.signal.aborted ? `Claude Code attempt timed out after ${attemptTimeoutMs}ms.\n\n${text}` : text;
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
