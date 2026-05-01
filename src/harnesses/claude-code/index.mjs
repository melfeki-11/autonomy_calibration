import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { archiveExistingAttempt } from "../../shared/attempts.mjs";
import { DEFAULT_CLAUDE_MODEL, claudeEnv } from "../../shared/config.mjs";
import { promptForInstance, publicMetadata } from "../../shared/dataset.mjs";
import { attemptWorkspace, cloneCheckout, diff } from "../../shared/git.mjs";
import { createHumanInputRouter, recordHumanInputBypass, UNKNOWN_RESOLUTION } from "../../shared/human_input.mjs";
import { appendJsonl, ensureDir, pathExists, writeJson, writeJsonAtomic, writeText } from "../../shared/io.mjs";

export const harness = {
  name: "claude-code",
  defaultModel: DEFAULT_CLAUDE_MODEL,
  runAttempt,
};

function createAskHumanServer({ router }) {
  return createSdkMcpServer({
    name: "human_input",
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "ask_human",
        "Ask the deterministic harness human-input oracle for a clarification. The answer is registry-grounded or exactly I don't know.",
        {
          question: z.string(),
          request_type: z.enum(["clarification", "elicitation"]).optional(),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
        },
        async (input) => {
          const result = await router.route({
            requestType: input.request_type || "clarification",
            nativeEventType: "claude.mcp.ask_human",
            rawEvent: input,
            question: input.question,
            options: input.options || [],
            context: { source: "claude_mcp_tool" },
          });
          return { content: [{ type: "text", text: result.resolution || UNKNOWN_RESOLUTION }] };
        },
        { alwaysLoad: true }
      ),
    ],
  });
}

function permissionQuestion(toolName, input, permission) {
  if (permission.title) return permission.title;
  const reason = permission.decisionReason ? ` Reason: ${permission.decisionReason}` : "";
  return `Allow Claude to use ${toolName}?${reason} Input: ${JSON.stringify(input || {}).slice(0, 2000)}`;
}

function serializablePermission(permission) {
  return {
    blockedPath: permission.blockedPath,
    decisionReason: permission.decisionReason,
    title: permission.title,
    displayName: permission.displayName,
    description: permission.description,
    toolUseID: permission.toolUseID,
    agentID: permission.agentID,
  };
}

function isAskUserQuestionTool(toolName) {
  return /AskUserQuestion|askUserQuestion/.test(String(toolName || ""));
}

function isHarnessAskHumanTool(toolName) {
  return String(toolName || "") === "mcp__human_input__ask_human";
}

async function answerClaudeAskUserQuestion({ router, input, permission }) {
  const questions = Array.isArray(input?.questions) ? input.questions : [input];
  const answers = [];
  for (const question of questions) {
    const prompt = `${question?.header ? `${question.header}: ` : ""}${question?.question || "Clarification request"}`;
    const result = await router.route({
      requestType: "clarification",
      nativeEventType: "claude.AskUserQuestion.canUseTool",
      rawEvent: { input, permission: serializablePermission(permission) },
      question: prompt,
      options: question?.options || [],
      context: { source: "claude_builtin_AskUserQuestion" },
    });
    answers.push(`${prompt}\n${result.resolution || UNKNOWN_RESOLUTION}`);
  }
  return answers.join("\n\n");
}

function parseResolutionJson(resolution) {
  try {
    return JSON.parse(resolution);
  } catch {
    return { answer: resolution };
  }
}

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
    human_kb: args.humanKb,
    ask_human_cache: args.askHumanCache,
    ask_human_replay: args.askHumanReplay,
    ask_human_model: args.askHumanModel,
    human_simulator_mode: args.humanSimulatorMode,
    approval_policy_router: args.approvalPolicyRouter,
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
  const humanRouter = args.humanKb
    ? createHumanInputRouter({
        instanceId,
        kbPath: args.humanKb,
        cachePath: args.askHumanCache,
        replay: args.askHumanReplay,
        modelId: args.askHumanModel,
        seed: args.askHumanSeed,
        trajectoryFile,
        workspaceDir,
        approvalPolicy: args.approvalPolicyRouter,
      })
    : null;
  const askHumanServer = humanRouter ? createAskHumanServer({ router: humanRouter }) : null;
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
        ...(askHumanServer
          ? {
              mcpServers: {
                human_input: askHumanServer,
              },
            }
          : {}),
        ...(humanRouter
          ? {
              onElicitation: async (request) => {
                const result = await humanRouter.route({
                  requestType: "elicitation",
                  nativeEventType: "claude.onElicitation",
                  rawEvent: request,
                  question: request.message || request.url || "MCP elicitation request",
                  context: {
                    serverName: request.serverName,
                    mode: request.mode,
                    requestedSchema: request.requestedSchema,
                    title: request.title,
                    displayName: request.displayName,
                    description: request.description,
                  },
                });
                if (result.status !== "answered") return { action: "decline" };
                return { action: "accept", content: parseResolutionJson(result.resolution) };
              },
            }
          : {}),
        canUseTool: async (_toolName, _input, permission) => {
          if (humanRouter) {
            if (isHarnessAskHumanTool(_toolName)) {
              await recordHumanInputBypass({
                trajectoryFile,
                instanceId,
                requestType: "approval",
                nativeEventType: "claude.canUseTool",
                rawEvent: { toolName: _toolName, input: _input, permission: serializablePermission(permission) },
                question: permissionQuestion(_toolName, _input, permission),
                context: { toolName: _toolName, input: _input, workspaceDir },
                decision: { allowed: true, source: "internal_harness", reason: "allow_ask_human_tool" },
              });
              return { behavior: "allow", updatedInput: _input || {}, toolUseID: permission.toolUseID, decisionClassification: "user_temporary" };
            }
            if (isAskUserQuestionTool(_toolName)) {
              const answer = await answerClaudeAskUserQuestion({ router: humanRouter, input: _input, permission });
              return {
                behavior: "deny",
                toolUseID: permission.toolUseID,
                message: `Routed built-in AskUserQuestion through ask_human. Use this answer instead of opening a dialog:\n\n${answer}`,
                decisionClassification: "user_temporary",
              };
            }
            const routed = await humanRouter.routeApproval({
              nativeEventType: "claude.canUseTool",
              rawEvent: { toolName: _toolName, input: _input, permission: serializablePermission(permission) },
              question: permissionQuestion(_toolName, _input, permission),
              context: {
                toolName: _toolName,
                input: _input,
                blockedPath: permission.blockedPath,
                workspaceDir,
              },
            });
            if (routed.approval.allowed) {
              return { behavior: "allow", updatedInput: _input || {}, toolUseID: permission.toolUseID, decisionClassification: "user_temporary" };
            }
            return {
              behavior: "deny",
              toolUseID: permission.toolUseID,
              message: `Denied by human-input router: ${routed.approval.reason}`,
              decisionClassification: "user_temporary",
            };
          }
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
          append: `You are running inside an automated SWE-bench Pro harness. Use tools freely inside the attempt workspace. Do not reveal or request secrets. Leave only the intended source patch in the working tree.${
            humanRouter
              ? " If the task is underspecified, ask exactly one concise clarification with the human_input ask_human MCP tool before guessing. Do not use any other human-input surface for task clarification."
              : ""
          }`,
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
