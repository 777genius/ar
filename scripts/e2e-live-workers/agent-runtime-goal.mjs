#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeFailureCode,
  AgentRuntimeTaskKind,
  AgentRuntimeTaskResultStatus,
  AgentRuntimeThreadOutcome,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
  AgentRuntimeFailureLifecycleState,
  agentRuntimeTaskProtocolVersionV3,
} from "../../dist/agent-runtime-task/index.js";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
} from "../../dist/agent-runtime-task-runner/index.js";
import {
  createDefaultAgentRuntimeTaskWorker,
} from "../../dist/worker-local/agent-runtime-task-runner/index.js";

if (!process.argv.includes("--allow-live")) {
  throw new Error("live Agent Runtime Goal V3 E2E requires --allow-live");
}

const root = await mkdtemp(join(tmpdir(), "agent-runtime-goal-v3-live-"));
const workspace = join(root, "workspace");
const stateRootDir = join(root, "state");
const providerAuditPath = join(root, "provider-invocations.jsonl");
const outsideCanary = join(root, "outside-canary.txt");
const keepArtifacts = process.argv.includes("--keep-artifacts");
const provider = providerArg(process.argv.slice(2));
const encryptionKey = randomBytes(32);
const threadId = `agent-runtime-goal-v3-${provider}-${randomBytes(8).toString("hex")}`;
const contextToken = `logical-context-${randomBytes(16).toString("hex")}`;
const goalCompletionCondition = "Satisfy every requirement in the current round prompt exactly, verify the resulting workspace state, and then mark the active Goal complete before the final summary.";
const providerInvocations = [];
let runner;

try {
  seedGitWorkspace();

  const firstRequest = goalRequest({
    executionId: "goal-round-1",
    runId: `agent-runtime-goal-v3-${provider}-round-1`,
    prompt: [
      `Remember this opaque context token for the next logical-thread round: ${contextToken}`,
      "Keep the token only in conversation context. Do not write it into any file in this round.",
      "Edit only round-one.txt so it contains exactly ready followed by one newline.",
      "Verify context.txt still contains exactly unset followed by one newline.",
      "After the exact verification succeeds, mark the active Goal complete before the final summary.",
    ].join("\n"),
  });
  const secondRequest = goalRequest({
    executionId: "goal-round-2",
    runId: `agent-runtime-goal-v3-${provider}-round-2`,
    prompt: [
      "Continue the same logical thread.",
      "Recall the exact opaque context token supplied in the previous round; it is intentionally not repeated here.",
      "Edit only context.txt so it contains that exact token followed by one newline.",
      "Do not modify round-one.txt or any other file.",
      "After the exact verification succeeds, mark the active Goal complete before the final summary.",
    ].join("\n"),
  });
  assert.deepEqual(
    firstRequest.task.execution,
    secondRequest.task.execution,
    "V3 rounds must keep identical execution compatibility inputs",
  );
  assert.deepEqual(
    firstRequest.task.controls,
    secondRequest.task.controls,
    "V3 rounds must keep identical control compatibility inputs",
  );

  runner = createRunner();
  const first = await runner.run(firstRequest);
  assertCompleted(first, AgentRuntimeThreadOutcome.StartedFresh, "round one");
  assert.equal(await readFile(join(workspace, "round-one.txt"), "utf8"), "ready\n");
  assert.equal(await readFile(join(workspace, "context.txt"), "utf8"), "unset\n");
  assert.equal(providerInvocations.length, 1, "round one must invoke the real provider once");

  await restartRunner({ replayOnly: true });
  const beforeFirstReplay = providerInvocations.length;
  const firstReplay = await runner.run(firstRequest);
  assert.deepEqual(firstReplay, first, "completed round one must replay exactly after runner restart");
  assert.equal(
    providerInvocations.length,
    beforeFirstReplay,
    "exact replay must not invoke the provider",
  );

  await restartRunner();
  const second = await runner.run(secondRequest);
  assertCompleted(second, AgentRuntimeThreadOutcome.Continued, "round two");
  assert.equal(
    await readFile(join(workspace, "context.txt"), "utf8"),
    `${contextToken}\n`,
    "round two must recover context that was available only in round one",
  );
  assert.equal(providerInvocations.length, 2, "two Goal rounds must invoke the provider twice");
  assert.deepEqual(
    providerInvocations.map((record) => record.hadPreviousCheckpoint),
    [false, true],
    "round two must receive the durable provider checkpoint",
  );

  await restartRunner({ replayOnly: true });
  const beforeSecondReplay = providerInvocations.length;
  const secondReplay = await runner.run(secondRequest);
  assert.deepEqual(secondReplay, second, "completed round two must replay exactly after runner restart");
  assert.equal(
    providerInvocations.length,
    beforeSecondReplay,
    "round-two exact replay must not invoke the provider",
  );

  await writeFile(join(workspace, "context.txt"), "tampered\n", "utf8");
  const staleReplay = await runner.run(secondRequest);
  assertFailed(
    staleReplay,
    AgentRuntimeFailureCode.StaleGeneration,
    AgentRuntimeFailureLifecycleState.PreflightFailed,
    "workspace-tampered replay",
  );
  assert.equal(staleReplay.failure.details?.control, "workspace_effect");
  assert.equal(
    providerInvocations.length,
    beforeSecondReplay,
    "stale replay must fail closed before provider execution",
  );

  await writeFile(join(workspace, "context.txt"), `${contextToken}\n`, "utf8");
  const restoredReplay = await runner.run(secondRequest);
  assert.deepEqual(
    restoredReplay,
    second,
    "restoring the exact Git-visible effect must recover durable replay",
  );
  assert.equal(providerInvocations.length, beforeSecondReplay);

  await runDeterministicFailureProbes();
  assertWorkspaceBoundary();

  console.log(JSON.stringify({
    ok: true,
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    provider,
    executionMode: AgentRuntimeExecutionMode.Goal,
    logicalThread: {
      stableThreadId: true,
      executionIds: [firstRequest.executionId, secondRequest.executionId],
      outcomes: [first.thread.outcome, second.thread.outcome],
      contextPreserved: true,
      runnerRestartCount: 3,
    },
    providerExecution: {
      runCount: providerInvocations.length,
      exactReplaySideEffects: 0,
    },
    durableReplay: {
      exactAfterRestart: true,
      staleWorkspaceFailClosed: true,
      restoredEffectRecovered: true,
    },
    deterministicFailureProbes: {
      cancellation: true,
      timeout: true,
      terminalFailureExactReplay: true,
    },
    changedFiles: ["context.txt", "round-one.txt"],
    outsideWorkspaceUnchanged: true,
    toolSurface: provider === AgentRuntimeTaskProvider.Codex
      ? "bounded-workspace-mcp"
      : "provider-native-guarded",
    fallback: "disabled",
  }));
} finally {
  await runner?.dispose();
  if (keepArtifacts) console.error(`E2E_ARTIFACT_ROOT=${root}`);
  else await rm(root, { recursive: true, force: true });
}

function seedGitWorkspace() {
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Agent Runtime E2E"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "e2e@example.invalid"]);
  execFileSync("git", ["-C", workspace, "config", "commit.gpgsign", "false"]);
  execFileSync("git", ["-C", workspace, "config", "tag.gpgsign", "false"]);
  writeFileSync(join(workspace, "round-one.txt"), "pending\n");
  writeFileSync(join(workspace, "context.txt"), "unset\n");
  writeFileSync(outsideCanary, "outside-safe\n");
  symlinkSync(outsideCanary, join(workspace, "escape-link"));
  execFileSync("git", ["-C", workspace, "add", "round-one.txt", "context.txt", "escape-link"]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "test: seed V3 fixture"]);
}

function createRunner(options = {}) {
  return createLocalAgentRuntimeTaskRunner({
    provider,
    ...providerRuntimeConfig(provider, options.replayOnly),
    stateRootDir,
    encryptionKey,
    workspaceRoot: workspace,
    env: runtimeEnv(process.env),
    authSource: authSource(provider),
    timeoutMs: 180_000,
    cleanupTimeoutMs: 15_000,
    ...(options.replayOnly && provider === AgentRuntimeTaskProvider.Codex
      ? { codexRuntimeFeatureProbe: { supports: async () => true } }
      : {}),
    workerFactory: options.replayOnly
      ? replayOnlyWorkerFactory
      : auditedRealWorkerFactory,
  });
}

async function restartRunner(options) {
  await runner?.dispose();
  runner = createRunner(options);
}

function replayOnlyWorkerFactory() {
  return {
    async start() {
      throw new Error("exact replay attempted to start a provider worker");
    },
    async run() {
      throw new Error("exact replay attempted to invoke a provider worker");
    },
    async dispose() {},
  };
}

function auditedRealWorkerFactory(input) {
  const worker = createDefaultAgentRuntimeTaskWorker(input);
  return {
    start: async () => await worker.start(),
    ...(worker.seedClaudeOAuth === undefined
      ? {}
      : {
          seedClaudeOAuth: async (seedInput) =>
            await worker.seedClaudeOAuth(seedInput),
        }),
    ...(worker.seedCodexAuthJsonFile === undefined
      ? {}
      : {
          seedCodexAuthJsonFile: async (path) =>
            await worker.seedCodexAuthJsonFile(path),
        }),
    run: async (job, options) => {
      const record = {
        sequence: providerInvocations.length + 1,
        provider,
        hadPreviousCheckpoint:
          job.logicalThread?.previousCheckpoint !== undefined,
      };
      providerInvocations.push(record);
      await appendFile(providerAuditPath, `${JSON.stringify(record)}\n`, "utf8");
      return await worker.run(job, options);
    },
    ...(worker.dispose === undefined
      ? {}
      : { dispose: async () => await worker.dispose() }),
  };
}

function goalRequest(input) {
  return {
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    executionId: input.executionId,
    thread: { id: threadId },
    runId: input.runId,
    cwd: ".",
    timeoutMs: 180_000,
    task: {
      kind: AgentRuntimeTaskKind.StructuredPrompt,
      prompt: input.prompt,
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: goalCompletionCondition,
      },
      controls: goalControls(provider),
    },
  };
}

function goalControls(selectedProvider) {
  return {
    maxTurns: 8,
    accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
    toolPolicy: {
      allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile],
      deny: [
        AgentRuntimeTool.WriteFile,
        AgentRuntimeTool.SearchFiles,
        AgentRuntimeTool.Shell,
        AgentRuntimeTool.WebAccess,
        AgentRuntimeTool.DelegateAgent,
        AgentRuntimeTool.WorktreeControl,
        AgentRuntimeTool.NotebookEdit,
      ],
      onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
    },
    budget: {
      metric: selectedProvider === AgentRuntimeTaskProvider.Codex
        ? AgentRuntimeBudgetMetric.WeightedTokens
        : AgentRuntimeBudgetMetric.Usd,
      limit: selectedProvider === AgentRuntimeTaskProvider.Codex ? 100_000 : 1,
      onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
    },
  };
}

async function runDeterministicFailureProbes() {
  await runCancellationProbe();
  await runTimeoutProbe();
}

async function runCancellationProbe() {
  let starts = 0;
  const probeRunner = createLocalAgentRuntimeTaskRunner({
    provider: AgentRuntimeTaskProvider.Claude,
    stateRootDir: join(root, "cancel-probe-state"),
    encryptionKey,
    workspaceRoot: workspace,
    env: {},
    authSource: { kind: AuthSourceKind.PreseededSession },
    workerFactory: () => ({
      async start() {
        starts += 1;
      },
      async run() {
        throw new Error("pre-cancelled probe must not run");
      },
      async dispose() {},
    }),
  });
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await probeRunner.run(
      probeRequest("cancel-probe", "cancel-thread"),
      { signal: controller.signal },
    );
    assertFailed(
      result,
      AgentRuntimeFailureCode.TaskCancelled,
      AgentRuntimeFailureLifecycleState.PreflightFailed,
      "pre-cancelled execution",
    );
    assert.equal(starts, 0, "pre-cancelled V3 request must not start a worker");
  } finally {
    await probeRunner.dispose();
  }
}

async function runTimeoutProbe() {
  let runs = 0;
  const probeRunner = createLocalAgentRuntimeTaskRunner({
    provider: AgentRuntimeTaskProvider.Claude,
    stateRootDir: join(root, "timeout-probe-state"),
    encryptionKey,
    workspaceRoot: workspace,
    env: {},
    authSource: { kind: AuthSourceKind.PreseededSession },
    cleanupTimeoutMs: 1_000,
    workerFactory: () => ({
      async start() {},
      async run(job, options) {
        runs += 1;
        await options?.onProviderTaskStarted?.();
        await waitForAbort(job.abortSignal);
        return { outputText: "stopped after timeout", warnings: [] };
      },
      async dispose() {},
    }),
  });
  const request = {
    ...probeRequest("timeout-probe", "timeout-thread"),
    timeoutMs: 50,
  };
  try {
    const first = await probeRunner.run(request);
    assertFailed(
      first,
      AgentRuntimeFailureCode.TaskTimeout,
      AgentRuntimeFailureLifecycleState.ExecutionFailed,
      "authoritative timeout",
    );
    const replay = await probeRunner.run(request);
    assert.deepEqual(replay, first, "terminal timeout must replay exactly");
    assert.equal(runs, 1, "timeout replay must not repeat the provider side effect");
  } finally {
    await probeRunner.dispose();
  }
}

function probeRequest(executionId, probeThreadId) {
  return {
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    executionId,
    thread: { id: probeThreadId },
    cwd: ".",
    task: {
      kind: AgentRuntimeTaskKind.StructuredPrompt,
      prompt: "deterministic lifecycle probe",
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "The deterministic lifecycle probe is complete.",
      },
      controls: goalControls(AgentRuntimeTaskProvider.Claude),
    },
  };
}

function assertCompleted(result, outcome, label) {
  assert.equal(result.protocolVersion, agentRuntimeTaskProtocolVersionV3, `${label} protocol`);
  if (result.status !== AgentRuntimeTaskResultStatus.Completed) {
    console.error(JSON.stringify({
      ok: false,
      label,
      provider,
      result: safeFailureDiagnostic(result),
      providerInvocationCount: providerInvocations.length,
      workspaceStatus: gitWorkspaceStatus(),
    }));
  }
  assert.equal(result.status, AgentRuntimeTaskResultStatus.Completed, `${label} status`);
  assert.equal(result.thread?.id, threadId, `${label} thread id`);
  assert.equal(result.thread?.outcome, outcome, `${label} thread outcome`);
  assert.equal(
    result.telemetry?.providerSessionId,
    undefined,
    `${label} must not expose a provider checkpoint`,
  );
}

function safeFailureDiagnostic(result) {
  return {
    protocolVersion: result.protocolVersion,
    status: result.status,
    ...(result.status !== AgentRuntimeTaskResultStatus.Failed
      ? {}
      : {
          failure: {
            code: result.failure.code,
            safeMessage: result.failure.safeMessage,
            retryable: result.failure.retryable,
            reconnectRequired: result.failure.reconnectRequired,
            causeCategory: result.failure.causeCategory,
            details: safeFailureDetails(result.failure.details),
          },
        }),
    lifecycle: result.lifecycle,
    warnings: result.warnings?.map((warning) => ({
      code: warning.code,
      safeMessage: warning.safeMessage,
    })),
    telemetry: result.telemetry === undefined
      ? undefined
      : {
          turns: result.telemetry.turns,
          cost: result.telemetry.cost,
          usage: result.telemetry.usage,
        },
  };
}

function safeFailureDetails(details) {
  if (details === undefined) return undefined;
  const safeKeys = [
    "control",
    "provider",
    "phase",
    "turnNumber",
    "outputObserved",
    "outputCharCount",
    "elapsedMs",
    "exitCode",
    "sourceThreadUnavailable",
  ];
  const detailKeys = safeKeys.filter((key) => details[key] !== undefined);
  return {
    detailKeys,
    ...Object.fromEntries(
      detailKeys
        .map((key) => [key, details[key]]),
    ),
  };
}

function assertFailed(result, code, lifecycle, label) {
  assert.equal(result.protocolVersion, agentRuntimeTaskProtocolVersionV3, `${label} protocol`);
  assert.equal(result.status, AgentRuntimeTaskResultStatus.Failed, `${label} status`);
  assert.equal(result.failure.code, code, `${label} failure code`);
  assert.equal(result.lifecycle.state, lifecycle, `${label} lifecycle`);
}

function assertWorkspaceBoundary() {
  const status = gitWorkspaceStatus();
  assert.deepEqual(
    status.map((entry) => entry.slice(3)).sort(),
    ["context.txt", "round-one.txt"],
    "only the two sandbox fixture files may change",
  );
  assert.equal(
    status.every((entry) => /^(?: M|M |MM) /.test(entry)),
    true,
    "sandbox fixture files may be modified but not added, deleted, or renamed",
  );
  assert.equal(
    readFileSync(outsideCanary, "utf8"),
    "outside-safe\n",
    "outside canary must remain unchanged",
  );
}

function gitWorkspaceStatus() {
  return execFileSync(
    "git",
    ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trimEnd().split("\n").filter(Boolean).sort();
}

function providerArg(args) {
  const equals = args.find((arg) => arg.startsWith("--provider="));
  const index = args.indexOf("--provider");
  const value = equals?.slice("--provider=".length) ??
    (index === -1 ? AgentRuntimeTaskProvider.Codex : args[index + 1]);
  if (
    value !== AgentRuntimeTaskProvider.Codex &&
    value !== AgentRuntimeTaskProvider.Claude
  ) {
    throw new Error(`unsupported live Goal provider: ${String(value)}`);
  }
  return value;
}

function providerRuntimeConfig(selectedProvider, replayOnly = false) {
  const binaryPath = replayOnly
    ? join(root, "provider-binary-must-not-run")
    : undefined;
  return selectedProvider === AgentRuntimeTaskProvider.Codex
    ? {
        providerRuntime: {
          binaryPath: binaryPath ?? process.env.CODEX_BINARY_PATH ?? "codex",
        },
      }
    : {
        providerRuntime: {
          backend: ClaudeAgentRuntimeBackend.AgentSdk,
          binaryPath: binaryPath ?? process.env.CLAUDE_BINARY_PATH ?? "claude",
        },
      };
}

function authSource(selectedProvider) {
  if (selectedProvider === AgentRuntimeTaskProvider.Codex) {
    return {
      kind: AuthSourceKind.CodexAuthJsonFile,
      path: join(homedir(), ".codex", "auth.json"),
    };
  }
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!oauthToken) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for Claude Goal V3 E2E");
  }
  return {
    kind: AuthSourceKind.ClaudeOAuthToken,
    oauthToken,
  };
}

function runtimeEnv(source) {
  return Object.fromEntries(
    ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"]
      .flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

async function waitForAbort(signal) {
  if (!signal || signal.aborted) return;
  await new Promise((resolve) =>
    signal.addEventListener("abort", resolve, { once: true })
  );
}
