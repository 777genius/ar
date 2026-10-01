import { spawnSync } from "node:child_process";
import { readFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertExactUnitGroup, custodyControlGroup, observedBootId, observedProcessBirth, parseUnitShow, scopedCgroupPopulated } from "./hosted-readonly-observations";

// Private fixed-host observations. Callers own all fencing and custody decisions.
// No command, environment, root, or cgroup path is supplied by a caller.
function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }
function unit(name: string): void {
  if (name.length > 200 || !/^[A-Za-z0-9_@.-]+\.(service|scope)$/.test(name)) invalid();
}
let scopedCollectionEnd: number | undefined;
export function withScopedCollectionBudget<T>(remainingMs: number, action: () => T): T {
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) invalid();
  const previous = scopedCollectionEnd; scopedCollectionEnd = Math.min(previous ?? Infinity, performance.now() + remainingMs);
  try { const result = action(); if (performance.now() >= scopedCollectionEnd) invalid(); return result; }
  finally { scopedCollectionEnd = previous; }
}
function collectionTimeout(): number {
  const ms = Math.min(5000, Math.floor((scopedCollectionEnd ?? performance.now() + 5000) - performance.now()));
  if (ms < 1) invalid(); return ms;
}
function systemctl(args: readonly string[], allowNotFound = false): string {
  const result = spawnSync("/usr/bin/systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: scopedCollectionEnd === undefined ? 5000 : collectionTimeout(), maxBuffer: 256 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
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

/** Exact manager effects. The owner revalidates invocation/session immediately
 * before this call. A stop/cancel acknowledgment supplies no terminal evidence. */
export function requestScopedManagerEffect(args: readonly string[], remainingMs: number): void {
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) invalid();
  const cancel = args.length === 2 && args[0] === "cancel" && /^[1-9][0-9]*$/.test(args[1]!);
  const stop = args.length === 4 && args[0] === "stop" && args[1] === "--no-block" && args[2] === "--";
  const signal = args.length === 5 && args[0] === "kill" && ["--signal=SIGTERM", "--signal=SIGKILL"].includes(args[1]!) && args[2] === "--kill-whom=all" && args[3] === "--";
  if (!cancel && !stop && !signal) invalid(); if (!cancel) unit(args.at(-1)!);
  const result = spawnSync("/usr/bin/systemctl", args, { encoding: "utf8", timeout: Math.min(5000, remainingMs), maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) invalid();
}
/** Missing directories, parse failures and changed directory identities throw.
 * A retained cgroup and every descendant must positively report empty. */
export function collectScopedRecursiveEmpty(group: string, remainingMs: number): { empty: boolean; digest: string } {
  if (!/^\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-(?:ordinary|hosted)-[a-f0-9-]{36}\.service$/.test(group)) invalid();
  const end = performance.now() + remainingMs, tree: unknown[] = []; let empty = true, count = 0;
  const walk = (path: string): void => {
    if (++count > 256 || performance.now() >= end) invalid();
    const before = lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== 0) invalid();
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) invalid();
      const anchored = `/proc/self/fd/${fd}`, events = readFileSync(anchored + "/cgroup.events", "utf8"), procs = readFileSync(anchored + "/cgroup.procs", "utf8");
      const populated = scopedCgroupPopulated(events);
      if (procs && !/^(?:[1-9][0-9]*\n)+$/.test(procs)) invalid();
      if (populated || procs !== "") empty = false;
      const names = readdirSync(anchored).sort();
      for (const name of names) {
        if (!/^[A-Za-z0-9_.@+-]+$/.test(name) || name === "." || name === "..") invalid();
        const stat = lstatSync(anchored + "/" + name);
        if (stat.isSymbolicLink()) invalid();
        if (stat.isDirectory()) walk(path + "/" + name);
      }
      if (events !== readFileSync(anchored + "/cgroup.events", "utf8") || procs !== readFileSync(anchored + "/cgroup.procs", "utf8") ||
          JSON.stringify(names) !== JSON.stringify(readdirSync(anchored).sort())) invalid();
      const after = lstatSync(path); if (after.dev !== before.dev || after.ino !== before.ino) invalid();
      tree.push([path, before.dev, before.ino, events, procs, names]);
    } finally { closeSync(fd); }
  };
  walk("/sys/fs/cgroup" + group);
  return { empty, digest: createHash("sha256").update(JSON.stringify(tree)).digest("hex") };
}

// Owned proxy only, never numeric process-group signaling. pidfd pins the exact
// task; birth/group are revalidated after open and before every signal. A missing
// PID or timeout raises; only POLLIN on this retained fd observes its exit.
const scopedPidfdFence = `import os,sys,signal,select,time,json
pid=int(sys.argv[1]); birth=sys.argv[2]; group=sys.argv[3]; budget=int(sys.argv[4]); end=time.monotonic()+budget/1000
fd=os.pidfd_open(pid,0)
def check():
 s=open('/proc/'+str(pid)+'/stat').read(); actual=str(pid)+':'+s[s.rindex(') ')+2:].split()[19]
 if actual!=birth or open('/proc/'+str(pid)+'/cgroup').read().strip()!='0::'+group: raise RuntimeError('identity')
p=select.poll(); p.register(fd,select.POLLIN)
check(); signal.pidfd_send_signal(fd,signal.SIGTERM)
left=lambda: max(0,int((end-time.monotonic())*1000))
if not p.poll(min(100,left())):
 check(); signal.pidfd_send_signal(fd,signal.SIGKILL)
 if not p.poll(left()): raise RuntimeError('unresolved')
print(json.dumps({'pidBirth':birth,'controlGroup':group,'exitObserved':True},separators=(',',':')))
os.close(fd)
`;
export function fenceScopedSubmitter(pidBirth: string, controlGroup: string, remainingMs: number): void {
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(pidBirth) ||
      !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(controlGroup) ||
      controlGroup.split("/").some(p => p === "." || p === "..") || !Number.isSafeInteger(remainingMs) || remainingMs < 1) invalid();
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", scopedPidfdFence, pidBirth.split(":")[0]!, pidBirth, controlGroup, String(remainingMs)], {
    encoding: "utf8", timeout: remainingMs, maxBuffer: 4096, env: {}, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || result.stdout.trim() !== JSON.stringify({ pidBirth, controlGroup, exitObserved: true })) invalid();
}
