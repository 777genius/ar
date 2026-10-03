import "./absent-host-readonly-authority-fixture";
import "./absent-host-scratch-fixture";
import { AgentRuntimeTool, ChildContinuationMode } from "@vioxen/subscription-runtime/core";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { runCodexGoalCli, parseCodexGoalCliArgs } from "../codex-goal-cli";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildForegroundTestProcess } from "./child-foreground-process-test-support";

const processFixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: processFixture.spawn,
}));
afterEach(() => { vi.restoreAllMocks(); processFixture.spawn.mockReset(); });

const sentinel = "synthetic-pr3-provider-only-key-418273";
async function fixture(mode: Parameters<typeof createChildForegroundTestProcess>[0]["mode"] = "unfinished", deadlineMs = 10000) {
  const root = await mkdtemp(join(tmpdir(), "pr3-TEST-private-registry-"));
  const job = join(root, "jobs", "test-child"), workspace = join(job, "workspace");
  await mkdir(workspace, { recursive: true });
  const prompt = join(root, "private-prompt.md"), transport = join(root, "fake-app-server.ts"), log = join(root, "transport.jsonl");
  const resource = join(root, "TEST-provider-heartbeat");
  await writeFile(prompt, "Leave this goal unfinished. Return a short progress message.\n");
  const lifetime = { schemaVersion: 1, accountId: "account-s", deadlineEpochMs: Date.now() + deadlineMs,
    maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled,
    denyProjectInstructions: true, accessBoundary: AccessBoundary.ReadOnly,
    allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles] };
  const fake = createChildForegroundTestProcess({ mode, log, resource, sentinel });
  processFixture.spawn.mockImplementation((command: string, args: string[], options: { env: Record<string, string> }) => {
    expect(command).toBe(transport);
    expect(args[0]).toBe("app-server");
    fake.start(options.env);
    return fake.child;
  });
  const argv = ["run", "--no-tmux", "--registry-root", join(root, "private-registry"), "--job-root", job, "--auth-root", join(job, "capacity"),
    "--workspace", workspace, "--prompt", prompt, "--task-id", "test-child", "--job-id", "test-child",
    "--accounts", "account-s", "--model-backend", "xiaomi-mimo-token-plan", "--model", "mimo-v2.6-pro",
    "--execution-engine", "app-server-goal", "--max-account-cycles", "1", "--max-attempts", "1",
    "--continuation-mode", "disabled", "--max-goal-turns", "2", "--child-lifetime-json", JSON.stringify(lifetime),
    "--edit-mode", "read-only", "--access-boundary", "read_only", "--network-access", "restricted", "--project-access-scope-json", JSON.stringify({ projectId: "test-child", readRoots: [workspace] }),
    "--codex-binary", transport, "--no-require-git-workspace", "--format", "json"];
  const output: string[] = [];
  const io = { cwd: () => root, env: () => ({ SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START: "1", PATH: process.env.PATH, MIMO_TOKEN_PLAN_API_KEY: sentinel }),
    writeStdout: (s: string) => output.push(s), writeStderr: (s: string) => output.push(s) };
  return { root, argv, io, output, lifetime, log, resource, fake,
    rows: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    close: () => rm(root, { recursive: true, force: true }) };
}

describe("production foreground child lifetime", () => {
  // Bug: slice exhaustion starts another foreground invocation/account cycle with a fresh N.
  it("runs real CLI -> runner -> executor -> factory -> client; N=2 never submits N+1", async () => {
    const f = await fixture();
    try {
      const status = await runCodexGoalCli(f.argv, f.io); expect(status, f.output.join("")).toBe(1);
      expect(JSON.parse(f.output.at(-1)!).attempts).toHaveLength(1);
      expect(JSON.parse(f.output.at(-1)!).reason).toBe("budget_exceeded");
      const rows = await f.rows();
      expect(rows.filter(r => r.method === "turn/start")).toHaveLength(2);
      expect(rows.filter(r => r.method === "thread/start")).toHaveLength(1);
      expect(rows.filter(r => r.type === "provider-start")).toEqual([{ type: "provider-start", sentinelSeen: true }]);
      expect(rows.filter(r => r.type === "cleanup-request")).toHaveLength(1);
      await expectProviderCleanedUp(f, rows);
      const starts = rows.filter(r => r.method === "turn/start" || r.method === "thread/start");
      for (const start of starts) expect(start.params.environments).toEqual([]);
      expect(starts.find(r => r.method === "thread/start")?.params.dynamicTools).toEqual([]);
      expect(f.output.join("")).not.toContain(sentinel);
      const files = await allFiles(f.root);
      expect(files.filter(p => p.endsWith("auth.json"))).toEqual([]);
      for (const p of files) expect(await readFile(p, "utf8")).not.toContain(sentinel);
    } finally { await f.close(); }
  });
  // Bug: a retryable provider failure consumes another account cycle/attempt/thread.
  it("does not retry a retryable first turn failure", async () => {
    const f = await fixture("retryable");
    try {
      const status = await runCodexGoalCli(f.argv, f.io); expect(status, f.output.join("")).toBe(1);
      expect(JSON.parse(f.output.at(-1)!).attempts).toHaveLength(1);
      const rows = await f.rows();
      expect(rows.filter(r => r.type === "provider-start")).toHaveLength(1);
      expect(rows.filter(r => r.method === "thread/start")).toHaveLength(1);
      expect(rows.filter(r => r.method === "turn/start")).toHaveLength(1);
      await expectProviderCleanedUp(f, rows);
      expect(rows.filter(r => r.method === "thread/goal/get")).toHaveLength(0);
    } finally { await f.close(); }
  });
  // Bug: a grant already expired during parsing still starts a provider.
  it("starts nothing for an expired grant", async () => {
    const f = await fixture("unfinished", -1);
    try { const status = await runCodexGoalCli(f.argv, f.io); expect(status, f.output.join("")).toBe(2); expect(await f.rows()).toEqual([]); }
    finally { await f.close(); }
  });
  // Bug: delayed start acknowledgment receives a fresh full wait timeout and revives late work.
  it("expires during the wait and requests scoped cleanup", async () => {
    const f = await fixture("delayed", 900);
    try {
      const status = await runCodexGoalCli(f.argv, f.io); expect(status, f.output.join("")).toBe(1);
      const rows = await f.rows();
      expect(JSON.parse(f.output.at(-1)!).attempts).toHaveLength(1);
      expect(rows.filter(r => r.type === "provider-start")).toHaveLength(1);
      expect(rows.filter(r => r.method === "thread/start")).toHaveLength(1);
      expect(rows.filter(r => r.method === "turn/start")).toHaveLength(1);
      const acknowledgments = rows.filter(r => r.type === "turn-start-ack");
      expect(acknowledgments).toHaveLength(1);
      expect(acknowledgments[0].at).toBeLessThan(f.lifetime.deadlineEpochMs);
      await expectProviderCleanedUp(f, rows);
      expect(rows.filter(r => r.method === "thread/goal/get")).toHaveLength(0);
    } finally { await f.close(); }
  });
  // Bug: effective defaults and overrides weaken a matching lifetime flag.
  it.each([["--max-account-cycles", "5"], ["--max-attempts", "2"], ["--continuation-mode", "packet_first"],
    ["--accounts", "account-q"], ["--max-goal-turns", "3"], ["--access-boundary", "isolated_workspace_write"],
    ["--edit-mode", "allow-edits"], ["--prewarm", undefined]])("rejects %s conflict before start", async (flag, value) => {
    const f = await fixture();
    try {
      const args = [...f.argv]; const at = args.indexOf(flag);
      if (at >= 0) args.splice(at, 2);
      args.push(flag!); if (value !== undefined) args.push(value);
      expect(() => parseCodexGoalCliArgs(args, f.io)).toThrow();
      expect(await f.rows()).toEqual([]);
    } finally { await f.close(); }
  });
  // Bug: omitting a bound flag silently selects the five-cycle/continuation defaults.
  it.each(["--max-account-cycles", "--max-attempts", "--continuation-mode", "--max-goal-turns"])("rejects missing %s before provider start", async flag => {
    const f = await fixture();
    try {
      const args = [...f.argv]; args.splice(args.indexOf(flag), 2);
      expect(() => parseCodexGoalCliArgs(args, f.io)).toThrow("child_effective_confinement_conflict");
      expect(await f.rows()).toEqual([]);
    } finally { await f.close(); }
  });
  // Bug: per-run safe policy and task control overrides can reopen attempts, accounts or tools after CLI validation.
  it("revalidates resolved executor options and per-run overrides", async () => {
    const f = await fixture();
    try {
      const parsed = parseCodexGoalCliArgs(f.argv, f.io);
      if (parsed.kind !== "run") throw new Error("expected production run command");
      const options = buildCodexGoalExecutorOptions({ config: parsed.config, stateRootDir: join(f.root, "state"), encryptionKey: new Uint8Array(32) });
      for (const changed of [{ maxAccountCycles: undefined }, { safeExecutionPolicy: { maxAttempts: 2, continuationMode: "disabled" as const } },
        { accounts: [...options.accounts, ...options.accounts] }, { prewarmOnStart: true }]) {
        expect(() => new FileBackendCodexSafeExecutor({ ...options, ...changed } as typeof options)).toThrow("child_effective_confinement_conflict");
      }
      const executor = new FileBackendCodexSafeExecutor(options);
      try {
        for (const changed of [{ maxAccountCycles: 2 }, { safeExecutionPolicy: { maxAttempts: 2 } },
          { controls: { model: "foreign-model" } }, { controls: { allowedTools: ["shell"] } }]) {
          await expect(executor.run({ taskId: "test-child", prompt: "synthetic", ...changed })).rejects.toThrow("child_effective_confinement_conflict");
        }
        expect(await f.rows()).toEqual([]);
      } finally { await executor.dispose(); }
    } finally { await f.close(); }
  });
});
async function expectProviderCleanedUp(f: Awaited<ReturnType<typeof fixture>>, rows: Awaited<ReturnType<typeof f.rows>>) {
  const resources = rows.filter(r => r.type === "TEST-resource-live");
  expect(resources).toHaveLength(1);
  expect(rows.filter(r => r.type === "cleanup-request")).toEqual([
    { type: "cleanup-request", pid: resources[0].pid, resourceActive: true },
  ]);
  expect(rows.filter(r => r.type === "provider-exit")).toEqual([
    { type: "provider-exit", pid: resources[0].pid, code: 0 },
  ]);
  expect(rows.filter(r => r.type === "TEST-resource-watchdog")).toEqual([]);
  await expect(readFile(f.resource)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.fake.child.isExited()).toBe(true);
  expect(f.fake.cleanupSignals).toEqual(["SIGTERM"]);
}
async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}
