import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentRuntimeTool, AgentRuntimeAccessBoundary, ChildContinuationMode, ChildExecutionBudget,
  DefaultRedactor, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { AppServerExecutionLifetime, CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { CodexJsonAgentDriver } from "../../codex-json-agent-driver";
import { CodexModelBackend } from "../../codex-model-backend";
import { StaticRunner } from "../codex-provider-test-support";

// Relative directory operations can create and later remove a real owned tree
// whose absolute paths exceed PATH_MAX. Node's recursive rm fails on that tree.
function deepTree(root: string, remove = false): void {
  const script = `const fs = require('node:fs'); const name = 'TEST-' + 'x'.repeat(95);
    for (let i = 0; i < 48; i++) { ${remove ? "" : "fs.mkdirSync(name);"} process.chdir(name); }
    ${remove ? "for (let i = 0; i < 48; i++) { process.chdir('..'); fs.rmdirSync(name); }" : ""}`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env: {} });
  expect(result.status, result.stderr.toString()).toBe(0);
}

it.each(["child", "controller", "ordinary"] as const)("%s MiMo unused local cleanup preserves its disposal contract on real rm failure", async kind => {
  const root = await mkdtemp(join(tmpdir(), "TEST-mimo-unused-cleanup-"));
  let owned: string | undefined, starts = 0, materializerDisposals = 0;
  const childBudget = kind === "child" ? new ChildExecutionBudget(parseChildLifetime({ schemaVersion: 1,
    accountId: "TEST-account", deadlineEpochMs: Date.now() + 10_000, maxGoalTurns: 2, maxAccountCycles: 1,
    maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled, denyProjectInstructions: true,
    accessBoundary: AgentRuntimeAccessBoundary.ReadOnly, allowedTools: [AgentRuntimeTool.ReadFile] })) : undefined;
  const executionLifetime = kind === "controller" ? new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 10_000,
    maxGoalTurns: 2, binding: { allocationId: "TEST-allocation", incarnationId: "TEST-incarnation" }, onReadiness: () => {} }) : undefined;
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/never-start", sourceEnv: {}, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    ...(childBudget ? { childBudget } : {}), ...(executionLifetime ? { executionLifetime } : {}),
    goalMode: true, maxGoalTurns: 2, cleanThreadPrewarm: false, nativeToolSurface: "disabled",
    processFactory: () => { starts++; throw new Error("TEST unexpected provider submission"); } });
  const driver = new CodexJsonAgentDriver({ engine, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    sourceEnv: { TMPDIR: root, MIMO_TEST_KEY: "TEST-unused-fake-key" }, mimoApiKeyEnvVarName: "MIMO_TEST_KEY",
    sessionMaterializer: { mode: "ephemeral", materialize: async () => { throw new Error("TEST unused"); },
      dispose: async () => { materializerDisposals++; } } });
  try {
    const result = await driver.runTask({ session: null, task: { kind: "structured-prompt", prompt: "TEST unused" },
      workspace: { path: root }, runner: new StaticRunner(""), redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal, onTaskStarted: async () => {
        const names = await readdir(root);
        expect(names).toHaveLength(1);
        owned = join(root, names[0]!);
        deepTree(owned);
        throw new Error("TEST fail before provider submission");
      } });
    expect(result.status).toBe("failed");
    expect(starts).toBe(0);
    expect(owned).toBeDefined();
    await expect(rm(owned!, { recursive: true, force: true })).rejects.toMatchObject({ code: "ENAMETOOLONG" });
    if (kind === "ordinary") {
      await driver.dispose();
      expect(materializerDisposals).toBe(1);
    } else {
      await vi.waitFor(async () => { await expect(driver.dispose()).rejects.toMatchObject({ code: "ENAMETOOLONG" }); });
      await expect(driver.dispose()).rejects.toMatchObject({ code: "ENAMETOOLONG" });
      expect(materializerDisposals).toBe(0);
    }
    await access(owned!);
    expect(starts).toBe(0);
    deepTree(owned!, true);
    if (kind !== "ordinary") {
      await driver.dispose();
      await expect(access(owned!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(materializerDisposals).toBe(1);
    }
  } finally {
    if (owned) {
      // Only the TEST tree above is owned by this fixture.
      try { deepTree(owned, true); } catch { /* already removed */ }
    }
    await driver.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
