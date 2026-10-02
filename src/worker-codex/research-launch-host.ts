import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, lstatSync } from "node:fs";
import { researchInvalid, researchId, researchHash, researchCustody, researchRead, researchFileDigest } from "./research-launch-files";

export const researchRuntimeUnitPattern = /^subscription-runtime-research-([a-f0-9-]{36})\.service$/;
export const researchProviderUnitPattern = /^subscription-runtime-research-provider-([a-f0-9-]{36})\.service$/;
export const researchControlGroup = (unit: string): string => `/system.slice/${unit}`;
export function researchCommand(command: string, args: readonly string[]): string {
  researchCustody(command);
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: args[0] === "show" ? 2_000 : 15_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) researchInvalid((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
    ? "host-command-timeout" : "host-command-failed");
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
export function researchProcessIdentity(pid = process.pid): ResearchProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid < 1) researchInvalid();
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).split(/\s+/), birthTicks = fields[19];
  if (end < 0 || !birthTicks || !/^[1-9][0-9]*$/.test(birthTicks) || fields[0] === "Z") researchInvalid();
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId) || !/^[a-f0-9]{32}$/.test(machineId)) researchInvalid();
  const group = /^0::([^\n]+)$/.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8").trim())?.[1];
  if (!group) researchInvalid();
  const namespaces = Object.freeze({ user: readlinkSync(`/proc/${pid}/ns/user`), mnt: readlinkSync(`/proc/${pid}/ns/mnt`),
    pid: readlinkSync(`/proc/${pid}/ns/pid`), net: readlinkSync(`/proc/${pid}/ns/net`) });
  return Object.freeze({ pid, birthTicks, bootId, machineId, controlGroup: group, namespaces });
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
  const group = readFileSync("/proc/self/cgroup", "utf8").trim();
  const unit = /^0::\/system\.slice\/(subscription-runtime-research-[a-f0-9-]{36}\.service)$/.exec(group)?.[1];
  return unit ?? null;
}
export function assertResearchServiceOwner(processIdentity: ResearchProcessIdentity, service: ResearchServiceIdentity, description: string): void {
  if (service.mainPid !== processIdentity.pid || service.controlGroup !== processIdentity.controlGroup ||
      service.description !== description) researchInvalid();
}
export function researchExecutableDigest(path: string): string {
  return researchFileDigest(path, { maxBytes: 512 * 1024 * 1024, deadline: performance.now() + 4000,
    cache: executableHashes, cacheEntries: 32, executable: true });
}
const executableHashes = new Map<string, { signature: string; digest: string }>();
export function researchDescription(jobId: string, specDigest: string): string {
  researchId(jobId);
  if (!/^[a-f0-9]{64}$/.test(specDigest)) researchInvalid();
  return `subscription-runtime-research:${researchHash(jobId)}:${specDigest}`;
}
