import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeTool } from "@vioxen/subscription-runtime/core";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { ChildContinuationMode } from "@vioxen/subscription-runtime/core";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { runCodexGoalCli, parseCodexGoalCliArgs } from "../codex-goal-cli";

const sentinel = "synthetic-pr3-provider-only-key-418273";
async function fixture(mode = "unfinished", deadlineMs = 10000) {
  const root = await mkdtemp(join(tmpdir(), "pr3-TEST-private-registry-"));
  const job = join(root, "jobs", "test-child"), workspace = join(job, "workspace");
  await mkdir(workspace, { recursive: true });
  const prompt = join(root, "private-prompt.md"), transport = join(root, "fake-app-server.mjs"), log = join(root, "transport.jsonl");
  const resource = join(root, "TEST-provider-heartbeat");
  await writeFile(prompt, "Leave this goal unfinished. Return a short progress message.\n");
  const lifetime = { schemaVersion: 1, accountId: "account-s", deadlineEpochMs: Date.now() + deadlineMs,
    maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled,
    denyProjectInstructions: true, accessBoundary: AccessBoundary.ReadOnly,
    allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles] };
  await writeFile(transport, `#!${process.execPath}
import { appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const log = ${JSON.stringify(log)}, mode = ${JSON.stringify(mode)};
const record = value => appendFileSync(log, JSON.stringify(value) + '\\n');
// A signal listener alone does not keep Node alive after stdin EOF. Model an
// independent, bounded provider obligation so every stop must actually clean it.
const resource = ${JSON.stringify(resource)};
let heartbeat, watchdog;
{
 const beat = () => writeFileSync(resource, JSON.stringify({ pid: process.pid, at: Date.now() }));
 beat(); heartbeat = setInterval(beat, 100);
 watchdog = setTimeout(() => { record({ type: 'TEST-resource-watchdog' }); process.exit(70); }, 10000);
 process.on('exit', code => record({ type: 'provider-exit', pid: process.pid, code }));
 record({ type: 'TEST-resource-live', pid: process.pid });
}
record({ type: 'provider-start', sentinelSeen: createHash("sha256").update(process.env.MIMO_TOKEN_PLAN_API_KEY ?? "").digest("hex") === ${JSON.stringify(createHash("sha256").update(sentinel).digest("hex"))} });
process.on('SIGTERM', () => {
 record({ type: 'cleanup-request', pid: process.pid, resourceActive: heartbeat !== undefined });
 clearInterval(heartbeat); clearTimeout(watchdog); rmSync(resource, { force: true }); process.exit(0);
});
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let turns = 0;
createInterface({ input: process.stdin }).on('line', line => {
 const r = JSON.parse(line); if (!r.method) return;
 record({ method: r.method, ...(r.method === 'turn/start' || r.method === 'thread/start' ? { params: r.params } : {}) });
 const reply = result => send({ id: r.id, result });
 if (r.method === 'initialize') return reply({ userAgent: 'synthetic-test' });
 if (r.method === 'thread/start') return reply({ thread: { id: 'thread-1' } });
 if (r.method === 'thread/goal/set') return reply({ goal: { threadId: 'thread-1', objective: 'unfinished', status: 'active' } });
 if (r.method === 'thread/goal/get') return reply({ goal: { threadId: 'thread-1', objective: 'unfinished', status: 'active' } });
 if (r.method === 'turn/start') {
  const id = 'turn-' + ++turns;
  if (mode === 'retryable') return send({ id: r.id, error: { code: -32000, message: 'usage limit reached' } });
  const finish = () => {
   if (mode === 'delayed') record({ type: 'turn-start-ack', at: Date.now() });
   reply({ turn: { id } });
   if (mode === 'delayed') return;
   send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: id, delta: 'Still unfinished.' } });
   send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'completed' } } }); };
  if (mode === 'delayed') setTimeout(finish, 350); else finish(); return;
 }
 if (r.id !== undefined) reply({});
});
`, { mode: 0o700 });
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
  return { root, argv, io, output, lifetime, log, resource,
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
      expect(rows.filter(r => r.method === "thread/goal/get")).toHaveLength(0);
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
  expect(() => process.kill(process.platform === "win32" ? resources[0].pid : -resources[0].pid, 0))
    .toThrow(expect.objectContaining({ code: "ESRCH" }));
}
async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}
