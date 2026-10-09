import { join } from "node:path";
import type { ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { installedResearchRuntimeDirectory, researchCurrentStart, researchJobAuthority } from "./research-launch-admission";
import { assertResearchProjectLaunchBindingCurrent } from "./research-project-launch-authorization";
import { parseResearchGrant } from "./research-launch-contract";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchHash, researchJson, researchRead, assertResearchDirectory } from "./research-launch-files";
import { researchProviderReservationLimit, researchProviderUnits, terminalResearchStart } from "./research-launch-lifecycle";
import { observeResearchMimoAllocationWritableRoots } from "./research-provider-root";

function optionalPrivateRecord(path: string): Buffer | undefined {
  try { return researchRead(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
function sameOptionalBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

/** Trusted host composition only. Mapped providers cannot read owner authority.
 * Unknown is retained on incomplete preparation, unsupported executors or drift.
 * Standalone terminal status has no registered receipt binding and never releases
 * a new project claim merely because an older same-name native start stopped.
 */
export async function observeResearchJobWriterAuthority(manifest: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
  try {
    assertResearchInitialRoot(true);
    const authority = researchJobAuthority(manifest.jobId), activePath = join(authority, "active.json"), grantPath = join(authority, "grant.json");
    const active = optionalPrivateRecord(activePath), grantBytes = optionalPrivateRecord(grantPath);
    // A fresh publication census must not wait for systemd reconciliation.
    // Missing active authority is not a release proof. Terminal owner
    // reconciliation requires a separate prepared, exact-start-bound contract.
    if (active === undefined) return { status: "unknown" };
    const current = researchCurrentStart(manifest.jobId);
    const { spec } = current, request = spec.request;
    if (request.jobId !== manifest.jobId || request.taskId !== manifest.taskId || request.jobRootDir !== manifest.jobRootDir ||
        request.workspacePath !== manifest.workspacePath || request.promptPath !== manifest.promptPath ||
        request.modelBackend !== manifest.modelBackend) return { status: "unknown" };
    if (grantBytes) {
      const grant = parseResearchGrant(researchJson(grantBytes));
      if (researchHash(grantBytes) !== spec.grantSha256 || grant.jobId !== manifest.jobId ||
          grant.jobRootDir !== manifest.jobRootDir || grant.workspacePath !== manifest.workspacePath) return { status: "unknown" };
    }
    const assertProjectBytes = spec.projectLaunchBinding
      ? await assertResearchProjectLaunchBindingCurrent(spec.projectLaunchBinding, request) : undefined;
    const assertCurrent = (): boolean => sameOptionalBytes(active, optionalPrivateRecord(activePath)) &&
      sameOptionalBytes(grantBytes, optionalPrivateRecord(grantPath));
    // The installed path must match the protected first-plan profile provenance;
    // this path comparison is not a fresh artifact digest qualification. Actual
    // executable bytes remain checked by the provider effect guards. Older
    // artifacts never acquire this profile from a caller/manifest flag.
    if (spec.runtimeDirectory !== installedResearchRuntimeDirectory()) return { status: "unknown" };
    // Allocated plans count before provider heartbeat and remain reserved after
    // revocation or uncertain submission. Missing plan is uncertainty, not release.
    const units = researchProviderUnits(current.directory);
    if (!units.length || units.length > researchProviderReservationLimit) return { status: "unknown" };
    assertResearchDirectory(spec.jobDirectory, join(current.directory, "pins/job"));
    assertResearchDirectory(spec.workspaceDirectory, join(current.directory, "pins/workspace"));
    const roots = observeResearchMimoAllocationWritableRoots(spec)
      .map(({ device, backingPath }) => ({ device, backingPath }));
    if (!researchCurrentStart(manifest.jobId).bytes.equals(current.bytes) || !assertCurrent() ||
        JSON.stringify(researchProviderUnits(current.directory)) !== JSON.stringify(units)) return { status: "unknown" };
    assertProjectBytes?.();
    return { status: "allocated", roots };
  } catch {
    return { status: "unknown" };
  }
}

/** Prepare actual terminal closure outside publication coordination. The retained
 * reader checks bytes again, so a successor grant/active slot cannot inherit it. */
export async function prepareResearchJobWriterObservation(manifest: CodexGoalJobManifest): Promise<() => Promise<ProjectAdmissionWriterObservation>> {
  const unknown = async (): Promise<ProjectAdmissionWriterObservation> => ({ status: "unknown" });
  try {
    assertResearchInitialRoot(true);
    const authority = researchJobAuthority(manifest.jobId), activePath = join(authority, "active.json");
    if (optionalPrivateRecord(activePath) !== undefined) return async () => await observeResearchJobWriterAuthority(manifest);
    const terminalPath = join(authority, "last-terminal.json"), grantPath = join(authority, "grant.json");
    const terminalBytes = researchRead(terminalPath), grantBytes = researchRead(grantPath);
    const current = terminalResearchStart(manifest.jobId), { spec } = current;
    const binding = spec.projectLaunchBinding;
    if (!binding || spec.request.jobId !== manifest.jobId || spec.request.taskId !== manifest.taskId ||
        spec.request.jobRootDir !== manifest.jobRootDir || spec.request.workspacePath !== manifest.workspacePath ||
        spec.request.promptPath !== manifest.promptPath || spec.request.modelBackend !== manifest.modelBackend ||
        researchHash(grantBytes) !== spec.grantSha256 || spec.runtimeDirectory !== installedResearchRuntimeDirectory()) return unknown;
    const assertProjectBytes = await assertResearchProjectLaunchBindingCurrent(binding, spec.request);
    const read = async (): Promise<ProjectAdmissionWriterObservation> => {
      try {
        assertResearchInitialRoot(true);
        if (optionalPrivateRecord(activePath) !== undefined || !researchRead(terminalPath).equals(terminalBytes) ||
            !researchRead(grantPath).equals(grantBytes) || !researchRead(join(current.directory, "spec.json")).equals(current.bytes)) return { status: "unknown" };
        assertProjectBytes();
        return { status: "released" };
      } catch { return { status: "unknown" }; }
    };
    // Preparation also has an async gap. A changed origin is never retained.
    if ((await read()).status !== "released") return unknown;
    return read;
  } catch { return unknown; }
}
