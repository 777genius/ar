import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertQualifiedPairForPublication, QualificationChild, QualificationClock, type QualifiedOrdinaryLauncherPair } from "../hosted-ordinary-installation-qualification";
import type { OrdinaryInstallationOperation } from "../hosted-ordinary-installation-owned";

// Isolate private result membership from Linux funding admission. No positive
// capability, spawn, Store state or privileged observation is fabricated here.
vi.mock("../hosted-ordinary-installation-owned", () => ({ assertOriginalOrdinaryInstallationOperation: vi.fn() }));
const operation = (): OrdinaryInstallationOperation => Object.freeze({ operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  operationSha256: "a".repeat(64), workEndEpochMs: Date.now() + 10000, cleanupEndEpochMs: Date.now() + 20000 });
const issued = () => ({ issuedEpochMs: Date.now(), issuedMonotonicNs: String(process.hrtime.bigint()) });
afterEach(() => { vi.restoreAllMocks(); });
describe("ordinary qualification private membership and original deadlines", () => {
  // A public DTO constructor or receipt re-import would make these cases green.
  it.each([Object.freeze({ kind: "ordinary_launcher_pair" }), JSON.parse('{"kind":"ordinary_launcher_pair"}'),
    { kind: "ordinary_launcher_pair", closed: true, exitCode: 0 }])("refuses reconstructed result data", value => {
    expect(() => assertQualifiedPairForPublication(value as QualifiedOrdinaryLauncherPair, operation())).toThrow("ordinary_launcher_qualification_held");
  });
  it("refuses work after a synchronous observation consumes the original allowance", () => {
    const op = operation(), clock = new QualificationClock(op, issued());
    vi.spyOn(Date, "now").mockReturnValue(op.workEndEpochMs);
    expect(() => clock.remaining()).toThrow("ordinary_launcher_qualification_held");
    expect(clock.remaining(true)).toBeGreaterThan(0);
  });
  it("does not regain time when the wall clock moves backward", () => {
    const original = issued(), clock = new QualificationClock(operation(), original);
    vi.spyOn(Date, "now").mockReturnValue(0);
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(BigInt(original.issuedMonotonicNs) + 30000000000n);
    expect(() => clock.remaining(true)).toThrow("ordinary_launcher_qualification_held");
  });
  // These actual inert Node children use new disposable workspaces. They never
  // represent a successful privileged unit, FD guard or qualified pair.
  it("retains actual close and raw EOF when admission starts after work expiry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-custody-TEST-")), op = operation();
    const child = spawn(process.execPath, ["-e", 'setTimeout(()=>process.stdout.write("original raw EOF\\n"),25)'],
      { cwd: directory, env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      const clock = new QualificationClock(op, issued());
      vi.spyOn(Date, "now").mockReturnValue(op.workEndEpochMs);
      const owned = new QualificationChild(child, "subscription-runtime-hosted-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.service", clock, join(directory, "actual-child"));
      owned.endInput();
      expect(() => owned.admitProxy()).toThrow("ordinary_launcher_qualification_held");
      await closed; await owned.wait(true);
      expect(owned.stdout().toString()).toBe("original raw EOF\n");
      expect(child.stdin.writableFinished && child.stdout.readableEnded && child.stderr.readableEnded).toBe(true);
      expect(() => owned.closeUnit()).toThrow("ordinary_launcher_qualification_held");
    } finally { await closed; vi.restoreAllMocks(); rmSync(directory, { recursive: true }); }
  });
  it.runIf(process.platform === "linux")("refuses fallback signal after original cleanup expiry and retains natural close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-cleanup-TEST-")), op = operation();
    const child = spawn(process.execPath, ["-e", 'setTimeout(()=>process.stdout.write("natural close\\n"),50)'],
      { cwd: directory, env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      const owned = new QualificationChild(child, "subscription-runtime-hosted-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.service",
        new QualificationClock(op, issued()), join(directory, "actual-child"));
      owned.admitProxy(); owned.endInput();
      const signal = vi.spyOn(child, "kill"); vi.spyOn(Date, "now").mockReturnValue(op.cleanupEndEpochMs);
      await expect(owned.settleFailed()).rejects.toThrow("ordinary_launcher_qualification_held");
      expect(signal).not.toHaveBeenCalled();
      await closed; vi.restoreAllMocks(); await owned.wait(true);
      expect(owned.stdout().toString()).toBe("natural close\n");
      expect(child.exitCode).toBe(0);
      expect(child.stdout.readableEnded && child.stderr.readableEnded).toBe(true);
      expect(() => owned.closeUnit()).toThrow("ordinary_launcher_qualification_held");
    } finally { await closed; vi.restoreAllMocks(); rmSync(directory, { recursive: true }); }
  });
});
