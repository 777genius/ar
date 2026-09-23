import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertExactUnitGroup, custodyControlGroup, observedBootId, observedProcessBirth, parseUnitShow } from "./hosted-readonly-observations";

// Private fixed-host observations. Callers own all fencing and custody decisions.
// No command, environment, root, or cgroup path is supplied by a caller.
function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }
function unit(name: string): void {
  if (name.length > 200 || !/^[A-Za-z0-9_@.-]+\.(service|scope)$/.test(name)) invalid();
}
function systemctl(args: readonly string[], allowNotFound = false): string {
  const result = spawnSync("/usr/bin/systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000, maxBuffer: 256 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
  if (result.error || (result.status !== 0 && !(allowNotFound && result.status === 4 && result.stdout.trim() === "LoadState=not-found"))) invalid();
  return result.stdout;
}
export function collectBootId(): string {
  return observedBootId(readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
}
export function collectProcessBirth(pid: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) invalid();
  return observedProcessBirth(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
}
export function collectProcessCgroup(pid: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) invalid();
  return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
}
export function collectSelfCgroup(): string {
  return readFileSync("/proc/self/cgroup", "utf8").trim();
}
export function collectCgroupProcesses(relative: string): string {
  if (relative.length > 4096 || !/^(?:\/[A-Za-z0-9_.@+-]+)*$/.test(relative) ||
      relative.split("/").some(part => part === "." || part === "..")) invalid();
  return readFileSync(`/sys/fs/cgroup${relative}/cgroup.procs`, "utf8");
}
export function collectUnitShow(name: string): Record<string, string> {
  unit(name);
  return parseUnitShow(name, systemctl(["show", "--property=Id,FragmentPath,DropInPaths,ControlGroup,MainPID", "--", name]));
}
export function collectFutureCreatorShow(name: string): string {
  if (name.length > 200 || !/^[A-Za-z0-9_@.-]+\.(service|socket|timer)$/.test(name)) invalid();
  return systemctl(["show", "--property=Id,LoadState,ActiveState,UnitFileState,Job", "--", name]);
}
export function collectJobs(): string {
  return systemctl(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"]);
}
export function collectUnitNotFound(name: string): boolean {
  unit(name);
  return systemctl(["show", "--property=LoadState", "--", name], true).trim() === "LoadState=not-found";
}
export type CollectedEvents = { readonly kind: "present"; readonly text: string } | { readonly kind: "absent" };
export function collectCustodyEvents(name: string): CollectedEvents {
  const path = `/sys/fs/cgroup${custodyControlGroup(name)}/cgroup.events`;
  try { return { kind: "present", text: readFileSync(path, "utf8") }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}
// TEST needs a manager generation token, checked on both sides of each read.
// It is observational and never supplies creator or launcher authority.
export function collectUnitInvocation(name: string): string {
  unit(name);
  const rows = systemctl(["show", "--property=Id,InvocationID", "--", name]).trimEnd().split("\n");
  const values = new Map(rows.map(row => {
    const at = row.indexOf("=");
    if (at < 1) invalid();
    return [row.slice(0, at), row.slice(at + 1)];
  }));
  if (rows.length !== 2 || values.size !== 2 || values.get("Id") !== name ||
      !/^[a-f0-9]{32}$/.test(values.get("InvocationID") ?? "")) invalid();
  return values.get("InvocationID")!;
}
export function collectExactUnit(name: string): Record<string, string> {
  const show = collectUnitShow(name);
  assertExactUnitGroup(name, show, custodyControlGroup(name));
  return show;
}
