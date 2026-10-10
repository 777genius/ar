import { spawn } from "node:child_process";
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
