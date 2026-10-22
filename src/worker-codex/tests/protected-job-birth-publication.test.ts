import { setupResearchFixture, cleanupResearchFixture, host } from "./research-launch-fixture";
import * as fs from "node:fs";
import { AsyncResource } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn() }));
import { assertProtectedCodexGoalJobBirthUnpublished, protectedCodexGoalJobBirthPublicationActive, recordProtectedCodexGoalJobFirstEffect,
  withProtectedCodexGoalJobBirthPublication } from "../protected-job-birth";
import { researchAuthorityRoot } from "../research-launch-files";
import { createCodexGoalJob } from "../codex-goal-jobs";
import { observeResearchJobWriterAuthority } from "../research-writer-observation";

const lock = join(researchAuthorityRoot, "job-births/publication.lock");
let now: number;
beforeEach(async () => {
  const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  setupResearchFixture({ allocationParent: nativeFs.realpathSync(tmpdir()) });
  now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); cleanupResearchFixture(); });
const tick = async (milliseconds: number) => { now += milliseconds; await vi.advanceTimersByTimeAsync(milliseconds); };
function foreignLock(): Buffer {
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from("TEST foreign lock remains owned");
  writeFileSync(join(lock, "TEST-owner"), bytes, { mode: 0o600 });
  host.foreign.add(lock);
  return bytes;
}

describe("bounded protected publication acquisition", () => {
  it("admits only unpublished roots while holding genuine publication ownership", async () => {
    const root = "/TEST-project/jobs/TEST-unpublished";
    mkdirSync(root, { recursive: true, mode: 0o700 });
    expect(() => assertProtectedCodexGoalJobBirthUnpublished(root)).toThrow("protected_job_birth_authority_invalid");
    await withProtectedCodexGoalJobBirthPublication(async () => {
      expect(() => assertProtectedCodexGoalJobBirthUnpublished(root)).not.toThrow();
      recordProtectedCodexGoalJobFirstEffect(root);
      expect(() => assertProtectedCodexGoalJobBirthUnpublished(root)).toThrow("protected_job_birth_authority_invalid");
    });
  });
  it.each([false, true])("waits for an independent publisher before observing actual writer authority (first effect=%s)", async firstEffect => {
    const jobId = "TEST-contended-birth", jobRootDir = "/TEST-project/jobs/" + jobId;
    const workspacePath = "/TEST-project/workspaces/" + jobId;
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    const job = await createCodexGoalJob({ registryRootDir: "/TEST-project/registry", manifest: {
      jobId, taskId: jobId, jobRootDir, workspacePath, promptPath: join(jobRootDir, "prompt.md"), accounts: ["TEST-a"],
    } });
    expect(await observeResearchJobWriterAuthority(job)).toEqual({ status: "released" });
    const independent = new AsyncResource("TEST-independent-birth-reader");
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const publisher = withProtectedCodexGoalJobBirthPublication(async () => {
      entered(); await held;
      if (firstEffect) recordProtectedCodexGoalJobFirstEffect(jobRootDir);
    });
    await ready;
    let settled = false;
    const reader = independent.runInAsyncScope(() => observeResearchJobWriterAuthority(job));
    void reader.then(() => { settled = true; });
    try {
      await tick(100);
      expect(settled).toBe(false);
    } finally { release(); await publisher; }
    await tick(50);
    expect(await reader).toEqual({ status: firstEffect ? "unknown" : "released" });
    expect(existsSync(lock)).toBe(false);
    independent.emitDestroy();
  });
  it("publishes complete owner bytes before an effect and excludes an old mkdir contender", async () => {
    await withProtectedCodexGoalJobBirthPublication(async () => {
      const owner = JSON.parse(readFileSync(lock, "utf8"));
      expect(owner.process).toMatchObject({ pid: process.pid, bootId: host.boot, birthTicks: host.birth });
      expect(lstatSync(lock).isFile()).toBe(true); expect(lstatSync(lock).nlink).toBe(2);
      expect(() => mkdirSync(lock, { mode: 0o700 })).toThrow();
      expect(readFileSync(join(researchAuthorityRoot, "job-births", `.publication-${owner.nonce}.owner.json`))).toEqual(readFileSync(lock));
    });
    expect(readdirSync(join(researchAuthorityRoot, "job-births"))).toEqual([]);
  });
  it("never evicts an anonymous old directory and cleans only its own losing staging records", async () => {
    mkdirSync(lock, { recursive: true, mode: 0o700 }); const inode = lstatSync(lock).ino;
    const effect = vi.fn(async () => {}), pending = withProtectedCodexGoalJobBirthPublication(effect);
    const rejected = expect(pending).rejects.toThrow("protected_job_birth_publication_busy");
    for (let n = 0; n < 600; n++) await tick(50);
    await rejected; expect(effect).not.toHaveBeenCalled(); expect(lstatSync(lock).ino).toBe(inode);
    expect(readdirSync(join(researchAuthorityRoot, "job-births"))).toEqual(["publication.lock"]);
  });
  it.each([50, 6_000])("waits for independent async ownership held %s ms, then invokes the contender effect once", async heldMs => {
    const independent = new AsyncResource("TEST-independent-publication");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withProtectedCodexGoalJobBirthPublication(async () => { await held; });
    await Promise.resolve();
    expect(existsSync(lock)).toBe(true);
    const effect = vi.fn(async () => {
      expect(protectedCodexGoalJobBirthPublicationActive()).toBe(true); return "TEST-published";
    });
    const second = independent.runInAsyncScope(() => withProtectedCodexGoalJobBirthPublication(effect));
    const outcome = second.catch(error => error);
    await tick(heldMs); expect(effect).not.toHaveBeenCalled();
    release(); await first;
    await tick(50);
    expect(await outcome).toBe("TEST-published"); expect(effect).toHaveBeenCalledOnce();
    expect(existsSync(lock)).toBe(false); independent.emitDestroy();
  });
  it("waits behind a real held owner without staging or fsyncing a losing owner", async () => {
    const independent = new AsyncResource("TEST-contender-no-write");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withProtectedCodexGoalJobBirthPublication(async () => { await held; });
    await Promise.resolve();
    const before = readFileSync(lock), identity = lstatSync(lock);
    const opened = vi.spyOn(fs, "openSync"), synced = vi.spyOn(fs, "fsyncSync");
    const effect = vi.fn(async () => "TEST-once");
    const second = independent.runInAsyncScope(() => withProtectedCodexGoalJobBirthPublication(effect));
    const outcome = second.catch(error => error);
    try {
      await tick(100);
      expect(opened).not.toHaveBeenCalled(); expect(synced).not.toHaveBeenCalled();
      expect(readFileSync(lock)).toEqual(before); expect(lstatSync(lock).ino).toBe(identity.ino);
      expect(effect).not.toHaveBeenCalled();
    } finally { opened.mockRestore(); synced.mockRestore(); release(); await first; await tick(50); }
    expect(await outcome).toBe("TEST-once"); expect(effect).toHaveBeenCalledOnce();
    expect(existsSync(lock)).toBe(false); independent.emitDestroy();
  });
  it("retains atomic link exclusion when a publisher wins after the absent-name read", () => {
    const originalLink = fs.linkSync;
    const link = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      expect(to).toBe(lock);
      expect(JSON.parse(readFileSync(String(from), "utf8"))).toMatchObject({ process: { pid: process.pid } });
      writeFileSync(lock, "TEST-racing-owner", { flag: "wx", mode: 0o600 });
      return originalLink(from, to);
    });
    try {
      expect(() => recordProtectedCodexGoalJobFirstEffect("/TEST-project/jobs/TEST-race"))
        .toThrow("protected_job_birth_publication_busy");
      expect(link).toHaveBeenCalledOnce(); expect(readFileSync(lock, "utf8")).toBe("TEST-racing-owner");
      expect(readdirSync(join(researchAuthorityRoot, "job-births"))).toEqual(["publication.lock"]);
    } finally { link.mockRestore(); }
  });
  it.each(["malformed-file", "dangling-symlink"])("refuses existing %s without staging owner evidence", kind => {
    const root = join(researchAuthorityRoot, "job-births"); mkdirSync(root, { recursive: true, mode: 0o700 });
    if (kind === "malformed-file") writeFileSync(lock, "TEST-not-an-owner", { mode: 0o600 });
    else fs.symlinkSync("TEST-absent-target", lock);
    const identity = lstatSync(lock), opened = vi.spyOn(fs, "openSync"), synced = vi.spyOn(fs, "fsyncSync");
    try {
      expect(() => recordProtectedCodexGoalJobFirstEffect("/TEST-project/jobs/TEST-malformed"))
        .toThrow("protected_job_birth_publication_busy");
      expect(opened.mock.calls.filter(([path, flags]) => String(path).includes("/.publication-") || flags === "wx"))
        .toEqual([]); expect(synced).not.toHaveBeenCalled();
      expect(lstatSync(lock).ino).toBe(identity.ino); expect(readdirSync(root)).toEqual(["publication.lock"]);
    } finally { opened.mockRestore(); synced.mockRestore(); }
  });
  it("propagates a denied lock-name observation without owner writes or retries", async () => {
    const originalStat = fs.lstatSync;
    const denied = Object.assign(new Error("TEST denied"), { code: "EACCES" });
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (args[0] === lock) throw denied;
      return originalStat(...args);
    });
    const opened = vi.spyOn(fs, "openSync"), synced = vi.spyOn(fs, "fsyncSync"), effect = vi.fn(async () => {});
    try {
      await expect(withProtectedCodexGoalJobBirthPublication(effect)).rejects.toBe(denied);
      expect(effect).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled(); expect(synced).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { stat.mockRestore(); opened.mockRestore(); synced.mockRestore(); }
  });
  it("times out before effects without deleting or changing a foreign lock", async () => {
    const bytes = foreignLock(), effect = vi.fn(async () => {});
    const pending = withProtectedCodexGoalJobBirthPublication(effect);
    const rejected = expect(pending).rejects.toThrow("protected_job_birth_publication_busy");
    for (let n = 0; n < 600; n++) await tick(50);
    await rejected;
    expect(effect).not.toHaveBeenCalled(); expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, "TEST-owner")).equals(bytes)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not acquire after the deadline when a delayed timer wakes to a released lock", async () => {
    const independent = new AsyncResource("TEST-delayed-publication");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withProtectedCodexGoalJobBirthPublication(async () => { await held; });
    await Promise.resolve();
    const effect = vi.fn(async () => {});
    const second = independent.runInAsyncScope(() => withProtectedCodexGoalJobBirthPublication(effect));
    const rejected = expect(second).rejects.toThrow("protected_job_birth_publication_busy");
    now = 31_000; release(); await first;
    await vi.advanceTimersByTimeAsync(50); await rejected;
    expect(effect).not.toHaveBeenCalled(); expect(existsSync(lock)).toBe(false); independent.emitDestroy();
  });
  it("preserves same-context reentrancy and never retries a failing effect", async () => {
    const inner = vi.fn(async () => { throw new Error("TEST effect failed"); });
    await expect(withProtectedCodexGoalJobBirthPublication(async () => {
      expect(protectedCodexGoalJobBirthPublicationActive()).toBe(true);
      return await withProtectedCodexGoalJobBirthPublication(inner);
    })).rejects.toThrow("TEST effect failed");
    expect(inner).toHaveBeenCalledOnce(); expect(existsSync(lock)).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates non-busy custody errors immediately before effects", async () => {
    mkdirSync(join(researchAuthorityRoot, "job-births"), { recursive: true, mode: 0o700 });
    host.foreign.add(join(researchAuthorityRoot, "job-births"));
    const effect = vi.fn(async () => {});
    await expect(withProtectedCodexGoalJobBirthPublication(effect)).rejects.toThrow("hosted_research_launch_denied");
    expect(effect).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps independent synchronous first effects immediate and fail closed", async () => {
    foreignLock();
    expect(() => recordProtectedCodexGoalJobFirstEffect("/TEST-project/jobs/TEST-research-r7"))
      .toThrow("protected_job_birth_publication_busy");
    expect(vi.getTimerCount()).toBe(0); expect(existsSync(lock)).toBe(true);
  });
});
