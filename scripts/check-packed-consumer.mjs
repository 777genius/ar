#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const retainValidatedTarball = process.argv.length === 3 &&
  process.argv[2] === "--retain-validated-tarball";
if (process.argv.length > 2 && !retainValidatedTarball) {
  throw new Error("unsupported packed-consumer argument");
}
let validated = false;

const rootDir = new URL("..", import.meta.url).pathname;
const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-consumer-"));
const emptyCacheDir = join(tempDir, "npm-cache");
let tarball;

try {
  const pack = spawnSync("npm", ["pack", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (pack.status !== 0) {
    if (pack.error) process.stderr.write(`${pack.error.message}\n`);
    process.stderr.write(pack.stderr ?? "");
    process.exit(pack.status ?? 1);
  }
  const [{ filename }] = parseNpmPackJson(pack.stdout);
  tarball = join(rootDir, filename);

  await writeFile(
    join(tempDir, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2),
  );
  run(
    "npm",
    [
      "install",
      "--silent",
      "--offline",
      "--omit=optional",
      "--ignore-scripts",
      "--cache",
      emptyCacheDir,
      tarball,
    ],
    { cwd: tempDir },
  );
  const expectedCapabilities =
    '{"schemaVersion":1,"protocolVersions":[2],"inlineOutputSchema":true,"reasoningEffort":true,"serviceTier":true,"boundedReadOnlyWorkspace":true,"instructionPathDeny":true}\n';
  const packedRoot = join(tempDir, "node_modules/@vioxen/subscription-runtime");
  const policy = await readFile(join(packedRoot, "dist/provider-codex/app-server/adapters/hosted-host-policy.js"), "utf8");
  if (await readFile(join(packedRoot, "host-integration/managed-launcher/hosted-host-policy.mjs"), "utf8") !==
      "// Generated from src/provider-codex/app-server/adapters/hosted-host-policy.ts.\n" +
      policy.replace(/^\/\/# sourceMappingURL=.*$/m, "")) throw new Error("packed Host policy parity failed");
  const capabilityProbe = spawnSync(
    join(tempDir, "node_modules/.bin/subscription-runtime-run-agent-runtime-task"),
    ["--capabilities-json", "1"],
    {
      cwd: tempDir,
      encoding: "utf8",
    },
  );
  if (
    capabilityProbe.status !== 0 ||
    capabilityProbe.stdout !== expectedCapabilities ||
    capabilityProbe.stderr !== ""
  ) {
    process.stderr.write(capabilityProbe.stdout);
    process.stderr.write(capabilityProbe.stderr);
    throw new Error("packed runtime capability contract failed");
  }
  await writeFile(
    join(tempDir, "smoke.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import { core, agentTask, agentRuntimeTask, agentRuntimeTaskRunner } from '@vioxen/subscription-runtime';",
      "import { createSubscriptionRuntime, SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT, SYSTEM_BUS_CONFIG } from '@vioxen/subscription-runtime/core';",
      "import * as codexProvider from '@vioxen/subscription-runtime/provider-codex';",
      "import { InMemorySessionStore, makeFakeArtifact, makeFakeRuntimeDeps } from '@vioxen/subscription-runtime/testing/fakes';",
      "import { createAgentTaskRequest } from '@vioxen/subscription-runtime/agent-task';",
      "import { createAgentRuntimeTaskRequest } from '@vioxen/subscription-runtime/agent-runtime-task';",
      "import { AgentRuntimeTaskProvider, resolveLocalAgentRuntimeTaskRunnerCliPath } from '@vioxen/subscription-runtime/agent-runtime-task-runner';",
      "import { ClaudeBgProviderDriver, ClaudeRuntimeTaskExecutionEngine } from '@vioxen/subscription-runtime/provider-claude';",
      "import { FileBackendCodexWorker, callCodexGoalMcpTool, doctorCodexGoalControlSurface } from '@vioxen/subscription-runtime/worker-codex';",
      "import { FileBackendClaudeWorker } from '@vioxen/subscription-runtime/worker-claude';",
      "import { createLocalFileBackendRuntimeAdapters } from '@vioxen/subscription-runtime/store-local-file';",
      "if (typeof agentTask.createAgentTaskRequest !== 'function') throw new Error('missing root agentTask namespace');",
      "if (typeof agentRuntimeTask.createAgentRuntimeTaskRequest !== 'function') throw new Error('missing root agentRuntimeTask namespace');",
      "if (typeof agentRuntimeTaskRunner.createLocalAgentRuntimeTaskRunner !== 'function') throw new Error('missing root agentRuntimeTaskRunner namespace');",
      "if (typeof createSubscriptionRuntime !== 'function') throw new Error('missing core export');",
      "for (const [name, value] of Object.entries({ SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT, SYSTEM_BUS_CONFIG })) {",
      "  assert.equal(core[name], value, 'legacy root core bus recipe: ' + name);",
      "  assert.equal(codexProvider[name], value, 'adapter-owned bus recipe: ' + name);",
      "}",
      "if (typeof createAgentTaskRequest !== 'function') throw new Error('missing agent-task export');",
      "if (typeof createAgentRuntimeTaskRequest !== 'function') throw new Error('missing agent-runtime-task export');",
      "if (AgentRuntimeTaskProvider.Claude !== 'claude') throw new Error('missing agent runtime task provider enum');",
      "if (typeof resolveLocalAgentRuntimeTaskRunnerCliPath !== 'function') throw new Error('missing agent runtime task CLI resolver');",
      "if (typeof ClaudeBgProviderDriver !== 'function') throw new Error('missing claude provider export');",
      "if (typeof ClaudeRuntimeTaskExecutionEngine !== 'function') throw new Error('missing claude runtime engine export');",
      "if (typeof FileBackendCodexWorker !== 'function') throw new Error('missing worker export');",
      "if (typeof callCodexGoalMcpTool !== 'function') throw new Error('missing codex goal MCP SDK export');",
      "if (typeof doctorCodexGoalControlSurface !== 'function') throw new Error('missing codex control doctor export');",
      "if (typeof FileBackendClaudeWorker !== 'function') throw new Error('missing claude worker export');",
      "if (typeof createLocalFileBackendRuntimeAdapters !== 'function') throw new Error('missing store export');",
      "const store = new InMemorySessionStore();",
      "store.seed({ providerInstanceId: 'smoke-account', artifact: makeFakeArtifact('session-v1') });",
      "const runtime = createSubscriptionRuntime(makeFakeRuntimeDeps({ store }));",
      "const result = await runtime.refreshThenRunTask({",
      "  providerInstanceId: 'smoke-account',",
      "  task: { kind: 'review', prompt: 'installation smoke check' },",
      "  runContext: { runId: 'smoke-run', attempt: 1, abortSignal: new AbortController().signal },",
      "});",
      "const stored = await store.read({ providerInstanceId: 'smoke-account', expectedProviderId: 'fake', purpose: 'health-check' });",
      "assert.equal(result.status, 'completed');",
      "assert.equal(stored?.generation, 2);",
      "console.log('packed consumer OK');",
    ].join("\n"),
  );
  run("node", ["smoke.mjs"], { cwd: tempDir });
  await writeFile(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(tempDir, "smoke.ts"),
    [
      "import { core, agentTask, agentRuntimeTask, agentRuntimeTaskRunner } from '@vioxen/subscription-runtime';",
      "import { createSubscriptionRuntime, DefaultRedactor, SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT, SYSTEM_BUS_CONFIG, type RunnerPort } from '@vioxen/subscription-runtime/core';",
      "import { createAgentTaskRequest, runAgentTaskBridge, type AgentTaskRequest } from '@vioxen/subscription-runtime/agent-task';",
      "import { createAgentRuntimeTaskRequest, runAgentRuntimeTaskBridge, type AgentRuntimeTaskRequest } from '@vioxen/subscription-runtime/agent-runtime-task';",
      "import { AgentRuntimeTaskProvider, type AgentRuntimeTaskRunner } from '@vioxen/subscription-runtime/agent-runtime-task-runner';",
      "import { ClaudeBgProviderDriver, ClaudeRuntimeTaskExecutionEngine, sessionArtifactFromClaudeOAuth } from '@vioxen/subscription-runtime/provider-claude';",
      "import { startOpenAiBridgeHttpServer } from '@vioxen/subscription-runtime/openai-compatible-codex';",
      "import { FileBackendCodexWorker, callCodexGoalMcpTool, doctorCodexGoalControlSurface, listCodexGoalMcpTools } from '@vioxen/subscription-runtime/worker-codex';",
      "import { FileBackendClaudeWorker } from '@vioxen/subscription-runtime/worker-claude';",
      "import { createLocalFileBackendRuntimeAdapters } from '@vioxen/subscription-runtime/store-local-file';",
      "void agentTask;",
      "void agentRuntimeTask;",
      "void agentRuntimeTaskRunner;",
      "void createSubscriptionRuntime;",
      "const _legacyBusArguments: readonly string[] = SYSTEM_BUS_ARGUMENTS;",
      "const _legacyBusRecipes: readonly string[] = [SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT, SYSTEM_BUS_CONFIG, core.SYSTEM_BUS_CONFIG];",
      "void _legacyBusArguments;",
      "void _legacyBusRecipes;",
      "void DefaultRedactor;",
      "void createAgentTaskRequest;",
      "void runAgentTaskBridge;",
      "void createAgentRuntimeTaskRequest;",
      "void runAgentRuntimeTaskBridge;",
      "void AgentRuntimeTaskProvider;",
      "void ClaudeBgProviderDriver;",
      "void ClaudeRuntimeTaskExecutionEngine;",
      "void sessionArtifactFromClaudeOAuth;",
      "void startOpenAiBridgeHttpServer;",
      "void FileBackendCodexWorker;",
      "void callCodexGoalMcpTool;",
      "void doctorCodexGoalControlSurface;",
      "void listCodexGoalMcpTools;",
      "void FileBackendClaudeWorker;",
      "void createLocalFileBackendRuntimeAdapters;",
      "const _claudeDriver = new ClaudeBgProviderDriver({ engine: new ClaudeRuntimeTaskExecutionEngine() });",
      "void _claudeDriver.streamTask;",
      "const _runner: RunnerPort | null = null;",
      "void _runner;",
      "const _agentTaskRequest: AgentTaskRequest = createAgentTaskRequest({ task: { kind: 'structured-prompt', prompt: 'typed legacy smoke' } });",
      "void _agentTaskRequest;",
      "const _agentRuntimeTaskRequest: AgentRuntimeTaskRequest = createAgentRuntimeTaskRequest({ task: { kind: 'structured-prompt', prompt: 'typed smoke' } });",
      "void _agentRuntimeTaskRequest;",
      "const _agentRuntimeTaskRunner: AgentRuntimeTaskRunner | null = null;",
      "void _agentRuntimeTaskRunner;",
    ].join("\n"),
  );
  run(process.execPath, [
    join(rootDir, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "-p",
    join(tempDir, "tsconfig.json"),
  ], { cwd: tempDir });
  validated = true;
} finally {
  if (tarball && !(retainValidatedTarball && validated)) {
    await rm(tarball, { force: true });
  }
  await rm(tempDir, { recursive: true, force: true }).catch(async (error) => {
    if (tarball && retainValidatedTarball && validated) {
      await rm(tarball, { force: true });
    }
    throw error;
  });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    try {
      if (retainValidatedTarball && tarball) rmSync(tarball, { force: true });
    } finally {
      process.exit(result.status ?? 1);
    }
  }
}

function parseNpmPackJson(output) {
  const trimmed = output.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  return JSON.parse(jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1));
}
