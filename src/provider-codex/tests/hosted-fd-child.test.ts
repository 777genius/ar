import { spawn } from "node:child_process";
import { fstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { expect, it } from "vitest";
import { assertHostedFdProcess, invalidateHostedFdProcess, spawnHostedFdProcess, HostedFdLaunchKind } from "../app-server/adapters/hosted-fd-child";

it.skipIf(process.platform !== "linux")("binds only the real fixed-spawn child/unit/argv and revokes its live identity", async () => {
  const unit = "subscription-runtime-hosted-01234567-89ab-cdef-0123-456789abcdef.service";
  const args = ["-e", "process.stdout.write('ready');process.stdin.resume()"];
  const child = spawnHostedFdProcess(process.execPath, args, {}, unit, HostedFdLaunchKind.Provider);
  const foreign = spawn(process.execPath, args, { stdio: "pipe" });
  const closed = (process: typeof child) => new Promise<void>(resolve => process.once("close", () => resolve()));
  const ownClosed = closed(child), foreignClosed = closed(foreign);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve()); child.once("error", reject);
    });
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider, process.execPath, args)).not.toThrow();
    expect(() => assertHostedFdProcess(foreign, unit, HostedFdLaunchKind.Provider)).toThrow("hosted_fd_child_unresolved");
    expect(() => assertHostedFdProcess(child, unit.replace("01234567", "11234567"), HostedFdLaunchKind.Provider)).toThrow();
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Installer)).toThrow();
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider, process.execPath, ["-e", "other"])).toThrow();
    invalidateHostedFdProcess(child);
    // Revocation matters before PID exit: a still-live, same-birth process
    // cannot recreate the private constructor membership.
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider)).toThrow("hosted_fd_child_unresolved");
  } finally { child.stdin!.end(); foreign.stdin.end(); await Promise.all([ownClosed, foreignClosed]); }
  expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider)).toThrow();
});

const fdAccessMode = (path: string): number => {
  const flags = /^flags:\s+([0-7]+)$/m.exec(readFileSync(path, "utf8"))?.[1];
  if (!flags) throw new Error("TEST missing fd flags");
  return Number.parseInt(flags, 8) & 3;
};
function writableNullDescriptors(): number[] {
  return readdirSync("/proc/self/fd").flatMap(name => {
    const fd = Number(name); if (fd <= 2) return [];
    try { const s = fstatSync(fd); return s.isCharacterDevice() && s.rdev === 259 && fdAccessMode(`/proc/self/fdinfo/${fd}`) === 1 ? [fd] : []; }
    catch (e) { if (["EBADF", "ENOENT"].includes((e as NodeJS.ErrnoException).code ?? "")) return []; throw e; }
  }).sort((a, b) => a - b);
}
it.skipIf(process.platform !== "linux")("actual Installer spawn retains a socket stdin and write-only null output without parent FD leaks", async () => {
  const before = writableNullDescriptors();
  const args = ["-e", `const fs=require('node:fs');process.stdin.resume();process.stdin.once('end',()=>{
    const valid=[1,2].every(fd=>{const s=fs.fstatSync(fd),flags=/^flags:\\s+([0-7]+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'))?.[1];
      return s.isCharacterDevice()&&s.rdev===259&&flags&&(parseInt(flags,8)&3)===1;});process.exit(valid?0:99);});`];
  // Negative native control: UV_IGNORE recreates the old read/write mode,
  // which this child's unchanged write-only contract must reject.
  const ignored = spawn(process.execPath, args, { stdio: ["pipe", "ignore", "ignore"] });
  const ignoredClosed = new Promise<readonly [number | null, NodeJS.Signals | null]>(resolve => ignored.once("close", (code, signal) => resolve([code, signal])));
  try { for (const fd of [1, 2]) expect(fdAccessMode(`/proc/${ignored.pid}/fdinfo/${fd}`)).toBe(2); }
  finally { ignored.stdin!.end(); await ignoredClosed; }
  expect(await ignoredClosed).toEqual([99, null]);
  const unit = "subscription-runtime-installer-01234567-89ab-cdef-0123-456789abcdef.service";
  const child = spawnHostedFdProcess(process.execPath, args, {}, unit, HostedFdLaunchKind.Installer);
  const closed = new Promise<readonly [number | null, NodeJS.Signals | null]>(resolve => child.once("close", (code, signal) => resolve([code, signal])));
  try {
    expect(child.stdout).toBeNull(); expect(child.stderr).toBeNull();
    expect(statSync(`/proc/${child.pid}/fd/0`).isSocket()).toBe(true);
    for (const fd of [1, 2]) {
      const actual = statSync(`/proc/${child.pid}/fd/${fd}`);
      expect(actual.isCharacterDevice()).toBe(true); expect(actual.rdev).toBe(259);
      expect(fdAccessMode(`/proc/${child.pid}/fdinfo/${fd}`)).toBe(1);
    }
    expect(writableNullDescriptors()).toEqual(before);
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Installer, process.execPath, args)).not.toThrow();
  } finally { child.stdin!.end(); await closed; }
  expect(await closed).toEqual([0, null]); expect(writableNullDescriptors()).toEqual(before);
});
it.skipIf(process.platform !== "linux")("Installer sink closes when synchronous spawn argument validation throws", () => {
  const before = writableNullDescriptors();
  expect(() => spawnHostedFdProcess(process.execPath, ["\0"], {}, "TEST-invalid-argv", HostedFdLaunchKind.Installer)).toThrow();
  expect(writableNullDescriptors()).toEqual(before);
});
