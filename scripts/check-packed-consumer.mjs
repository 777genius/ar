#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
      "import { agentTask, agentRuntimeTask, agentRuntimeTaskRunner } from '@vioxen/subscription-runtime';",
      "import { createSubscriptionRuntime } from '@vioxen/subscription-runtime/core';",
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
      "import { agentTask, agentRuntimeTask, agentRuntimeTaskRunner } from '@vioxen/subscription-runtime';",
      "import { createSubscriptionRuntime, DefaultRedactor, type RunnerPort } from '@vioxen/subscription-runtime/core';",
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
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(tempDir, { recursive: true, force: true });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseNpmPackJson(output) {
  const trimmed = output.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  return JSON.parse(jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1));
}
