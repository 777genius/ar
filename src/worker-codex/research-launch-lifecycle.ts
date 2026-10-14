import { closeSync, constants, existsSync, fsyncSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { researchCurrentStart, readResearchStartBinding, researchJobAuthority, researchCancellationHandoffGuard, researchHandoffPublicationLease, prepareResearchRegisteredHandoffAuthority } from "./research-launch-admission";
import { parseResearchGrant, parseResearchStartSpec } from "./research-launch-contract";
import { assertResearchInitialRoot, assertResearchServiceOwner, researchCommand, researchDescription,
  researchControlGroup, researchProcessIdentity, researchServiceIdentity, researchProviderUnitPattern } from "./research-launch-host";
import { researchHash, researchInvalid, researchJson, researchRead, researchRecord, researchPublish } from "./research-launch-files";
import { assertRegisteredResearchHandoffCurrent, assertRegisteredResearchHandoffPin } from "./research-registered-handoff";
import { materializeReconciledTerminalCodexGoalHandoff } from "./codex-goal-terminal-handoff-materialization";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { changedFilesFromWorkspace } from "./codex-goal-workspace-changes";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { buildRuntimeResultEnvelope, type RuntimeResultEnvelope } from "@vioxen/subscription-runtime/worker-core";
import { readResearchMimoCandidate, assertResearchMimoResultDirectories, publishResearchMimoJobArtifact } from "./research-mimo-worker-result";
import { terminalCodexGoalHandoffResultDetails } from "./codex-goal-terminal-handoff-materialization";
import { withResearchJobMutation, withResearchJobMutationAsync } from "./research-job-mutation-lock";

/** Outside initial-root owner only. The original normalized status is retained;
 * stopping a failed Worker never turns its result into successful work. */
export async function finalizeOwnedMimoWorker(jobId: string, startId: string, specSha256: string): Promise<{ jobId: string; startId: string; status: RuntimeResultEnvelope["status"] }> {
  return await withResearchJobMutationAsync(jobId, () => finalizeOwnedMimoWorkerUnlocked(jobId, startId, specSha256));
}
async function finalizeOwnedMimoWorkerUnlocked(jobId: string, startId: string, specSha256: string): Promise<{ jobId: string; startId: string; status: RuntimeResultEnvelope["status"] }> {
  assertResearchInitialRoot(true);
  let current: ReturnType<typeof researchCurrentStart>, released = false;
  try { current = researchCurrentStart(jobId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    current = terminalResearchStart(jobId); released = true;
  }
  if (current.spec.startId !== startId || researchHash(current.bytes) !== specSha256 ||
      current.spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) researchInvalid();
  const registered = current.spec.registeredHandoff;
  let assertRegisteredBytes: (() => void) | undefined;
  if (registered) {
    if (!released) await prepareResearchRegisteredHandoffAuthority(jobId, startId, assertResearchInitialRoot, true);
    assertRegisteredBytes = await assertRegisteredResearchHandoffCurrent(registered, current.spec.request);
    assertRegisteredResearchHandoffPin(current.spec, current.directory);
  }
  const candidateBytes = researchRead(join(current.directory, "mimo-candidate.json"));
  const candidate = readResearchMimoCandidate(current), publicationPath = join(current.directory, "mimo-publication.json");
  const assertTerminal = (): void => {
    const fresh = released ? terminalResearchStart(jobId) : researchCurrentStart(jobId);
    if (!fresh.bytes.equals(current.bytes) || !researchRead(join(current.directory, "mimo-candidate.json")).equals(candidateBytes) ||
        !inactiveResearchUnit(current.spec.unit, researchDescription(jobId, specSha256))) researchInvalid();
    readResearchMimoCandidate(current); assertResearchMimoResultDirectories(current);
    assertRegisteredResearchHandoffPin(current.spec, current.directory);
    for (const unit of researchProviderUnits(current.directory)) if (researchProviderLifecycle(current.directory, unit)) researchInvalid();
    assertRegisteredBytes?.();
  };
  if (!released) {
    if (registered) await withCodexGoalRegistryMutation({ registryRootDir: registered.registryRootDir,
      requireExistingRegistryRoot: true, effect: async () => {
        await assertRegisteredResearchHandoffCurrent(registered, current.spec.request);
        stopResearchStartForCancellation(jobId, current);
      } });
    else stopResearchStartForCancellation(jobId, current);
  }
  assertTerminal();
  const guard = async (): Promise<void> => {
    if (registered) assertRegisteredBytes = await assertRegisteredResearchHandoffCurrent(registered, current.spec.request);
    assertTerminal();
  };
  const publicationLease = registered && !released ? researchHandoffPublicationLease(jobId, startId) : undefined;
  const publishTerminal = async (): Promise<{ jobId: string; startId: string; status: RuntimeResultEnvelope["status"] }> => {
  if (!existsSync(publicationPath)) {
    if (released) researchInvalid();
    const workspace = await changedFilesFromWorkspace(current.spec.request.workspacePath, true);
    if (workspace.warning !== undefined) researchInvalid();
    const reconciled = await materializeReconciledTerminalCodexGoalHandoff({ config: current.spec.request, changedFiles: workspace.changedFiles,
      publicationAuthority: { assertPublicationAuthorized: guard } });
    await guard();
    const result = buildRuntimeResultEnvelope({ ...candidate, changedFiles: reconciled.changedPaths,
      artifacts: reconciled.artifacts, evidence: candidate.evidence.filter(value => value !== "patch_preserve_unavailable"),
      details: { ...candidate.details, ...terminalCodexGoalHandoffResultDetails(reconciled.handoff) }, updatedAt: new Date(candidate.updatedAt!) });
    const publish = async (): Promise<void> => {
      await guard();
      researchPublish(publicationPath, { schemaVersion: 1, specSha256, candidateSha256: researchHash(candidateBytes), result }, true);
    };
    await publish();
  }
  const publication = researchRecord(researchJson(researchRead(publicationPath)), "schemaVersion,specSha256,candidateSha256,result");
  const result = publication.result as RuntimeResultEnvelope;
  if (publication.schemaVersion !== 1 || publication.specSha256 !== specSha256 || publication.candidateSha256 !== researchHash(candidateBytes) ||
      result.status !== candidate.status || result.runId !== jobId || result.taskId !== current.spec.request.taskId) researchInvalid();
  assertTerminal();
  if (!released) {
    const publish = async (): Promise<void> => {
      await guard();
      assertRegisteredBytes?.();
      publishResearchMimoJobArtifact(current, "latest-result", result);
      assertRegisteredBytes?.();
      publishResearchMimoJobArtifact(current, "progress", { schemaVersion: 1, taskId: result.taskId,
        status: result.status === "done" ? "completed" : result.status, updatedAt: result.updatedAt, pid: 0 });
      assertTerminal(); releaseTerminalResearchStart(jobId, current, assertRegisteredBytes); // Reservation release is always last.
    };
    await publish();
  }
  return { jobId, startId, status: result.status };
  };
  return publicationLease ? await publicationLease(publishTerminal) : await publishTerminal();
}

function inactiveResearchUnit(unit: string, description?: string): boolean {
  const lines = researchCommand("/usr/bin/systemctl", ["show", unit, "--no-pager", "--property=Id,LoadState,ActiveState,MainPID,Description"]);
  const fields = Object.fromEntries(lines.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.Id !== unit || (description !== undefined && fields.LoadState !== "not-found" && fields.Description !== description)) researchInvalid();
  const inactive = (fields.Id === unit || fields.LoadState === "not-found") && fields.MainPID === "0" &&
    ["inactive", "failed"].includes(fields.ActiveState ?? "");
  if (!inactive) return false;
  const jobs = researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]);
  return !jobs.trim().split("\n").some(line => line.trim().split(/\s+/)[1] === unit);
}
function validateRuntimeLifecycle(jobId: string) {
  const current = researchCurrentStart(jobId);
  if (inactiveResearchUnit(current.spec.unit, researchDescription(jobId, researchHash(current.bytes)))) return { ...current, active: false };
  const service = researchServiceIdentity(current.spec.unit, true);
  if (service.description !== researchDescription(jobId, researchHash(current.bytes))) researchInvalid();
  let binding;
  try { binding = readResearchStartBinding(current.directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // The persisted start spec also owns a failed-before-bind service. A binding,
  // once present, cannot be substituted by a same-name unit or reused PID.
  if (service.mainPid > 0) {
    const process = researchProcessIdentity(service.mainPid);
    assertResearchServiceOwner(process, service, researchDescription(jobId, researchHash(current.bytes)));
    if (binding && (binding.specSha256 !== researchHash(current.bytes) ||
        JSON.stringify(process) !== JSON.stringify(binding.process) || JSON.stringify(service) !== JSON.stringify(binding.service))) researchInvalid();
  } else if (binding) researchInvalid();
  return { ...current, active: true };
}
export function readResearchProviderReservation(directory: string, unit: string) {
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const record = researchRecord(researchJson(researchRead(join(directory, "providers", unit + ".json"))),
    "schemaVersion,unit,runtimeUnit,specSha256,description");
  const specBytes = researchRead(join(directory, "spec.json")), spec = parseResearchStartSpec(researchJson(specBytes));
  if (directory !== join(researchJobAuthority(spec.request.jobId), "starts", spec.startId) ||
      record.schemaVersion !== 1 || record.unit !== unit || record.runtimeUnit !== spec.unit ||
      record.description !== `subscription-runtime-research-provider:${spec.startId}:${unit}` ||
      researchHash(specBytes) !== record.specSha256) researchInvalid();
  return { spec, specSha256: researchHash(specBytes), description: record.description as string };
}
export enum ResearchProviderSubmissionState { Pending = "pending", Settled = "settled" }
export const researchProviderReservationLimit = 256;
export function researchProviderUnits(directory: string): string[] {
  const names = readdirSync(join(directory, "providers"));
  if (names.length > 1024) researchInvalid();
  const units = new Set<string>();
  for (const name of names) {
    const match = /^(subscription-runtime-research-provider-[a-f0-9-]{36}\.service)(?:\.(?:owner|cancel|submission))?\.json$/.exec(name);
    if (!match || !researchProviderUnitPattern.test(match[1]!)) researchInvalid();
    units.add(match[1]!);
  }
  for (const unit of units) if (!names.includes(unit + ".json")) researchInvalid();
  return [...units];
}
/** A per-reservation fence revokes future submission/bootstrap permission. It
 * does not assert that an already accepted systemd request has been undone. */
export function assertResearchProviderNotCancelled(directory: string, unit: string): void {
  const reservation = readResearchProviderReservation(directory, unit);
  try {
    const cancel = researchRecord(researchJson(researchRead(join(directory, "providers", unit + ".cancel.json"))), "schemaVersion,unit,specSha256");
    if (cancel.schemaVersion !== 1 || cancel.unit !== unit || cancel.specSha256 !== reservation.specSha256) researchInvalid();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  researchInvalid();
}
function researchProviderServiceActive(directory: string, unit: string): boolean {
  const reservation = readResearchProviderReservation(directory, unit);
  if (inactiveResearchUnit(unit, reservation.description)) return false;
  const service = researchServiceIdentity(unit, true);
  if (service.description !== reservation.description) researchInvalid();
  const process = service.mainPid > 0 ? researchProcessIdentity(service.mainPid) : undefined;
  if (process) assertResearchServiceOwner(process, service, reservation.description);
  try {
    const owner = researchRecord(researchJson(researchRead(join(directory, "providers", unit + ".owner.json"))), "schemaVersion,process,service");
    if (owner.schemaVersion !== 1) researchInvalid();
    if (process) {
      if (JSON.stringify(owner.service) !== JSON.stringify(service) || JSON.stringify(owner.process) !== JSON.stringify(process)) researchInvalid();
    } else {
      // A legitimately stopping service can lose MainPID/cgroup/InvocationID.
      // Keep its retained owner; only corroborated unchanged metadata permits stop.
      const retained = researchRecord(owner.service, "unit,mainPid,controlGroup,invocationId,description,fragmentSha256");
      const retainedProcess = researchRecord(owner.process, "pid,birthTicks,bootId,machineId,controlGroup,namespaces");
      researchRecord(retainedProcess.namespaces, "user,mnt,pid,net");
      const host = researchProcessIdentity();
      if (retained.unit !== unit || retained.description !== service.description || retained.fragmentSha256 !== service.fragmentSha256 ||
          !Number.isSafeInteger(retained.mainPid) || (retained.mainPid as number) < 1 || retainedProcess.pid !== retained.mainPid ||
          retained.controlGroup !== researchControlGroup(unit) || retainedProcess.controlGroup !== retained.controlGroup ||
          retainedProcess.bootId !== host.bootId || retainedProcess.machineId !== host.machineId ||
          (service.invocationId !== "" && retained.invocationId !== service.invocationId) ||
          (service.controlGroup !== "" && retained.controlGroup !== service.controlGroup)) researchInvalid();
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return true;
}
function researchProviderLifecycle(directory: string, unit: string): boolean {
  if (researchProviderServiceActive(directory, unit)) return true;
  const reservation = readResearchProviderReservation(directory, unit);
  try {
    const submission = researchRecord(researchJson(researchRead(join(directory, "providers", unit + ".submission.json"))), "schemaVersion,unit,specSha256,state");
    if (submission.schemaVersion !== 1 || submission.unit !== unit || submission.specSha256 !== reservation.specSha256 ||
        !Object.values(ResearchProviderSubmissionState).includes(submission.state as ResearchProviderSubmissionState)) researchInvalid();
    // While the creator can still have a submitting helper, absence from show
    // and list-jobs is only an observation. Keep this reservation uncertain.
    if (submission.state === ResearchProviderSubmissionState.Pending &&
        !inactiveResearchUnit(reservation.spec.unit, researchDescription(reservation.spec.request.jobId, reservation.specSha256))) return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return false;
}
/** Durable cancel result, independently revalidated against actual units/jobs.
 * A missing active slot by itself never proves termination after a timeout. */
export function terminalResearchStart(jobId: string) {
  const terminal = researchRecord(researchJson(researchRead(join(researchJobAuthority(jobId), "last-terminal.json"))), "schemaVersion,startId,specSha256");
  if (terminal.schemaVersion !== 1 || typeof terminal.startId !== "string" || !/^[a-f0-9-]{36}$/.test(terminal.startId)) researchInvalid();
  const directory = join(researchJobAuthority(jobId), "starts", terminal.startId), bytes = researchRead(join(directory, "spec.json"));
  const spec = parseResearchStartSpec(researchJson(bytes));
  if (spec.request.jobId !== jobId || spec.startId !== terminal.startId || researchHash(bytes) !== terminal.specSha256 || !inactiveResearchUnit(spec.unit)) researchInvalid();
  for (const unit of researchProviderUnits(directory)) if (researchProviderLifecycle(directory, unit)) researchInvalid();
  assertRegisteredResearchHandoffPin(spec, directory);
  return { directory, bytes, spec, active: false as const };
}
export function signalResearchProvider(directory: string, unit: string, signal: NodeJS.Signals = "SIGTERM"): void {
  assertResearchInitialRoot();
  fenceResearchProvider(directory, unit);
  // Logical revocation needs only authenticated private authority. Live/foreign
  // uncertainty can refuse physical signaling, but cannot prevent this fence.
  const active = researchProviderServiceActive(directory, unit);
  if (!active) return;
  // Reservation-owned submission can be canceled before the helper publishes
  // MainPID. The exact unpredictable unit+description were persisted first.
  try { researchCommand("/usr/bin/systemctl", ["kill", `--signal=${signal}`, "--kill-whom=all", unit]); }
  catch { /* Pending services may have no MainPID. The stop request still matters. */ }
  researchCommand("/usr/bin/systemctl", ["stop", "--no-block", unit]);
}
function fenceResearchProvider(directory: string, unit: string): void {
  const reservation = readResearchProviderReservation(directory, unit);
  researchPublish(join(directory, "providers", unit + ".cancel.json"), { schemaVersion: 1, unit, specSha256: reservation.specSha256 });
}
export function statusResearchLaunch(jobId: string): { jobId: string; startId: string; unit: string; artifactSha256: string; grantSha256: string; active: boolean; providers: readonly { unit: string; active: boolean }[] } {
  assertResearchInitialRoot(true);
  let activeMissing = false;
  try { researchRead(join(researchJobAuthority(jobId), "active.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    activeMissing = true;
  }
  const current = activeMissing ? terminalResearchStart(jobId) : validateRuntimeLifecycle(jobId);
  const providers = researchProviderUnits(current.directory).map(unit => ({ unit, active: researchProviderLifecycle(current.directory, unit) }));
  return { jobId, startId: current.spec.startId, unit: current.spec.unit, artifactSha256: current.spec.artifactSha256,
    grantSha256: current.spec.grantSha256, active: current.active, providers };
}
export function cancelResearchLaunch(jobId: string): { jobId: string; startId: string; unit: string; terminal: true } {
  return withResearchJobMutation(jobId, () => cancelResearchLaunchUnlocked(jobId));
}
/** Exact enrolled ownership, grant revocation and cancellation share one fence. */
export function cancelEnrolledResearchLaunch(jobId: string, grantSha256: string, requestSha256: string) {
  return withResearchJobMutation(jobId, () => {
    assertResearchInitialRoot(true);
    if (![grantSha256, requestSha256].every(hash => /^[a-f0-9]{64}$/.test(hash))) researchInvalid();
    const directory = researchJobAuthority(jobId);
    const current = existsSync(join(directory, "active.json")) ? researchCurrentStart(jobId)
      : existsSync(join(directory, "last-terminal.json")) ? terminalResearchStart(jobId) : undefined;
    if (current && (current.spec.grantSha256 !== grantSha256 || current.spec.requestSha256 !== requestSha256)) researchInvalid();
    const path = join(directory, "grant.json");
    if (existsSync(path)) {
      const bytes = researchRead(path), grant = parseResearchGrant(researchJson(bytes));
      if (grant.registeredHandoff || grant.projectLaunchBinding || researchHash(bytes) !== grantSha256) researchInvalid();
      unlinkSync(path);
    }
    return current ? cancelResearchLaunchUnlocked(jobId) : { jobId, revoked: true as const };
  });
}
function cancelResearchLaunchUnlocked(jobId: string): { jobId: string; startId: string; unit: string; terminal: true } {
  assertResearchInitialRoot(true);
  try { researchRead(join(researchJobAuthority(jobId), "active.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const terminal = terminalResearchStart(jobId); // Late/repeated cancel still proves actual terminal units/jobs.
    return { jobId, startId: terminal.spec.startId, unit: terminal.spec.unit, terminal: true };
  }
  const current = researchCurrentStart(jobId);
  // Existing CLI cannot turn a stopped registered runtime into a preservation
  // claim. Its separate async adapter must first reconcile the dirty workspace.
  if (current.spec.registeredHandoff) researchInvalid();
  stopResearchStartForCancellation(jobId, current);
  if (current.spec.request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      existsSync(join(current.directory, "mimo-candidate.json"))) {
    throw new Error("hosted_mimo_worker_finalization_pending");
  }
  releaseTerminalResearchStart(jobId, current);
  return { jobId, startId: current.spec.startId, unit: current.spec.unit, terminal: true };
}
export type RegisteredResearchStartIdentity = Readonly<{ jobId: string; startId: string; specSha256: string; requestSha256: string }>;
export async function cancelRegisteredResearchLaunch(expected: RegisteredResearchStartIdentity): Promise<{
  jobId: string; startId: string; unit: string; terminal: true;
  handoffPacketPath?: string; handoffManifestSha256?: string; cleanWorkspace?: true;
}> {
  return await withResearchJobMutationAsync(expected.jobId, () => cancelRegisteredResearchLaunchUnlocked(expected));
}
async function cancelRegisteredResearchLaunchUnlocked(expected: RegisteredResearchStartIdentity): Promise<{
  jobId: string; startId: string; unit: string; terminal: true;
  handoffPacketPath?: string; handoffManifestSha256?: string; cleanWorkspace?: true;
}> {
  assertResearchInitialRoot(true);
  researchRecord(expected, "jobId,startId,specSha256,requestSha256");
  const { jobId } = expected;
  const current = researchCurrentStart(jobId);
  if (!current.spec.registeredHandoff || current.spec.startId !== expected.startId ||
      researchHash(current.bytes) !== expected.specSha256 || current.spec.requestSha256 !== expected.requestSha256) researchInvalid();
  // Serialize containment with publication/revoke using the immutable native
  // registry binding, even when current registered receipt/scope is invalid.
  await withCodexGoalRegistryMutation({ registryRootDir: current.spec.registeredHandoff.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
    if (!researchCurrentStart(jobId).bytes.equals(current.bytes)) researchInvalid();
    stopResearchStartForCancellation(jobId, current);
  } });
  if (current.spec.request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      existsSync(join(current.directory, "mimo-candidate.json"))) {
    throw new Error("hosted_mimo_worker_finalization_pending");
  }
  // Containment above remains possible for a revoked receipt. Publication
  // requires a fresh process-local reader after the exact owner is stopped.
  await prepareResearchRegisteredHandoffAuthority(jobId, current.spec.startId, assertResearchInitialRoot, true);
  const guard = researchCancellationHandoffGuard(jobId, current.spec.startId);
  await guard();
  const workspace = await changedFilesFromWorkspace(current.spec.request.workspacePath, true);
  if (workspace.warning !== undefined) researchInvalid();
  const preserved = await materializeReconciledTerminalCodexGoalHandoff({
    config: current.spec.request, changedFiles: workspace.changedFiles,
    publicationAuthority: { assertPublicationAuthorized: guard,
      withPublicationAuthority: researchHandoffPublicationLease(jobId, current.spec.startId) },
  });
  await guard();
  if (!researchCurrentStart(jobId).bytes.equals(current.bytes) || !inactiveResearchUnit(current.spec.unit)) researchInvalid();
  for (const unit of researchProviderUnits(current.directory)) if (researchProviderLifecycle(current.directory, unit)) researchInvalid();
  await withCodexGoalRegistryMutation({ registryRootDir: current.spec.registeredHandoff.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
    await guard();
    const assertAuthorityBytes = await assertRegisteredResearchHandoffCurrent(current.spec.registeredHandoff!, current.spec.request);
    releaseTerminalResearchStart(jobId, current, assertAuthorityBytes);
  } });
  return { jobId, startId: current.spec.startId, unit: current.spec.unit, terminal: true,
    ...(preserved.handoff?.packetPath ? { handoffPacketPath: preserved.handoff.packetPath,
      handoffManifestSha256: preserved.handoff.manifestSha256! } : {}),
    ...(!preserved.handoff && preserved.changedPaths.length === 0 ? { cleanWorkspace: true as const } : {}) };
}
function stopResearchStartForCancellation(jobId: string, current: ReturnType<typeof researchCurrentStart>): void {
  researchPublish(join(current.directory, "closing.json"), { schemaVersion: 1, specSha256: researchHash(current.bytes) });
  for (const unit of researchProviderUnits(current.directory)) fenceResearchProvider(current.directory, unit);
  const runtime = validateRuntimeLifecycle(jobId);
  // Stop the creator and its submitting helpers first, then reconcile its finite
  // reserved provider units. No helper can publish a later submission after this.
  if (runtime.active) researchCommand("/usr/bin/systemctl", ["stop", current.spec.unit]);
  if (!inactiveResearchUnit(current.spec.unit)) researchInvalid();
  // Re-enumerate after the creator is stopped: a last reservation may have
  // raced closing, but none can be created after its control group is terminal.
  let uncertain = false;
  for (const unit of researchProviderUnits(current.directory)) {
    try { signalResearchProvider(current.directory, unit); }
    catch { uncertain = true; } // Reconcile other owned units, retain everything on any doubt.
  }
  if (uncertain) researchInvalid();
  for (const unit of researchProviderUnits(current.directory)) if (researchProviderLifecycle(current.directory, unit)) researchInvalid();
}
function releaseTerminalResearchStart(jobId: string, current: ReturnType<typeof researchCurrentStart>, assertAuthorityBytes: () => void = () => {}): void {
  if (!researchCurrentStart(jobId).bytes.equals(current.bytes)) researchInvalid();
  assertRegisteredResearchHandoffPin(current.spec, current.directory);
  assertAuthorityBytes();
  researchPublish(join(researchJobAuthority(jobId), "last-terminal.json"), {
    schemaVersion: 1, startId: current.spec.startId, specSha256: researchHash(current.bytes),
  });
  // Only this exact retained terminal start loses its active slot. Pins and all
  // evidence remain until root explicitly unmounts the named TEST pins.
  if (!researchCurrentStart(jobId).bytes.equals(current.bytes)) researchInvalid();
  const job = researchJobAuthority(jobId);
  assertAuthorityBytes();
  unlinkSync(join(job, "active.json"));
  const fd = openSync(job, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
