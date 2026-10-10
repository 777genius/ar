import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, lstatSync } from "node:fs";
import { researchInvalid, researchId, researchHash, researchCustody, researchRead, researchRecord, researchFileDigest, researchByteValidationTimeoutMs,
  ResearchHostCommandOperation, ResearchHostCommandUnitRole } from "./research-launch-files";
import { researchProviderSetupTimeoutMs } from "./research-launch-contract";
import { readKernelMountTable } from "./host-scratch-mount";

export const researchRuntimeUnitPattern = /^subscription-runtime-research-([a-f0-9-]{36})\.service$/;
export const researchProviderUnitPattern = /^subscription-runtime-research-provider-([a-f0-9-]{36})\.service$/;
export const researchControlGroup = (unit: string): string => `/system.slice/${unit}`;
export function researchCommand(command: string, args: readonly string[]): string {
  researchCustody(command);
  // Type=exec submission waits for startup; manager reads can queue behind it.
  // Allow finite Host contention only for these control-plane commands.
  const isSystemdRun = /^\/usr\/bin\/systemd-run$/.test(command);
  const ownedRuntimeStart = isSystemdRun && args.some(arg => arg.startsWith("--unit=") &&
    researchRuntimeUnitPattern.test(arg.slice("--unit=".length)));
  const timeout = ownedRuntimeStart ? researchProviderSetupTimeoutMs + 30_000
    : command === "/usr/bin/systemctl" && args[0] === "show" ? 60_000
    : command === "/usr/bin/systemctl" && args[0] === "list-jobs" ? 30_000
    : isSystemdRun ? 60_000 : 15_000;
  let started: number | undefined;
  try { started = performance.now(); } catch { /* Observation only. */ }
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    let operation = ResearchHostCommandOperation.Unknown, unitRole = ResearchHostCommandUnitRole.Unknown, elapsedMs = 0;
    try {
      const elapsed = started === undefined ? 0 : performance.now() - started;
      if (Number.isFinite(elapsed)) elapsedMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed));
    } catch { /* Observation only. */ }
    try {
      const show = command === "/usr/bin/systemctl" && args[0] === "show";
      operation = show ? ResearchHostCommandOperation.SystemctlShow
        : command === "/usr/bin/systemctl" && args[0] === "list-jobs" ? ResearchHostCommandOperation.SystemctlListJobs
        : isSystemdRun ? ResearchHostCommandOperation.SystemdRun : ResearchHostCommandOperation.Unknown;
      const unit = show ? args[1] : isSystemdRun && args[0] === "--quiet"
        ? args[1]?.startsWith("--unit=") ? args[1].slice(7)
          : args[1] === "--wait" && args[2] === "--pipe" && args[3] === "--collect" && args[4]?.startsWith("--unit=") ? args[4].slice(7) : undefined
        : undefined;
      unitRole = unit && researchRuntimeUnitPattern.test(unit) ? ResearchHostCommandUnitRole.Runtime
        : unit && researchProviderUnitPattern.test(unit) ? ResearchHostCommandUnitRole.Provider : ResearchHostCommandUnitRole.Unknown;
    } catch { /* Diagnostic failure never changes command admission. */ }
    researchInvalid((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
      ? "host-command-timeout" : "host-command-failed", operation, unitRole, elapsedMs);
  }
  return result.stdout;
}
export function assertResearchInitialRoot(operator = false): void {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0 ||
        !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/uid_map", "utf8").trim()) ||
        !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/gid_map", "utf8").trim())) researchInvalid();
    for (const ns of operator ? ["user", "mnt", "pid", "net"] : ["user", "pid", "net"]) {
      if (readlinkSync(`/proc/self/ns/${ns}`) !== readlinkSync(`/proc/1/ns/${ns}`)) researchInvalid();
    }
  } catch { researchInvalid(); }
}
/** Self-only bootstrap; a sealed reference is required before provider effects. */
export function assertResearchProviderRootIdentity(): void {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0 ||
      !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/uid_map", "utf8").trim()) ||
      !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/gid_map", "utf8").trim())) researchInvalid();
}
export type ResearchInitialHostContext = Readonly<Pick<ResearchProcessIdentity, "bootId" | "machineId" | "namespaces">>;
export function parseResearchInitialHostContext(value: unknown): ResearchInitialHostContext {
  const context = researchRecord(value, "bootId,machineId,namespaces"), ns = researchRecord(context.namespaces, "user,mnt,pid,net");
  if (typeof context.bootId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.bootId) ||
      typeof context.machineId !== "string" || !/^[a-f0-9]{32}$/.test(context.machineId)) researchInvalid();
  for (const kind of ["user", "mnt", "pid", "net"] as const) {
    const namespace = ns[kind], match = typeof namespace === "string" ? new RegExp(`^${kind}:\\[([1-9]\\d{0,9})\\]$`).exec(namespace) : null;
    if (!match || Number(match[1]) > 0xffffffff) researchInvalid();
  }
  return Object.freeze({ bootId: context.bootId, machineId: context.machineId,
    namespaces: Object.freeze({ user: ns.user as string, mnt: ns.mnt as string, pid: ns.pid as string, net: ns.net as string }) });
}
/** Mechanics only: a structural context cannot authenticate launch authority. */
export function assertResearchProviderInitialRoot(value: ResearchInitialHostContext): void {
  assertResearchProviderRootIdentity();
  const context = parseResearchInitialHostContext(value), own = researchProcessIdentity();
  if (own.bootId !== context.bootId || own.machineId !== context.machineId || own.namespaces.mnt === context.namespaces.mnt ||
      (["user", "pid", "net"] as const).some(kind => own.namespaces[kind] !== context.namespaces[kind]) ||
      readKernelMountTable().trimEnd().split("\n").some(row => row.split(" - ")[0]!.split(" ").slice(6)
        .some(field => /^(?:shared|master|propagate_from):/.test(field)))) researchInvalid();
}
/** This independent route has no authority once any global/managed authority is
 * installed, including partial installations. Those owners retain their fences. */
export function assertResearchSharedHost(): void {
  for (const path of ["/var/lib/subscription-runtime-host-policy", "/run/user/0/subscription-runtime-host-policy"]) {
    try { lstatSync(path); researchInvalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export type ResearchProcessIdentity = Readonly<{
  pid: number; birthTicks: string; bootId: string; machineId: string; controlGroup: string;
  namespaces: Readonly<{ user: string; mnt: string; pid: string; net: string }>;
}>;
/** Kernel membership may include v1 hierarchies alongside the unified manager.
 * Only the unique v2 row supplies authority; preserve its path verbatim. */
function researchUnifiedControlGroup(text: string): string | null {
  let unified: string | null = null;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const row = /^(0|[1-9][0-9]*):([^:]*):(\/[^\0\r\n]*)$/.exec(line);
    if (!row) return null;
    const [, hierarchy, controllers, group] = row;
    if (hierarchy === "0") {
      if (controllers !== "" || unified !== null) return null;
      unified = group!;
    } else if (!/^(?:[a-zA-Z0-9_-]+|name=[a-zA-Z0-9_.-]+)(?:,(?:[a-zA-Z0-9_-]+|name=[a-zA-Z0-9_.-]+))*$/.test(controllers!)) return null;
  }
  return unified;
}
export function researchProcessLifetime(pid = process.pid): Omit<ResearchProcessIdentity, "namespaces"> {
  if (!Number.isSafeInteger(pid) || pid < 1) researchInvalid();
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).split(/\s+/), birthTicks = fields[19];
  if (end < 0 || !birthTicks || !/^[1-9][0-9]*$/.test(birthTicks) || fields[0] === "Z") researchInvalid();
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId) || !/^[a-f0-9]{32}$/.test(machineId)) researchInvalid();
  const group = researchUnifiedControlGroup(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
  if (!group) researchInvalid();
  return Object.freeze({ pid, birthTicks, bootId, machineId, controlGroup: group });
}
export function researchProcessIdentity(pid = process.pid): ResearchProcessIdentity {
  const lifetime = researchProcessLifetime(pid);
  const namespaces = Object.freeze({ user: readlinkSync(`/proc/${pid}/ns/user`), mnt: readlinkSync(`/proc/${pid}/ns/mnt`),
    pid: readlinkSync(`/proc/${pid}/ns/pid`), net: readlinkSync(`/proc/${pid}/ns/net`) });
  return Object.freeze({ ...lifetime, namespaces });
}
export type ResearchServiceIdentity = Readonly<{
  unit: string; mainPid: number; controlGroup: string; invocationId: string; description: string;
  fragmentSha256: string;
}>;
export function researchServiceIdentity(unit: string, allowPending = false): ResearchServiceIdentity {
  if (!researchRuntimeUnitPattern.test(unit) && !researchProviderUnitPattern.test(unit)) researchInvalid();
  const output = researchCommand("/usr/bin/systemctl", ["show", unit, "--no-pager",
    "--property=Id,MainPID,ControlGroup,InvocationID,Description,ActiveState,SubState,Transient,FragmentPath,DropInPaths,KillMode"]);
  const values = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  // An inactive transient can already have an accepted start queued. Name alone
  // grants nothing: all fragment/cgroup/custody metadata below still must match.
  const queuedStart = allowPending && ["inactive", "failed"].includes(values.ActiveState ?? "") &&
    researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]).trim().split("\n")
      .some(line => { const fields = line.trim().split(/\s+/); return fields[1] === unit && fields[2] === "start"; });
  const pending = allowPending && (["activating", "deactivating"].includes(values.ActiveState ?? "") || queuedStart);
  if (values.Id !== unit || (!pending && (values.ActiveState !== "active" || values.SubState !== "running")) ||
      values.Transient !== "yes" || values.KillMode !== "control-group" || values.DropInPaths !== "" ||
      values.FragmentPath !== `/run/systemd/transient/${unit}` ||
      (values.ControlGroup !== researchControlGroup(unit) && !(pending && values.ControlGroup === "")) ||
      (!/^[a-f0-9]{32}$/.test(values.InvocationID ?? "") && !(pending && values.InvocationID === "")) ||
      !/^(?:0|[1-9][0-9]*)$/.test(values.MainPID ?? "") || (!pending && values.MainPID === "0")) researchInvalid();
  researchCustody(values.FragmentPath);
  return Object.freeze({ unit, mainPid: Number(values.MainPID), controlGroup: values.ControlGroup,
    invocationId: values.InvocationID!, description: values.Description ?? "",
    fragmentSha256: researchHash(researchRead(values.FragmentPath, false)) });
}
export function researchUnitFromCurrentProcess(): string | null {
  if (process.platform !== "linux") return null;
  const group = researchUnifiedControlGroup(readFileSync("/proc/self/cgroup", "utf8"));
  const unit = group === null ? undefined : /^\/system\.slice\/(subscription-runtime-research-[a-f0-9-]{36}\.service)$/.exec(group)?.[1];
  return unit ?? null;
}
export function assertResearchServiceOwner(processIdentity: ResearchProcessIdentity, service: ResearchServiceIdentity, description: string): void {
  if (service.mainPid !== processIdentity.pid || service.controlGroup !== processIdentity.controlGroup ||
      service.description !== description) researchInvalid();
}
export function researchExecutableDigest(path: string): string {
  return researchFileDigest(path, { maxBytes: 512 * 1024 * 1024, deadline: performance.now() + researchByteValidationTimeoutMs,
    cache: executableHashes, cacheEntries: 32, executable: true });
}
const executableHashes = new Map<string, { signature: string; digest: string }>();
export function researchDescription(jobId: string, specDigest: string): string {
  researchId(jobId);
  if (!/^[a-f0-9]{64}$/.test(specDigest)) researchInvalid();
  return `subscription-runtime-research:${researchHash(jobId)}:${specDigest}`;
}
