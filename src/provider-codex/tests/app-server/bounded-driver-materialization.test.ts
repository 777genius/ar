import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeTool, AgentRuntimeAccessBoundary, ChildContinuationMode, ChildExecutionBudget,
  DefaultRedactor, parseChildLifetime, type SessionArtifact } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { CodexJsonAgentDriver } from "../../codex-json-agent-driver";
import type { CodexMaterializedSession } from "../../codex-json-execution-engine";
import type { CodexSessionMaterializer } from "../../codex-session-materializer";
import { ControlledPeer } from "./controlled-readiness-peer";
import { StaticRunner } from "../codex-provider-test-support";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(sourceEnv?: Readonly<Record<string, string | undefined>>) {
  const root = await mkdtemp(join(tmpdir(), "C3-A-TEST-materialization-"));
  const resource = join(root, "TEST-resource");
  await writeFile(resource, "TEST-owned-resource");
  const materialization = deferred<CodexMaterializedSession>();
  const peer = new ControlledPeer();
  let submissions = 0, started = 0, releases = 0, materializerDisposals = 0;
  const budget = new ChildExecutionBudget(parseChildLifetime({ schemaVersion: 1, accountId: "TEST-account",
    deadlineEpochMs: Date.now() + 1_000, maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1,
    continuationMode: ChildContinuationMode.Disabled, denyProjectInstructions: true,
    accessBoundary: AgentRuntimeAccessBoundary.ReadOnly, allowedTools: [AgentRuntimeTool.ReadFile] }));
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/controlled-peer", childBudget: budget,
    goalMode: true, maxGoalTurns: 2, cleanThreadPrewarm: false, nativeToolSurface: "disabled",
    timeoutMs: 10_000, processFactory: () => { submissions++; return peer; } });
  const session: CodexMaterializedSession = { home: root, codexHome: root, env: { TEST_VALUE: "TEST" },
    release: async () => { releases++; await rm(resource); } };
  const materializer: CodexSessionMaterializer = { mode: "ephemeral", materialize: () => materialization.promise,
    dispose: async () => { materializerDisposals++; } };
  const driver = new CodexJsonAgentDriver({ engine, sessionMaterializer: materializer, ...(sourceEnv ? { sourceEnv } : {}) });
  const artifact: SessionArtifact = { kind: "opaque-bytes", providerId: "codex", formatVersion: "TEST",
    bytes: new Uint8Array(), contentType: "application/octet-stream" };
  const abort = new AbortController();
  const input = { session: artifact, task: { kind: "structured-prompt" as const, prompt: "TEST goal" },
    workspace: { path: root }, redactor: new DefaultRedactor(), runner: new StaticRunner(""),
    abortSignal: abort.signal, onTaskStarted: () => { started++; } };
  return { root, resource, materialization, session, peer, driver, input, abort,
    submissions: () => submissions, started: () => started, releases: () => releases,
    materializerDisposals: () => materializerDisposals,
    clean: async () => { await driver.dispose().catch(() => undefined); await rm(root, { recursive: true, force: true }); } };
}

afterEach(() => vi.useRealTimers());
describe("driver retains owned startup and resource continuations", () => {
  // Existing API only: old base waits forever for materialization despite the
  // original child deadline. This assertion observes promise settlement.
  it("bounds deferred materialization before startup and fences its late result", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      let settled = false;
      const result = f.driver.runTask(f.input).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(settled).toBe(true);
      expect((await result).status).toBe("failed");
      expect(f.submissions()).toBe(0);
      expect(f.started()).toBe(0);
      await expect(f.driver.dispose()).rejects.toThrow("materialization_pending");
      expect(f.materializerDisposals()).toBe(0);
      expect(await readFile(f.resource, "utf8")).toBe("TEST-owned-resource");
      f.materialization.resolve(f.session);
      await vi.waitFor(() => expect(f.releases()).toBe(1));
      await f.driver.dispose();
      expect(f.submissions()).toBe(0);
      expect(f.started()).toBe(0);
      expect(f.materializerDisposals()).toBe(1);
    } finally { await f.clean(); }
  });

  it("abort also bounds materialization and retains disposal ownership until late release", async () => {
    const f = await fixture();
    try {
      const result = f.driver.runTask(f.input);
      f.abort.abort(new Error("TEST cancellation"));
      expect((await result).status).toBe("failed");
      await expect(f.driver.dispose()).rejects.toThrow("materialization_pending");
      f.materialization.resolve(f.session);
      await vi.waitFor(() => expect(f.releases()).toBe(1));
      await f.driver.dispose();
      expect(f.submissions()).toBe(0);
    } finally { await f.clean(); }
  });

  // Old base deletes the resource in runTask finally while its peer remains
  // alive. This checks a real file, rather than mirroring a retention flag.
  it("natural completion retains resources until execution disposal finishes", async () => {
    const f = await fixture();
    try {
      const result = f.driver.runTask(f.input);
      f.materialization.resolve(f.session);
      await f.peer.initialize(); await f.peer.thread(); await f.peer.activate(); await f.peer.finish();
      expect((await result).status).toBe("completed");
      expect(f.peer.ended).toBe(false);
      expect(await readFile(f.resource, "utf8")).toBe("TEST-owned-resource");
      expect(f.releases()).toBe(0);
      await f.driver.dispose();
      expect(f.peer.ended).toBe(true);
      expect(f.releases()).toBe(1);
      await expect(readFile(f.resource)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.clean(); }
  });

  it("failed transport disposal and unproven exit preserve resources and deny restart", async () => {
    const f = await fixture();
    try {
      const result = f.driver.runTask(f.input);
      f.materialization.resolve(f.session);
      await f.peer.initialize(); await f.peer.thread(); await f.peer.activate(); await f.peer.finish(); await result;
      f.peer.stdin.end = () => { queueMicrotask(() => f.peer.emit("error", new Error("TEST cleanup observation failure"))); };
      f.peer.kill = () => true;
      await expect(f.driver.dispose()).rejects.toThrow(/cleanup_failed|dispose_failed/);
      expect(await readFile(f.resource, "utf8")).toBe("TEST-owned-resource");
      expect(f.materializerDisposals()).toBe(0);
      f.peer.emit("exit", 0, null);
      await expect(f.driver.dispose()).rejects.toThrow("cleanup_failed");
      expect(await readFile(f.resource, "utf8")).toBe("TEST-owned-resource");
      expect(f.releases()).toBe(0);
      expect((await f.driver.runTask(f.input)).status).toBe("failed");
      expect(f.submissions()).toBe(1);
    } finally { await f.clean(); }
  });

  it("disposal during materialization cannot report success or start a late peer", async () => {
    const f = await fixture();
    try {
      const result = f.driver.runTask(f.input);
      await expect(f.driver.dispose()).rejects.toThrow("materialization_pending");
      expect((await result).status).toBe("failed");
      f.materialization.resolve(f.session);
      await vi.waitFor(() => expect(f.releases()).toBe(1));
      await f.driver.dispose();
      expect(f.submissions()).toBe(0);
    } finally { await f.clean(); }
  });
  it("bounds an independently stalled task-start callback and performs no provider submission", async () => {
    vi.useFakeTimers();
    const f = await fixture(), callback = deferred<void>(), entered = deferred<void>();
    try {
      const result = f.driver.runTask({ ...f.input, onTaskStarted: () => { entered.resolve(); return callback.promise; } });
      f.materialization.resolve(f.session);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_001);
      expect((await result).status).toBe("failed");
      callback.resolve();
      await Promise.resolve();
      expect(f.submissions()).toBe(0);
      expect(f.releases()).toBe(1);
      await vi.waitFor(async () => { await expect(readFile(f.resource)).rejects.toMatchObject({ code: "ENOENT" }); });
      await f.driver.dispose();
    } finally { await f.clean(); }
  });

  it("returns at expiry even when releasing unused materialized resources stalls", async () => {
    vi.useFakeTimers();
    const f = await fixture(), release = deferred<void>(), entered = deferred<void>();
    try {
      const session = { ...f.session, release: async () => { entered.resolve(); await release.promise; await f.session.release(); } };
      const callback = deferred<void>(), started = deferred<void>();
      const result = f.driver.runTask({ ...f.input, onTaskStarted: () => { started.resolve(); return callback.promise; } });
      f.materialization.resolve(session);
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_001);
      expect((await result).status).toBe("failed");
      await entered.promise;
      expect(await readFile(f.resource, "utf8")).toBe("TEST-owned-resource");
      await expect(f.driver.dispose()).rejects.toThrow("materialization_pending");
      release.resolve(); callback.resolve();
      await vi.waitFor(() => expect(f.releases()).toBe(1));
      await f.driver.dispose();
      expect(f.submissions()).toBe(0);
    } finally { await f.clean(); }
  });

  it("retains hosted resources after successful local disposal without claiming scoped proof", async () => {
    const f = await fixture({ SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" });
    try {
      const result = f.driver.runTask(f.input);
      f.materialization.resolve(f.session);
      await f.peer.initialize(); await f.peer.thread(); await f.peer.activate(); await f.peer.finish();
      expect((await result).status).toBe("completed");
      await expect(f.driver.dispose()).rejects.toThrow("hosted_cleanup_unresolved");
      expect(f.peer.ended).toBe(true);
      expect(await readFile(f.resource, "utf8")).toBe("TEST-owned-resource");
      expect(f.releases()).toBe(0);
      await expect(f.driver.dispose()).rejects.toThrow("hosted_cleanup_unresolved");
      expect(f.submissions()).toBe(1);
    } finally { await f.clean(); }
  });

});
