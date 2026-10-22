import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { researchJobAuthority } from "../research-launch-admission";
import { parseResearchStartSpec } from "../research-launch-contract";
import { researchCommand } from "../research-launch-host";
import { researchJson, researchRead } from "../research-launch-files";
import { readResearchColdMountTable } from "../research-mount-witness-frame";
import { JobRetirementPinAction, JobRetirementRefusal, refuseRetirement, type DirectoryIdentityRecord,
  type JobRetirementPin } from "./job-retirement-contract";

/** Initial host namespace facts and effects, a seam for disposable TEST fixtures only. */
export type RetirementHost = Readonly<{
  /** `/proc/1/mountinfo` of the initial host namespace. */
  mountTable(): string;
  unmount(target: string): void;
  /** Device and inode a path shows now; for a mounted pin, its source's. */
  identity(path: string): Readonly<{ device: number; inode: number }>;
  bootId(): string;
}>;
export const systemRetirementHost: RetirementHost = Object.freeze({
  mountTable: readResearchColdMountTable,
  // Never lazy: a busy pin stays mounted and the retirement refuses.
  unmount: (target: string) => { researchCommand("/usr/bin/umount", ["--", target]); },
  identity: (path: string) => { const stat = lstatSync(path); return { device: stat.dev, inode: stat.ino }; },
  bootId: () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
});
const pinNames = ["job", "workspace", "durable-handoff"] as const;
type PlannedPin = Readonly<{ path: string; expected?: Readonly<{ device: number; inode: number }> }>;

function mountTargets(table: string): string[] {
  return table.trimEnd().split("\n").filter(Boolean).map(line => {
    const parts = line.split(" "), separator = parts.indexOf("-");
    if (separator < 6 || parts.length !== separator + 4) refuseRetirement(JobRetirementRefusal.PinUnexpected);
    return parts[4]!.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  });
}
function entries(path: string): string[] | undefined {
  try { return readdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Every pin of every start of a native job, with the directory its spec bound
 * there. Every start must belong to this exact manifest and workspace directory. */
export function plannedJobPins(manifest: CodexGoalJobManifest, workspace: DirectoryIdentityRecord): PlannedPin[] {
  const jobId = manifest.jobId, starts = join(researchJobAuthority(jobId), "starts"), pins: PlannedPin[] = [];
  for (const startId of entries(starts) ?? []) {
    const directory = join(starts, startId);
    let spec: ReturnType<typeof parseResearchStartSpec>;
    try { spec = parseResearchStartSpec(researchJson(researchRead(join(directory, "spec.json")))); }
    catch { return refuseRetirement(JobRetirementRefusal.PinUnexpected); }
    if (spec.startId !== startId || spec.request.jobId !== jobId || spec.request.jobRootDir !== manifest.jobRootDir ||
        spec.request.workspacePath !== manifest.workspacePath || spec.jobDirectory.path !== manifest.jobRootDir ||
        spec.workspaceDirectory.path !== workspace.path || spec.workspaceDirectory.device !== workspace.device ||
        spec.workspaceDirectory.inode !== workspace.inode) refuseRetirement(JobRetirementRefusal.PinUnexpected);
    const expected = { job: spec.jobDirectory, workspace: spec.workspaceDirectory, "durable-handoff": spec.registeredHandoff?.durableDirectory };
    for (const name of pinNames) {
      const identity = expected[name];
      pins.push({ path: join(directory, "pins", name), ...(identity ? { expected: { device: identity.device, inode: identity.inode } } : {}) });
    }
  }
  return pins;
}
/** Read-only: each pin is unmounted already or mounts exactly its spec source. */
export function assertJobPinsRemovable(pins: readonly PlannedPin[], host: RetirementHost = systemRetirementHost): void {
  const targets = mountTargets(host.mountTable());
  for (const pin of pins) {
    if (targets.some(target => target.startsWith(pin.path + "/"))) refuseRetirement(JobRetirementRefusal.PinUnexpected);
    const mounted = targets.filter(target => target === pin.path).length;
    if (mounted === 0) {
      if ((entries(pin.path) ?? []).length) refuseRetirement(JobRetirementRefusal.PinUnexpected);
      continue;
    }
    const shown = host.identity(pin.path);
    if (mounted > 1 || !pin.expected || shown.device !== pin.expected.device || shown.inode !== pin.expected.inode)
      refuseRetirement(JobRetirementRefusal.PinUnexpected);
  }
}
/** Unmount the job's host-namespace pins. Copies inherited by other mount
 * namespaces are outside this command; the host tool checks every namespace. */
export function tearDownJobPins(pins: readonly PlannedPin[], host: RetirementHost = systemRetirementHost): JobRetirementPin[] {
  assertJobPinsRemovable(pins, host);
  const result: JobRetirementPin[] = [];
  for (const pin of pins) {
    if (!mountTargets(host.mountTable()).includes(pin.path)) {
      if (entries(pin.path) !== undefined) result.push({ path: pin.path, action: JobRetirementPinAction.NotMounted });
      continue;
    }
    try { host.unmount(pin.path); } catch { return refuseRetirement(JobRetirementRefusal.PinBusy); }
    if (mountTargets(host.mountTable()).includes(pin.path)) refuseRetirement(JobRetirementRefusal.PinBusy);
    if ((entries(pin.path) ?? []).length) refuseRetirement(JobRetirementRefusal.PinUnexpected);
    result.push({ path: pin.path, action: JobRetirementPinAction.Unmounted });
  }
  return result;
}
