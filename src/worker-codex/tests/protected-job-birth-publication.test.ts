import { setupResearchFixture, cleanupResearchFixture, host } from "./research-launch-fixture";
import { AsyncResource } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn() }));
import { protectedCodexGoalJobBirthPublicationActive, recordProtectedCodexGoalJobFirstEffect,
  withProtectedCodexGoalJobBirthPublication } from "../protected-job-birth";
import { researchAuthorityRoot } from "../research-launch-files";

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
  it("waits for independent async ownership, then invokes the contender effect once", async () => {
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
    await tick(50); expect(effect).not.toHaveBeenCalled();
    release(); await first;
    await tick(50);
    expect(await second).toBe("TEST-published"); expect(effect).toHaveBeenCalledOnce();
    expect(existsSync(lock)).toBe(false); independent.emitDestroy();
  });
  it("times out before effects without deleting or changing a foreign lock", async () => {
    const bytes = foreignLock(), effect = vi.fn(async () => {});
    const pending = withProtectedCodexGoalJobBirthPublication(effect);
    const rejected = expect(pending).rejects.toThrow("protected_job_birth_publication_busy");
    for (let n = 0; n < 100; n++) await tick(50);
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
    now = 6_000; release(); await first;
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
