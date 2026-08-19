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
import { isDeepStrictEqual } from "node:util";

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
import {
  evaluateLogicalThreadContinuation,
} from "../../dist/testing/logical-thread-continuation-eval.js";
import {
  runLogicalThreadContinuationScenario,
} from "./logical-thread-continuation-scenario.mjs";

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
const firstContextToken = `logical-context-r1-${randomBytes(16).toString("hex")}`;
const longHorizonContextToken = `logical-context-long-${randomBytes(16).toString("hex")}`;
const secondContextToken = `logical-context-r2-${randomBytes(16).toString("hex")}`;
const goalCompletionCondition = "Satisfy every requirement in the current round prompt exactly, verify the resulting workspace state, and then mark the active Goal complete before the final summary.";
const providerInvocations = [];
let runner;

try {
  seedGitWorkspace();
  runner = createRunner();
  const scenario = await runLogicalThreadContinuationScenario({
    createRequest: goalRequest,
    runIdPrefix: `agent-runtime-goal-v3-${provider}`,
    firstToken: firstContextToken,
    longHorizonToken: longHorizonContextToken,
    secondToken: secondContextToken,
    outcomes: {
      startedFresh: AgentRuntimeThreadOutcome.StartedFresh,
      continued: AgentRuntimeThreadOutcome.Continued,
    },
    restart: restartRunner,
    run: (request) => runner.run(request),
    assertCompleted,
    readWorkspaceFile: (path) => readFile(join(workspace, path), "utf8"),
    writeWorkspaceFile: (path, content) =>
      writeFile(join(workspace, path), content, "utf8"),
    providerInvocationCount: () => providerInvocations.length,
    readWorkspaceSnapshot: workspaceFixtureText,
    resultOutputText: (result) => result.outputText,
    observeFinalWorkspaceBoundary: observeWorkspaceBoundary,
    matchesStaleFailure: (result) => matchesFailure(
      result,
      AgentRuntimeFailureCode.StaleGeneration,
      AgentRuntimeFailureLifecycleState.PreflightFailed,
    ) && result.failure.details?.control === "workspace_effect",
  });
  const { first, second, third } = scenario.results;
  const { first: firstRequest, second: secondRequest, third: thirdRequest } =
    scenario.requests;
  assert.deepEqual(
    providerInvocations.map((record) => record.hadPreviousCheckpoint),
    [false, true, true],
    "later rounds must receive the durable provider checkpoint",
  );

  await runDeterministicFailureProbes();
  const evalReport = evaluateLogicalThreadContinuation({
    expectedRounds: 3,
    completedRounds: 3,
    threadIds: [first.thread.id, second.thread.id, third.thread.id],
    executionIds: [
      firstRequest.executionId,
      secondRequest.executionId,
      thirdRequest.executionId,
    ],
    outcomes: [first.thread.outcome, second.thread.outcome, third.thread.outcome],
    exactContextRecallChecks: scenario.exactContextRecallChecks,
    runnerRestartCount: scenario.restartCount,
    exactReplayChecks: scenario.exactReplayChecks,
    exactReplayProviderSideEffects: scenario.exactReplayProviderSideEffects,
    restoredEffectRecovered: scenario.restoredEffectRecovered,
    staleWorkspaceFailedClosed: scenario.staleWorkspaceFailedClosed,
    forbiddenTokensAbsentFromWorkspaceSnapshots:
      scenario.forbiddenTokensAbsentFromWorkspaceSnapshots,
    longHorizonTokenAbsentFromRoundTwoOutput:
      scenario.longHorizonTokenAbsentFromRoundTwoOutput,
    workspaceBoundaryPreserved: scenario.workspaceBoundaryPreserved,
  });
  assert.equal(evalReport.passed, true, `logical-thread eval failed: ${JSON.stringify(evalReport)}`);

  console.log(JSON.stringify({
    ok: true,
    evaluation: evalReport,
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    provider,
    executionMode: AgentRuntimeExecutionMode.Goal,
    logicalThread: {
      stableThreadId:
        new Set([first.thread.id, second.thread.id, third.thread.id]).size === 1,
      executionIds: [
        firstRequest.executionId,
        secondRequest.executionId,
        thirdRequest.executionId,
      ],
      outcomes: [first.thread.outcome, second.thread.outcome, third.thread.outcome],
      contextPreserved: scenario.exactContextRecallChecks.every(Boolean),
      runnerRestartCount: scenario.restartCount,
    },
    providerExecution: {
      runCount: providerInvocations.length,
      exactReplaySideEffects: scenario.exactReplayProviderSideEffects,
    },
    durableReplay: {
      exactAfterRestart: scenario.exactReplayChecks.every(Boolean),
      staleWorkspaceFailClosed: scenario.staleWorkspaceFailedClosed,
      restoredEffectRecovered: scenario.restoredEffectRecovered,
    },
    deterministicFailureProbes: {
      cancellation: true,
      timeout: true,
      terminalFailureExactReplay: true,
    },
    changedFiles: ["context.txt", "round-one.txt", "round-three.txt"],
    outsideWorkspaceUnchanged: scenario.workspaceBoundaryPreserved,
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
  writeFileSync(join(workspace, "round-three.txt"), "unset\n");
  writeFileSync(outsideCanary, "outside-safe\n");
  symlinkSync(outsideCanary, join(workspace, "escape-link"));
  execFileSync("git", [
    "-C",
    workspace,
    "add",
    "round-one.txt",
    "context.txt",
    "round-three.txt",
    "escape-link",
  ]);
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

function matchesFailure(result, code, lifecycle) {
  return result.protocolVersion === agentRuntimeTaskProtocolVersionV3 &&
    result.status === AgentRuntimeTaskResultStatus.Failed &&
    result.failure.code === code &&
    result.lifecycle.state === lifecycle;
}

async function observeWorkspaceBoundary() {
  try {
    const status = gitWorkspaceStatus();
    return isDeepStrictEqual(
      status.map((entry) => entry.slice(3)).sort(),
      ["context.txt", "round-one.txt", "round-three.txt"],
    ) && status.every((entry) => /^(?: M|M |MM) /.test(entry)) &&
      readFileSync(outsideCanary, "utf8") === "outside-safe\n" &&
      await readFile(join(workspace, "round-one.txt"), "utf8") === "ready\n" &&
      await readFile(join(workspace, "context.txt"), "utf8") ===
        `${firstContextToken}\n` &&
      await readFile(join(workspace, "round-three.txt"), "utf8") ===
        `${firstContextToken}\n${longHorizonContextToken}\n${secondContextToken}\n`;
  } catch {
    return false;
  }
}

async function workspaceFixtureText() {
  return (await Promise.all(
    ["round-one.txt", "context.txt", "round-three.txt"]
      .map((path) => readFile(join(workspace, path), "utf8")),
  )).join("");
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
