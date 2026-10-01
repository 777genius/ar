import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { AgentRuntimeTool, AgentRuntimeAccessBoundary, ChildContinuationMode, ChildExecutionBudget,
  DefaultRedactor, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { AppServerExecutionLifetime, CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import type { CodexAppServerChildProcess } from "../../app-server/application/app-server-process-port";
import { StaticRunner } from "../codex-provider-test-support";

type Request = { id: number; method: string };
async function fixture(kind: "ordinary" | "child" | "controller") {
  const root = await mkdtemp(join(tmpdir(), "TEST-completion-pipe-"));
  let child: ChildProcess | undefined;
  const requests: Request[] = [];
  const abort = new AbortController();
  const childBudget = kind === "child" ? new ChildExecutionBudget(parseChildLifetime({ schemaVersion: 1,
    accountId: "TEST-account", deadlineEpochMs: Date.now() + 5000, maxGoalTurns: 2, maxAccountCycles: 1,
    maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled, denyProjectInstructions: true,
    accessBoundary: AgentRuntimeAccessBoundary.ReadOnly, allowedTools: [AgentRuntimeTool.ReadFile] })) : undefined;
  const executionLifetime = kind === "controller" ? new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 5000,
    maxGoalTurns: 2, binding: { allocationId: "TEST-allocation", incarnationId: "TEST-incarnation" }, onReadiness: () => {} }) : undefined;
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/completion-peer", sourceEnv: {},
    ...(childBudget ? { childBudget } : {}), ...(executionLifetime ? { executionLifetime } : {}),
    goalMode: kind !== "ordinary", maxGoalTurns: 2, nativeToolSurface: "disabled", cleanThreadPrewarm: false,
    processFactory: () => {
      child = fork(fileURLToPath(new URL("./completion-pipe-peer.mjs", import.meta.url)), [], {
        env: { TEST_ROOT: root }, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
      child.on("message", (message: { request: Request }) => { if (message.request.method) requests.push(message.request); });
      return child as unknown as CodexAppServerChildProcess;
    } });
  const next = async (method: string) => {
    await vi.waitFor(() => expect(requests.some(r => r.method === method)).toBe(true), { timeout: 1500, interval: 5 });
    return requests.find(r => r.method === method)!;
  };
  const burst = (messages: unknown[]) => child!.send({ burst: messages });
  const reply = (request: Request, result: unknown) => burst([{ id: request.id, result }]);
  const run = engine.run({ prompt: "TEST objective", model: "TEST-model", reasoningEffort: "low", workspacePath: root,
    session: { home: root, codexHome: root, env: {}, release: async () => {} }, runner: new StaticRunner(""),
    redactor: new DefaultRedactor(), abortSignal: abort.signal });
  // Observe rejections while driving the peer so failed bounded runs cannot
  // become unhandled rejections before the assertion awaits them.
  void run.catch(() => {});
  reply(await next("initialize"), {});
  reply(await next("thread/start"), { thread: { id: "TEST-thread" } });
  if (kind !== "ordinary") reply(await next("thread/goal/set"), {
    goal: { threadId: "TEST-thread", objective: "TEST objective", status: "active" } });
  const turn = await next("turn/start");
  return { run, abort, requests, child: child!, complete: (completed = true) => burst([
    { id: turn.id, result: { turn: { id: "TEST-turn" } } },
    { method: "item/agentMessage/delta", params: { threadId: "TEST-thread", turnId: "TEST-turn", delta: "TEST complete" } },
    ...(completed ? [{ method: "turn/completed", params: { threadId: "TEST-thread", turn: { id: "TEST-turn", status: "completed" } } }] : []),
  ]), clean: async () => { vi.restoreAllMocks(); await engine.dispose().catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true }); } };
}

it("ordinary completed wire burst wins over cancellation before its continuation", async () => {
  const f = await fixture("ordinary");
  try {
    f.child.stdout!.on("data", () => f.abort.abort(new Error("TEST abort after delivered completion")));
    f.complete();
    expect((await f.run).outputText).toBe("TEST complete");
  } finally { await f.clean(); }
});

it("ordinary cancellation after an incomplete wire burst still rejects", async () => {
  const f = await fixture("ordinary");
  try {
    f.child.stdout!.on("data", () => f.abort.abort(new Error("TEST abort before completion")));
    f.complete(false);
    await expect(f.run).rejects.toThrow(/aborted/);
  } finally { await f.clean(); }
});

it.each(["child", "controller"] as const)("%s completed wire burst cannot bypass its abort fence", async kind => {
  const f = await fixture(kind);
  try {
    f.child.stdout!.on("data", () => f.abort.abort(new Error("TEST bounded cancellation")));
    f.complete();
    await expect(f.run).rejects.toThrow();
    expect(f.requests.some(r => r.method === "thread/goal/get")).toBe(false);
    expect(f.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
  } finally { await f.clean(); }
});

it("bounded completed wire burst cannot bypass expiry before its continuation", async () => {
  const f = await fixture("controller");
  try {
    const wall = Date.now();
    f.child.stdout!.on("data", () => vi.spyOn(Date, "now").mockReturnValue(wall + 10_000));
    f.complete();
    await expect(f.run).rejects.toThrow(/deadline_expired/);
    expect(f.requests.some(r => r.method === "thread/goal/get")).toBe(false);
  } finally { await f.clean(); }
});
