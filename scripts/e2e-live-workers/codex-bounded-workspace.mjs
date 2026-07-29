#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
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
  throw new Error("live bounded Codex E2E requires --allow-live");
}

const root = await mkdtemp(join(tmpdir(), "agent-runtime-codex-bounded-live-"));
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
    provider: AgentRuntimeTaskProvider.Codex,
    providerRuntime: {
      binaryPath: process.env.CODEX_BINARY_PATH ?? "codex",
    },
    stateRootDir: join(root, "state"),
    encryptionKey: randomBytes(32),
    workspaceRoot: workspace,
    env: runtimeEnv(process.env),
    authSource: {
      kind: AuthSourceKind.CodexAuthJsonFile,
      path: join(homedir(), ".codex", "auth.json"),
    },
    timeoutMs: 120_000,
  });

  const result = await runner.run({
    protocolVersion: 1,
    runId: "agent-runtime-codex-bounded-live-e2e",
    cwd: ".",
    timeoutMs: 120_000,
    task: {
      kind: AgentRuntimeTaskKind.StructuredPrompt,
      prompt:
        "Read value.txt, then replace its complete content with exactly 42 followed by a newline. " +
        "Do not modify any other file.",
      controls: {
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
          metric: AgentRuntimeBudgetMetric.WeightedTokens,
          limit: 100_000,
          onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
        },
      },
    },
  });

  if (result.status !== "completed") {
    throw new Error(`live bounded Codex task failed: ${JSON.stringify(result.failure)}`);
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

  console.log(JSON.stringify({
    ok: true,
    provider: AgentRuntimeTaskProvider.Codex,
    changedFiles: ["value.txt"],
    nativeTools: "disabled",
    fallback: "disabled",
    budgetMetric: AgentRuntimeBudgetMetric.WeightedTokens,
  }));
} finally {
  await runner?.dispose();
  if (keepArtifacts) console.error(`E2E_ARTIFACT_ROOT=${root}`);
  else await rm(root, { recursive: true, force: true });
}

function runtimeEnv(source) {
  return Object.fromEntries(
    ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"]
      .flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}
