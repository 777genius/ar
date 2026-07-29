#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeCostCurrency,
  AgentRuntimeTaskKind,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
} from "../../dist/agent-runtime-task/index.js";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  createLocalAgentRuntimeTaskRunner,
} from "../../dist/agent-runtime-task-runner/index.js";

if (!process.argv.includes("--allow-live")) {
  throw new Error("live Agent Runtime task E2E requires --allow-live");
}

const root = await mkdtemp(join(tmpdir(), "agent-runtime-task-live-"));
const workspace = join(root, "workspace");
const outsideCanary = join(root, "outside-canary.txt");
const keepArtifacts = process.argv.includes("--keep-artifacts");
let runner;
try {
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Agent Runtime E2E"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "e2e@example.invalid"]);
  await writeFile(join(workspace, "value.txt"), "41\n", "utf8");
  await writeFile(outsideCanary, "outside-safe\n", "utf8");
  execFileSync("git", ["-C", workspace, "add", "value.txt"]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "test: seed fixture"]);

  runner = createLocalAgentRuntimeTaskRunner({
    provider: AgentRuntimeTaskProvider.Claude,
    stateRootDir: join(root, "state"),
    encryptionKey: randomBytes(32),
    workspaceRoot: workspace,
    env: runtimeEnv(process.env),
    authSource: {
      kind: AuthSourceKind.ClaudeOAuthToken,
      oauthToken: claudeOAuthToken(),
    },
    timeoutMs: 120_000,
  });

  const result = await runner.run({
    protocolVersion: 1,
    runId: "agent-runtime-task-live-e2e",
    cwd: ".",
    timeoutMs: 120_000,
    task: {
      kind: AgentRuntimeTaskKind.StructuredPrompt,
      prompt:
        "Edit value.txt so its complete content is exactly 42 followed by a newline. " +
        "Do not create, delete, or modify any other file.",
      controls: {
        maxTurns: 8,
        accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        toolPolicy: {
          allow: [
            AgentRuntimeTool.ReadFile,
            AgentRuntimeTool.EditFile,
            AgentRuntimeTool.WriteFile,
          ],
          deny: [
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
          metric: AgentRuntimeBudgetMetric.Usd,
          limit: 1,
          onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
        },
      },
    },
  });

  if (result.status !== "completed") {
    throw new Error(
      `live Agent Runtime task failed: ${JSON.stringify(result.failure)}`,
    );
  }
  const content = await readFile(join(workspace, "value.txt"), "utf8");
  if (content !== "42\n") {
    throw new Error(`unexpected value.txt content: ${JSON.stringify(content)}`);
  }
  const status = execFileSync("git", ["-C", workspace, "status", "--porcelain"], {
    encoding: "utf8",
  }).trimEnd();
  if (status !== " M value.txt") {
    throw new Error(`unexpected sandbox diff: ${JSON.stringify(status)}`);
  }
  if (await readFile(outsideCanary, "utf8") !== "outside-safe\n") {
    throw new Error("outside canary changed");
  }
  if (
    result.telemetry?.cost?.currency === AgentRuntimeCostCurrency.Usd &&
    result.telemetry.cost.amount > 1
  ) {
    throw new Error("provider reported cost above the requested hard limit");
  }

  console.log(JSON.stringify({
    ok: true,
    provider: AgentRuntimeTaskProvider.Claude,
    changedFiles: ["value.txt"],
    turns: result.telemetry?.turns ?? null,
    costUsd: result.telemetry?.cost?.amount ?? null,
  }));
} finally {
  await runner?.dispose();
  if (keepArtifacts) console.error(`E2E_ARTIFACT_ROOT=${root}`);
  else await rm(root, { recursive: true, force: true });
}

function claudeOAuthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const raw = execFileSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8" },
  );
  const credentials = JSON.parse(raw);
  const token = credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Claude OAuth token is unavailable");
  }
  return token;
}

function runtimeEnv(source) {
  return Object.fromEntries(
    ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"]
      .flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}
