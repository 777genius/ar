import { once } from "node:events";
import { build as viteBuild } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProjectAuthorityCasStatus } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectAuthorityCrashPoint, LocalProjectAuthorityTupleStore } from
  "../project-authority-tuple-local-adapter";

const sourceFixture = fileURLToPath(new URL("./project-authority-tuple-child-process.ts", import.meta.url));
let fixture = "";
let fixtureRoot = "";
const roots: string[] = [];
const childProcesses = new Set<ChildProcess>();
const childStderr = new WeakMap<ChildProcess, string>();

const projectId = "hosted-web-core-v1";
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "authority-child-bundle-"));
  fixture = join(fixtureRoot, "child.mjs");
  await viteBuild({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@vioxen/subscription-runtime/worker-core": join(
      dirname(sourceFixture),
      "../../worker-core/project-control/ports/project-authority-tuple-store-port.ts",
    ) } },
    build: {
      outDir: fixtureRoot,
      emptyOutDir: false,
      target: "node20",
      ssr: sourceFixture,
      rollupOptions: { output: { entryFileNames: "child.mjs" } },
    },
  });
});
afterEach(async () => { await stopChildren(); await removeRoots(); });
afterAll(async () => { await stopChildren(); await removeRoots(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

describe("project authority real process certification", () => {
  it("serializes 16 identical CAS processes", async () => {
    const root = await freshRoot();
    await new LocalProjectAuthorityTupleStore({ rootDir: root, projectId }).initialize(expected());
    const children = Array.from({ length: 16 }, () => child("cas", root, "ready", "same"));
    await Promise.all(children.map(ready));
    for (const process of children) process.stdin!.end("go\n");
    const results = await Promise.all(children.map(jsonResult));
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.status === "noop")).toHaveLength(15);
  });

  it("selects one durable winner from 16 conflicting processes", async () => {
    const root = await freshRoot();
    await new LocalProjectAuthorityTupleStore({ rootDir: root, projectId }).initialize(expected());
    const variants = "0123456789abcdef".split("");
    const children = variants.map((variant) => child("cas", root, "ready", variant));
    await Promise.all(children.map(ready));
    for (const process of children) process.stdin!.end("go\n");
    const results = await Promise.all(children.map(jsonResult));
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.error === "project_authority_compare_and_set_conflict"))
      .toHaveLength(15);
  });

  it("blocks on the same persistent flock inode then reacquires after SIGKILL", async () => {
    const root = await freshRoot();
    await new LocalProjectAuthorityTupleStore({ rootDir: root, projectId }).initialize(expected());
    const first = child("hold", root);
    await line(first);
    const lockPath = join(root, projectId, ".authority-tuple.flock");
    const inode = (await stat(lockPath)).ino;
    const second = child("hold", root);
    const secondLine = line(second);
    const early = await Promise.race([secondLine.then(() => true), delay(150).then(() => false)]);
    expect(early).toBe(false);
    const firstExit = close(first);
    first.kill("SIGKILL");
    await deadline(firstExit, 2_000, "first_child_kill_timeout");
    expect(await secondLine).toBe("locked");
    expect((await stat(lockPath)).ino).toBe(inode);
    const secondExit = close(second);
    second.kill("SIGKILL");
    await deadline(secondExit, 2_000, "second_child_kill_timeout");
  });

  for (const point of Object.values(LocalProjectAuthorityCrashPoint)) {
    it(`converges after an actual process crash at ${point}`, async () => {
      const root = await freshRoot();
      const store = new LocalProjectAuthorityTupleStore({ rootDir: root, projectId });
      await store.initialize(expected());
      const crashed = child("crash", root, undefined, point);
      await deadline(close(crashed), 10_000, "crash_child_timeout");
      expect(crashed.signalCode).toBe("SIGKILL");
      const status = await store.compareAndSet({ expected: expected(), desired: desired() });
      expect([ProjectAuthorityCasStatus.Applied, ProjectAuthorityCasStatus.Noop]).toContain(status);
      await expect(store.compareAndSet({ expected: expected(), desired: desired() }))
        .resolves.toBe(ProjectAuthorityCasStatus.Noop);
    });
  }
});

function child(mode: string, root: string, barrier?: string, variant?: string): ChildProcess {
  const childProcess = spawn(process.execPath, ["--v8-pool-size=1", fixture, mode, root, projectId, barrier ?? "", variant ?? ""],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, UV_THREADPOOL_SIZE: "1" } });
  childProcesses.add(childProcess);
  childStderr.set(childProcess, "");
  childProcess.stderr!.on("data", (chunk) => {
    childStderr.set(childProcess, (childStderr.get(childProcess) || "") + String(chunk));
  });
  childProcess.once("close", () => childProcesses.delete(childProcess));
  return childProcess;
}
async function ready(process: ChildProcess): Promise<void> {
  const value = await deadline(lineFrom(process.stderr!, process), 10_000, "child_ready_timeout");
  if (value !== "ready") throw new Error("child_ready_invalid:" + value + ":" + childStderr.get(process));
}
async function jsonResult(process: ChildProcess): Promise<Record<string, string>> {
  const exited = close(process);
  const output = await line(process);
  await deadline(exited, 10_000, "child_close_timeout");
  return JSON.parse(output) as Record<string, string>;
}
async function line(process: ChildProcess): Promise<string> {
  return deadline(lineFrom(process.stdout!, process), 15_000, "child_result_timeout");
}
async function lineFrom(stream: NodeJS.ReadableStream, process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const onData = (chunk: unknown) => {
      body += String(chunk);
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(body.slice(0, newline));
    };
    const onEnd = () => { cleanup(); reject(new Error("child_exited_without_output:" + (childStderr.get(process) || ""))); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}
async function stopChildren(): Promise<void> {
  const active = [...childProcesses];
  for (const process of active) if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
  await Promise.all(active.map(async (process) => {
    try { await deadline(close(process), 1_000, "child_term_timeout"); }
    catch { process.kill("SIGKILL"); await deadline(close(process), 2_000, "child_kill_timeout"); }
  }));
}
function close(process: ChildProcess): Promise<void> {
  return childProcesses.has(process) ? once(process, "close").then(() => undefined) : Promise.resolve();
}
async function deadline<T>(value: Promise<T>, ms: number, error: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([value, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(error)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function removeRoots(): Promise<void> { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); }
async function freshRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "authority-process-"));
  roots.push(parent);
  const root = join(parent, "authority");
  await mkdir(root, { mode: 0o700 });
  return root;
}
function expected() { return { packetRevision: "hosted-web-core-v1-r1", baseSha: "a".repeat(40),
  phaseStartSha: null, inputPatchHash: "b".repeat(64) } as const; }
function desired() { return { ...expected(), phaseStartSha: "c".repeat(40),
  reviewReceiptSha256: "d".repeat(64) }; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
