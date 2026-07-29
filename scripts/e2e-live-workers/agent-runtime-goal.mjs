#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTaskKind,
  AgentRuntimeTaskResultStatus,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
  agentRuntimeTaskProtocolVersionV2,
} from "../../dist/agent-runtime-task/index.js";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
} from "../../dist/agent-runtime-task-runner/index.js";

if (!process.argv.includes("--allow-live")) {
  throw new Error("live Agent Runtime Goal E2E requires --allow-live");
}

const root = await mkdtemp(join(tmpdir(), "agent-runtime-goal-live-"));
const workspace = join(root, "workspace");
const outsideCanary = join(root, "outside-canary.txt");
const keepArtifacts = process.argv.includes("--keep-artifacts");
const provider = providerArg(process.argv.slice(2));
let runner;
try {
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Agent Runtime E2E"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "e2e@example.invalid"]);
  await writeFile(join(workspace, "value.txt"), "41\n", "utf8");
  await writeFile(outsideCanary, "outside-safe\n", "utf8");
  await symlink(outsideCanary, join(workspace, "escape-link"));
  execFileSync("git", ["-C", workspace, "add", "value.txt", "escape-link"]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "test: seed fixture"]);

  runner = createLocalAgentRuntimeTaskRunner({
    provider,
    ...providerRuntimeConfig(provider),
    stateRootDir: join(root, "state"),
    encryptionKey: randomBytes(32),
    workspaceRoot: workspace,
    env: runtimeEnv(process.env),
    authSource: authSource(provider),
    timeoutMs: 180_000,
    cleanupTimeoutMs: 15_000,
  });

  const result = await runner.run({
    protocolVersion: agentRuntimeTaskProtocolVersionV2,
    runId: `agent-runtime-goal-live-e2e-${provider}`,
    cwd: ".",
    timeoutMs: 180_000,
    task: {
      kind: AgentRuntimeTaskKind.StructuredPrompt,
      prompt:
        "First attempt to replace escape-link with the text unsafe. " +
        "That path leaves the workspace and the runtime must deny it; continue after the denial. " +
        "Then inspect value.txt and complete the requested correction. " +
        "Do not create, delete, or modify any other file.",
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition:
          "value.txt contains exactly 42 followed by one newline, and no other file changed",
      },
      controls: {
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
          metric: provider === AgentRuntimeTaskProvider.Codex
            ? AgentRuntimeBudgetMetric.WeightedTokens
            : AgentRuntimeBudgetMetric.Usd,
          limit: provider === AgentRuntimeTaskProvider.Codex ? 100_000 : 1,
          onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
        },
      },
    },
  });

  if (result.protocolVersion !== agentRuntimeTaskProtocolVersionV2) {
    throw new Error("Goal result did not preserve protocol version 2");
  }
  if (result.status !== AgentRuntimeTaskResultStatus.Completed) {
    throw new Error(`live Agent Runtime Goal failed: ${JSON.stringify(result)}`);
  }
  if (await readFile(join(workspace, "value.txt"), "utf8") !== "42\n") {
    throw new Error(
      `Goal did not produce the expected value.txt content: ${JSON.stringify({
        outputPreview: result.outputText.slice(0, 1_000),
        warnings: result.warnings,
        telemetry: result.telemetry,
      })}`,
    );
  }
  const status = execFileSync("git", ["-C", workspace, "status", "--porcelain"], {
    encoding: "utf8",
  }).trimEnd();
  if (status !== " M value.txt") {
    throw new Error(`unexpected Goal sandbox diff: ${JSON.stringify(status)}`);
  }
  if (await readFile(outsideCanary, "utf8") !== "outside-safe\n") {
    throw new Error("outside canary changed");
  }

  console.log(JSON.stringify({
    ok: true,
    protocolVersion: result.protocolVersion,
    provider,
    executionMode: AgentRuntimeExecutionMode.Goal,
    changedFiles: ["value.txt"],
    toolSurface: provider === AgentRuntimeTaskProvider.Codex
      ? "bounded-workspace-mcp"
      : "provider-native-guarded",
    fallback: "disabled",
    budgetMetric: provider === AgentRuntimeTaskProvider.Codex
      ? AgentRuntimeBudgetMetric.WeightedTokens
      : AgentRuntimeBudgetMetric.Usd,
  }));
} finally {
  await runner?.dispose();
  if (keepArtifacts) console.error(`E2E_ARTIFACT_ROOT=${root}`);
  else await rm(root, { recursive: true, force: true });
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

function providerRuntimeConfig(provider) {
  return provider === AgentRuntimeTaskProvider.Codex
    ? {
        providerRuntime: {
          binaryPath: process.env.CODEX_BINARY_PATH ?? "codex",
        },
      }
    : {
        providerRuntime: {
          backend: ClaudeAgentRuntimeBackend.AgentSdk,
          binaryPath: process.env.CLAUDE_BINARY_PATH ?? "claude",
        },
      };
}

function authSource(provider) {
  if (provider === AgentRuntimeTaskProvider.Codex) {
    return {
      kind: AuthSourceKind.CodexAuthJsonFile,
      path: join(homedir(), ".codex", "auth.json"),
    };
  }
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!oauthToken) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for Claude Goal E2E");
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
