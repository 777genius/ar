import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
export enum HostedFdLaunchKind { Foreground = "foreground", Provider = "provider", Installer = "installer", Remover = "remover" }
/** Negative original-clock veto and immediate actual-handle custody only.
 * Neither callback supplies spawn, FD admission or a successful release. */
export type HostedFdOriginalSpawnCustody = Readonly<{
  assertOriginalWork(): void;
  retainOriginalChild(child: ChildProcess, streams: Readonly<Pick<ChildProcess, "stdin" | "stdout" | "stderr">>): void;
}>;
type Birth = Readonly<{ unit: string; kind: HostedFdLaunchKind; birth: string; command: string; args: readonly string[] }>;
const births = new WeakMap<ChildProcess, Birth>();
function fail(): never { throw new Error("hosted_fd_child_unresolved"); }
function birth(child: ChildProcess): string {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) fail();
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8"), at = stat.lastIndexOf(") ");
  const tick = stat.slice(at + 2).trim().split(/\s+/)[19];
  if (!stat.startsWith(child.pid + " (") || at < 0 || !tick || !/^[1-9][0-9]*$/.test(tick)) fail();
  return child.pid + ":" + tick;
}
/** Existing fixed three-channel exec, after the FDA's unchanged profile/recipe
 * checks. No foreign child registration or injectable spawn callback exists. */
export function spawnHostedFdProcess(command: string, args: readonly string[], options: Pick<SpawnOptions, "cwd" | "detached">,
  unit: string, kind: HostedFdLaunchKind, original?: HostedFdOriginalSpawnCustody): ChildProcess {
  if (original && (kind === HostedFdLaunchKind.Installer || typeof original.assertOriginalWork !== "function" || typeof original.retainOriginalChild !== "function")) fail();
  original?.assertOriginalWork();
  const child = spawn(command, args, { ...options, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: kind === HostedFdLaunchKind.Installer ? ["pipe", "ignore", "ignore"] : ["pipe", "pipe", "pipe"] });
  child.once("error", () => invalidateHostedFdProcess(child));
  child.once("close", () => invalidateHostedFdProcess(child));
  try {
    original?.retainOriginalChild(child, Object.freeze({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr }));
    births.set(child, Object.freeze({ unit, kind, birth: birth(child), command, args: Object.freeze([...args]) }));
  } catch (error) { if (!original) child.kill("SIGTERM"); throw error; }
  return child;
}
export function assertHostedFdProcess(child: ChildProcess, unit: string, kind: HostedFdLaunchKind,
  command?: string, args?: readonly string[]): void {
  const retained = births.get(child);
  if (!retained || retained.unit !== unit || retained.kind !== kind || retained.birth !== birth(child) ||
      (command !== undefined && retained.command !== command) ||
      (args !== undefined && JSON.stringify(retained.args) !== JSON.stringify(args))) fail();
}
export function invalidateHostedFdProcess(child: ChildProcess): void { births.delete(child); }
