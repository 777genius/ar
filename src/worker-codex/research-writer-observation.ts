import { lstatSync, readFileSync } from "node:fs";
import { observeHostedOrdinaryJobWriterAuthority, hostedOrdinaryWriterAuthorityAbsent, isHostedOrdinaryRuntime } from "./hosted-ordinary-writer-authority";
import { observeCompatibleProtectedCodexGoalJobBirth, protectedCodexGoalJobBirthNamespacePresent, protectedCodexGoalJobBirthPublicationActive } from "./protected-job-birth";
import { pathToFileURL } from "node:url";
import { researchJobRuntimeNamespaceAbsent, researchJobRuntimeProvenance } from "./research-job-runtime-provenance";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import { join } from "node:path";
import type { ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { installedResearchRuntimeDirectory, researchCurrentStart, researchJobAuthority } from "./research-launch-admission";
import { assertResearchProjectLaunchBindingCurrent } from "./research-project-launch-authorization";
import { assertRegisteredResearchHandoffCurrent } from "./research-registered-handoff";
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

/** A private owner namespace selects cold scoped admission; it does not assert
 * a positive profile or release. Retained/malformed/revoked owners cannot fall
 * back to the legacy global gate merely because their positive reader fails. */
export function researchJobWriterOwnerNamespacePresent(manifest: CodexGoalJobManifest): boolean {
  if (process.platform !== "linux") return false;
  try {
    // Controlled namespaces hide the private roots. Kernel routing facts still
    // force cold qualification; they never supply positive writer authority.
    if (isHostedOrdinaryRuntime() || /^0::\/system\.slice\/subscription-runtime-research-[a-f0-9-]{36}\.service$/m
      .test(readFileSync("/proc/self/cgroup", "utf8"))) return true;
    try { lstatSync(researchJobAuthority(manifest.jobId)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return !hostedOrdinaryWriterAuthorityAbsent(manifest.jobId) ||
      protectedCodexGoalJobBirthNamespacePresent(manifest.jobRootDir);
  } catch { return true; }
}

/** Trusted host composition only. Mapped providers cannot read owner authority.
 * Unknown is retained on incomplete preparation, unsupported executors or drift.
 * Standalone terminal status has no registered receipt binding and never releases
 * a new project claim merely because an older same-name native start stopped.
 */
async function observeNativeResearchJobWriterAuthority(manifest: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
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
    const assertAuthorityBytes = spec.registeredHandoff
      ? await assertRegisteredResearchHandoffCurrent(spec.registeredHandoff, request)
      : spec.projectLaunchBinding ? await assertResearchProjectLaunchBindingCurrent(spec.projectLaunchBinding, request) : undefined;
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
    assertAuthorityBytes?.();
    if (!researchCurrentStart(manifest.jobId).bytes.equals(current.bytes) || !assertCurrent()) return { status: "unknown" };
    return { status: "allocated", roots };
  } catch {
    return { status: "unknown" };
  }
}

/** Prepare actual terminal closure outside publication coordination. The retained
 * reader checks bytes again, so a successor grant/active slot cannot inherit it. */
async function prepareNativeResearchJobWriterObservation(manifest: CodexGoalJobManifest): Promise<() => Promise<ProjectAdmissionWriterObservation>> {
  const unknown = async (): Promise<ProjectAdmissionWriterObservation> => ({ status: "unknown" });
  try {
    assertResearchInitialRoot(true);
    const authority = researchJobAuthority(manifest.jobId), activePath = join(authority, "active.json");
    if (optionalPrivateRecord(activePath) !== undefined) return async () => await observeResearchJobWriterAuthority(manifest);
    const terminalPath = join(authority, "last-terminal.json"), grantPath = join(authority, "grant.json");
    const terminalBytes = researchRead(terminalPath), grantBytes = researchRead(grantPath);
    const current = terminalResearchStart(manifest.jobId), { spec } = current;
    if ((!spec.projectLaunchBinding && !spec.registeredHandoff) || spec.request.jobId !== manifest.jobId || spec.request.taskId !== manifest.taskId ||
        spec.request.jobRootDir !== manifest.jobRootDir || spec.request.workspacePath !== manifest.workspacePath ||
        spec.request.promptPath !== manifest.promptPath || spec.request.modelBackend !== manifest.modelBackend ||
        researchHash(grantBytes) !== spec.grantSha256 || spec.runtimeDirectory !== installedResearchRuntimeDirectory()) return unknown;
    const assertAuthorityBytes = spec.registeredHandoff
      ? await assertRegisteredResearchHandoffCurrent(spec.registeredHandoff, spec.request)
      : await assertResearchProjectLaunchBindingCurrent(spec.projectLaunchBinding!, spec.request);
    const read = async (): Promise<ProjectAdmissionWriterObservation> => {
      try {
        assertResearchInitialRoot(true);
        if (optionalPrivateRecord(activePath) !== undefined || !researchRead(terminalPath).equals(terminalBytes) ||
            !researchRead(grantPath).equals(grantBytes) || !researchRead(join(current.directory, "spec.json")).equals(current.bytes)) return { status: "unknown" };
        assertAuthorityBytes();
        if (optionalPrivateRecord(activePath) !== undefined || !researchRead(terminalPath).equals(terminalBytes) ||
            !researchRead(grantPath).equals(grantBytes) || !researchRead(join(current.directory, "spec.json")).equals(current.bytes)) return { status: "unknown" };
        return { status: "released" };
      } catch { return { status: "unknown" }; }
    };
    // Preparation also has an async gap. A changed origin is never retained.
    if ((await read()).status !== "released") return unknown;
    return read;
  } catch { return unknown; }
}

/** Namespace precedence is positive absence, never a failed native parse.
 * A retained native directory (including malformed/incomplete authority) owns
 * the answer and cannot inherit an older ordinary or never-started release. */
function nativeAuthorityAbsent(manifest: CodexGoalJobManifest): boolean {
  return researchJobRuntimeNamespaceAbsent(manifest.jobId);
}
async function observeNonNativeWriter(manifest: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
  if (!nativeAuthorityAbsent(manifest)) return { status: "unknown" };
  const ordinary = await observeHostedOrdinaryJobWriterAuthority(manifest);
  if (!nativeAuthorityAbsent(manifest)) return { status: "unknown" };
  if (ordinary.status !== "unknown") return ordinary;
  if (!hostedOrdinaryWriterAuthorityAbsent(manifest.jobId)) return { status: "unknown" };
  const birth = await observeCompatibleProtectedCodexGoalJobBirth(manifest);
  return nativeAuthorityAbsent(manifest) && hostedOrdinaryWriterAuthorityAbsent(manifest.jobId) ? birth : { status: "unknown" };
}
export async function observeResearchJobWriterAuthority(manifest: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
  const original = await prepareOriginalNativeWriterObservation(manifest);
  if (original) return await original();
  const absent = nativeAuthorityAbsent(manifest);
  const native = await observeNativeResearchJobWriterAuthority(manifest);
  return native.status !== "unknown" || !absent ? native : await observeNonNativeWriter(manifest);
}
type WriterReader = () => Promise<ProjectAdmissionWriterObservation>;
type ForeignModulePreparer = (manifest: CodexGoalJobManifest) => Promise<unknown>;
type WriterModuleImporter = (url: string) => Promise<Record<string, unknown>>;
const importWriterModule: WriterModuleImporter = async url => await import(url);

/** One admission preparation owns only verified module functions. Every job
 * still prepares a separate reader and freshly checks its retained authority. */
export function createResearchJobWriterObservationPreparer(importModule: WriterModuleImporter = importWriterModule):
  (manifest: CodexGoalJobManifest) => Promise<WriterReader> {
  const modules = new Map<string, ForeignModulePreparer>();
  return manifest => prepareWriterObservation(manifest, importModule, modules);
}
export async function prepareResearchJobWriterObservation(manifest: CodexGoalJobManifest): Promise<WriterReader> {
  return prepareWriterObservation(manifest, importWriterModule);
}
async function prepareWriterObservation(manifest: CodexGoalJobManifest, importModule: WriterModuleImporter,
  modules?: Map<string, ForeignModulePreparer>): Promise<WriterReader> {
  const original = await prepareOriginalWriter(manifest, importModule, modules);
  if (original) return original;
  const absent = nativeAuthorityAbsent(manifest), native = await prepareNativeResearchJobWriterObservation(manifest);
  return async () => {
    const observation = await native();
    return observation.status !== "unknown" || !absent ? observation : await observeNonNativeWriter(manifest);
  };
}

/** Preparation is outside publication. Retained native authority is checked by
 * its original composition; its prepared cold reader cannot become a new launch.
 * A direct foreign observation inside publication retains unknown instead of
 * importing another module with an independent reentrancy capability. */
export async function prepareOriginalNativeWriterObservation(manifest: CodexGoalJobManifest,
  importModule: WriterModuleImporter = importWriterModule): Promise<WriterReader | undefined> {
  return prepareOriginalWriter(manifest, importModule);
}
async function prepareOriginalWriter(manifest: CodexGoalJobManifest, importModule: WriterModuleImporter,
  modules?: Map<string, ForeignModulePreparer>): Promise<WriterReader | undefined> {
  const origin = researchJobRuntimeProvenance(manifest);
  if (!origin || origin.runtimeDirectory === installedResearchRuntimeDirectory()) return undefined;
  const unknown = async (): Promise<ProjectAdmissionWriterObservation> => ({ status: "unknown" });
  if (protectedCodexGoalJobBirthPublicationActive()) return unknown;
  try {
    const guard = (): void => {
      origin.assertCurrent();
      assertQualifiedResearchRuntimeArtifact(origin.runtimeDirectory, origin.artifactSha256);
      origin.assertCurrent();
    };
    const key = JSON.stringify([origin.runtimeDirectory, origin.artifactSha256]);
    let prepare = modules?.get(key);
    if (!prepare) {
      guard(); // Each actual import has fresh executable qualification on both sides.
      const module = await importModule(pathToFileURL(join(origin.runtimeDirectory, "dist/worker-codex/research-writer-observation.js")).href);
      guard();
      const candidate = module.prepareResearchJobWriterObservation;
      if (typeof candidate !== "function") return unknown;
      prepare = manifest => Reflect.apply(candidate, module, [manifest]) as Promise<unknown>;
      modules?.set(key, prepare);
    }
    origin.assertCurrent();
    const read = await prepare(manifest) as WriterReader;
    guard();
    if (typeof read !== "function") return unknown;
    return async () => {
      try { guard(); const observation = await read(); guard(); return observation; }
      catch { return { status: "unknown" }; }
    };
  } catch { return unknown; }
}
