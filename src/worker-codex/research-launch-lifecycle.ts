import { settleResearchMimoCapacityRecovery } from "./research-mimo-capacity-recovery";
import { handoffPreservationBudget, handoffPreservationRefusalReason, type HandoffPreservationRefusalReason } from "./codex-goal-handoff-preservation-budget";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { researchCurrentStart, readResearchStartBinding, researchJobAuthority, researchCancellationHandoffGuard, researchHandoffPublicationLease, prepareResearchRegisteredHandoffAuthority } from "./research-launch-admission";
import { parseResearchGrant, parseResearchStartSpec } from "./research-launch-contract";
import { assertResearchInitialRoot, assertResearchServiceOwner, researchCommand, researchDescription,
  researchControlGroup, researchProcessIdentity, researchServiceIdentity, researchProviderUnitPattern } from "./research-launch-host";
import { researchHash, researchInvalid, researchJson, researchRead, researchRecord, researchPublish } from "./research-launch-files";
import { assertRegisteredResearchHandoffCurrent, assertRegisteredResearchHandoffPin, withRegisteredResearchHandoffPublication } from "./research-registered-handoff";
import { materializeReconciledTerminalCodexGoalHandoff, TerminalHandoffCaptureMode } from "./codex-goal-terminal-handoff-materialization";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { changedFilesFromWorkspace } from "./codex-goal-workspace-changes";
import { boundedChangedFiles, boundedChangedFilesNotes, changedFilesTruncatedEvidence, type WorkspaceChangedFilesWarning } from "./codex-goal-changed-files-report";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { buildRuntimeResultEnvelope, type RuntimeResultEnvelope } from "@vioxen/subscription-runtime/worker-core";
import { readResearchMimoCandidate, assertResearchMimoResultDirectories, publishResearchMimoJobArtifact } from "./research-mimo-worker-result";
import { terminalCodexGoalHandoffResultDetails } from "./codex-goal-terminal-handoff-materialization";
import { withResearchJobMutation, withResearchJobMutationAsync } from "./research-job-mutation-lock";
import { installedResearchRuntimeDirectory } from "./research-launch-admission";
import { assertResearchDirectory, researchArtifactDigest, researchCustody, researchDirectoryIdentity } from "./research-launch-files";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import { readResearchColdMountTable, researchMountWitnessRows } from "./research-mount-witness-frame";
import { prepareResearchTerminalHandoffRepair, releaseResearchStoppedBeforeProvider } from "./research-terminal-handoff-repair";

/** Native-only trusted composition port. A fixed reviewed owner adapter binds
 * its original service/terminal invocation to these exact immutable inputs.
 * A serialized request, PID or terminal boolean cannot implement this port. */
export type UnsubmittedResearchStartSubmitterProof = Readonly<RegisteredResearchStartIdentity & {
  ownerSha256: string; auditSha256: string; assertTerminal(): void;
}>;
enum ResearchEarlyAbortKind { Unsubmitted = "unsubmitted" }
function optionalResearchBytes(path: string): Buffer | undefined {
  try { return researchRead(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
function assertUnsubmittedResearchStart(current: ReturnType<typeof researchCurrentStart>): unknown[] {
  const { spec, directory } = current;
  if (!spec.registeredHandoff || spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan ||
      !inactiveResearchUnit(spec.unit, researchDescription(spec.request.jobId, researchHash(current.bytes)))) researchInvalid();
  const cgroup = "/sys/fs/cgroup" + researchControlGroup(spec.unit);
  let groupPresent = true;
  try { const stat = lstatSync(cgroup); if (!stat.isDirectory() || stat.isSymbolicLink()) researchInvalid(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; groupPresent = false; }
  if (groupPresent) {
    const populated = readFileSync(join(cgroup, "cgroup.events"), "utf8").split("\n").filter(row => /^populated\s/.test(row));
    if (populated.length !== 1 || populated[0] !== "populated 0") researchInvalid();
  }
  researchCustody(directory, true);
  if (readdirSync(directory).some(name => !["spec.json", "pins", "providers", "closing.json", "unsubmitted-abort.json"].includes(name)) ||
      researchProviderUnits(directory).length !== 0) researchInvalid();
  assertResearchDirectory(spec.jobDirectory); assertResearchDirectory(spec.workspaceDirectory);
  const pins = join(directory, "pins"), identities: unknown[] = [researchDirectoryIdentity(pins)];
  researchCustody(pins, true);
  if (readdirSync(pins).some(name => !["job", "workspace", "durable-handoff"].includes(name))) researchInvalid();
  for (const name of ["job", "workspace", "durable-handoff"]) {
    const path = join(pins, name);
    try { researchCustody(path, true); identities.push(researchDirectoryIdentity(path)); if (readdirSync(path).length) researchInvalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; identities.push({ path, absent: true }); }
  }
  // One complete cold frame, corroborated by findmnt and stable end readback.
  // Missing individual pin records never substitute for this no-mount proof.
  const table = readResearchColdMountTable(), rows = researchMountWitnessRows(), ids = new Set<number>();
  for (const line of table.trimEnd().split("\n")) {
    const parts = line.split(" "), separator = parts.indexOf("-"), id = Number(parts[0]);
    if (separator < 6 || parts.length !== separator + 4 || !Number.isSafeInteger(id) || id < 1 || ids.has(id)) researchInvalid();
    ids.add(id);
    const target = parts[4]!.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (rows.get(id)?.target !== target || target === pins || target.startsWith(pins + "/")) researchInvalid();
  }
  if (ids.size !== rows.size || readResearchColdMountTable() !== table) researchInvalid();
  return identities;
}
async function originalAbortAuthority(current: ReturnType<typeof researchCurrentStart>) {
  const { spec } = current;
  assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256);
  const module = spec.runtimeDirectory === installedResearchRuntimeDirectory()
    ? { assertRegisteredResearchHandoffCurrent, withRegisteredResearchHandoffPublication }
    : await import(pathToFileURL(join(spec.runtimeDirectory, "dist/worker-codex/research-registered-handoff.js")).href) as {
      assertRegisteredResearchHandoffCurrent: typeof assertRegisteredResearchHandoffCurrent;
      withRegisteredResearchHandoffPublication: typeof withRegisteredResearchHandoffPublication;
    };
  if (typeof module.assertRegisteredResearchHandoffCurrent !== "function" || typeof module.withRegisteredResearchHandoffPublication !== "function") researchInvalid();
  assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256);
  return module;
}
/** Explicit reservation abort, never a worker result or preservation receipt.
 * No unit is submitted/signaled, mount removed, grant revoked or input edited. */
export async function abortUnsubmittedRegisteredResearchLaunch(expected: RegisteredResearchStartIdentity,
  submitter: UnsubmittedResearchStartSubmitterProof): Promise<RegisteredResearchStartIdentity & { terminal: true; abortedBeforeSubmission: true }> {
  assertResearchInitialRoot(true);
  researchRecord(expected, "jobId,startId,specSha256,requestSha256");
  researchRecord(submitter, "jobId,startId,specSha256,requestSha256,ownerSha256,auditSha256,assertTerminal");
  if (typeof submitter.assertTerminal !== "function" || ![submitter.ownerSha256, submitter.auditSha256].every(value => /^[a-f0-9]{64}$/.test(value)) ||
      !isDeepStrictEqual(expected, { jobId: submitter.jobId, startId: submitter.startId,
        specSha256: submitter.specSha256, requestSha256: submitter.requestSha256 })) researchInvalid();
  return await withResearchJobMutationAsync(expected.jobId, async () => {
    const authority = researchJobAuthority(expected.jobId), activePath = join(authority, "active.json");
    const active = optionalResearchBytes(activePath);
    const current = active ? researchCurrentStart(expected.jobId) : terminalResearchStart(expected.jobId);
    if (current.spec.startId !== expected.startId || researchHash(current.bytes) !== expected.specSha256 ||
        current.spec.requestSha256 !== expected.requestSha256 || !current.spec.registeredHandoff) researchInvalid();
    const grantPath = join(authority, "grant.json"), grant = researchRead(grantPath), requestPath = join(authority, "project-worker-request.json");
    const request = researchRead(requestPath);
    if (researchHash(grant) !== current.spec.grantSha256 || researchHash(request) !== expected.requestSha256) researchInvalid();
    const original = await originalAbortAuthority(current);
    return await original.withRegisteredResearchHandoffPublication(current.spec.registeredHandoff, current.spec.request, async () => {
      const assertRegistered = await original.assertRegisteredResearchHandoffCurrent(current.spec.registeredHandoff!, current.spec.request);
      const guard = () => {
        assertQualifiedResearchRuntimeArtifact(current.spec.runtimeDirectory, current.spec.artifactSha256);
        submitter.assertTerminal(); assertRegistered();
        const fresh = optionalResearchBytes(activePath);
        if (active ? !fresh?.equals(active) : fresh !== undefined || terminalResearchStart(expected.jobId).spec.startId !== expected.startId) researchInvalid();
        if (!researchRead(grantPath).equals(grant) || !researchRead(requestPath).equals(request) ||
            !researchRead(join(current.directory, "spec.json")).equals(current.bytes)) researchInvalid();
        const closingBytes = optionalResearchBytes(join(current.directory, "closing.json"));
        if (closingBytes && !isDeepStrictEqual(researchJson(closingBytes), { schemaVersion: 1, specSha256: expected.specSha256 })) researchInvalid();
        return assertUnsubmittedResearchStart(current);
      };
      const pins = guard(), closing = join(current.directory, "closing.json"), abort = join(current.directory, "unsubmitted-abort.json");
      if (!optionalResearchBytes(closing)) researchPublish(closing, { schemaVersion: 1, specSha256: expected.specSha256 }, true);
      if (!isDeepStrictEqual(researchJson(researchRead(closing)), { schemaVersion: 1, specSha256: expected.specSha256 })) researchInvalid();
      const producer = installedResearchRuntimeDirectory(), producerSha = researchArtifactDigest(producer);
      assertQualifiedResearchRuntimeArtifact(producer, producerSha);
      const record = { schemaVersion: 1, kind: ResearchEarlyAbortKind.Unsubmitted, ...expected,
        grantSha256: current.spec.grantSha256, submitterOwnerSha256: submitter.ownerSha256, submitterAuditSha256: submitter.auditSha256,
        producerRuntimeDirectory: producer, producerArtifactSha256: producerSha, unmountedPins: pins };
      const previous = optionalResearchBytes(abort);
      if (previous && !isDeepStrictEqual(researchJson(previous), record)) researchInvalid();
      if (!isDeepStrictEqual(guard(), pins)) researchInvalid();
      assertQualifiedResearchRuntimeArtifact(producer, producerSha);
      if (!previous) researchPublish(abort, record, true);
      if (active) {
        if (!isDeepStrictEqual(guard(), pins)) researchInvalid();
        researchPublish(join(authority, "last-terminal.json"), { schemaVersion: 1, startId: expected.startId, specSha256: expected.specSha256 });
        if (!isDeepStrictEqual(guard(), pins)) researchInvalid(); // Reservation release is last.
        assertQualifiedResearchRuntimeArtifact(producer, producerSha);
        if (!isDeepStrictEqual(researchJson(researchRead(closing)), { schemaVersion: 1, specSha256: expected.specSha256 }) ||
            !isDeepStrictEqual(researchJson(researchRead(abort)), record)) researchInvalid();
        unlinkSync(activePath);
        const fd = openSync(authority, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      return { ...expected, terminal: true as const, abortedBeforeSubmission: true as const };
    });
  });
}
/** Prepared outside publication. Only an explicit qualified private abort can
 * release this registered origin; absent pins/active never prove release. */
export async function prepareUnsubmittedResearchStartRelease(jobId: string): Promise<(() => void) | undefined> {
  assertResearchInitialRoot(true);
  const authority = researchJobAuthority(jobId);
  if (optionalResearchBytes(join(authority, "active.json"))) return;
  const terminal = researchRead(join(authority, "last-terminal.json"));
  const slot = researchRecord(researchJson(terminal), "schemaVersion,startId,specSha256");
  if (slot.schemaVersion !== 1 || typeof slot.startId !== "string" || !/^[a-f0-9-]{36}$/.test(slot.startId)) researchInvalid();
  const directory = join(authority, "starts", slot.startId), bytes = researchRead(join(directory, "spec.json"));
  const current = { directory, bytes, spec: parseResearchStartSpec(researchJson(bytes)) };
  if (current.spec.request.jobId !== jobId || researchHash(bytes) !== slot.specSha256 || !current.spec.registeredHandoff) researchInvalid();
  const abort = optionalResearchBytes(join(directory, "unsubmitted-abort.json"));
  if (!abort) return;
  const r = researchRecord(researchJson(abort), "schemaVersion,kind,jobId,startId,specSha256,requestSha256,grantSha256,submitterOwnerSha256,submitterAuditSha256,producerRuntimeDirectory,producerArtifactSha256,unmountedPins");
  if (r.schemaVersion !== 1 || r.kind !== ResearchEarlyAbortKind.Unsubmitted || r.jobId !== jobId || r.startId !== slot.startId ||
      r.specSha256 !== slot.specSha256 || r.requestSha256 !== current.spec.requestSha256 || r.grantSha256 !== current.spec.grantSha256 ||
      typeof r.submitterOwnerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.submitterOwnerSha256) ||
      typeof r.submitterAuditSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.submitterAuditSha256) ||
      typeof r.producerRuntimeDirectory !== "string" || typeof r.producerArtifactSha256 !== "string") researchInvalid();
  assertQualifiedResearchRuntimeArtifact(r.producerRuntimeDirectory, r.producerArtifactSha256);
  const original = await originalAbortAuthority(current);
  const assertRegistered = await original.assertRegisteredResearchHandoffCurrent(current.spec.registeredHandoff!, current.spec.request);
  assertQualifiedResearchRuntimeArtifact(current.spec.runtimeDirectory, current.spec.artifactSha256);
  assertQualifiedResearchRuntimeArtifact(r.producerRuntimeDirectory, r.producerArtifactSha256);
  if (!isDeepStrictEqual(assertUnsubmittedResearchStart(current), r.unmountedPins)) researchInvalid();
  const grant = researchRead(join(authority, "grant.json")), request = researchRead(join(authority, "project-worker-request.json"));
  if (researchHash(grant) !== current.spec.grantSha256 || researchHash(request) !== current.spec.requestSha256) researchInvalid();
  const closing = researchRead(join(directory, "closing.json"));
  if (!isDeepStrictEqual(researchJson(closing), { schemaVersion: 1, specSha256: slot.specSha256 })) researchInvalid();
  return () => {
    assertResearchInitialRoot(true); assertRegistered();
    assertQualifiedResearchRuntimeArtifact(current.spec.runtimeDirectory, current.spec.artifactSha256);
    assertQualifiedResearchRuntimeArtifact(r.producerRuntimeDirectory as string, r.producerArtifactSha256 as string);
    if (!isDeepStrictEqual(assertUnsubmittedResearchStart(current), r.unmountedPins)) researchInvalid();
    if (optionalResearchBytes(join(authority, "active.json")) || !researchRead(join(authority, "last-terminal.json")).equals(terminal) ||
        !researchRead(join(directory, "spec.json")).equals(bytes) || !researchRead(join(directory, "unsubmitted-abort.json")).equals(abort) ||
        !researchRead(join(directory, "closing.json")).equals(closing) || !researchRead(join(authority, "grant.json")).equals(grant) ||
        !researchRead(join(authority, "project-worker-request.json")).equals(request)) researchInvalid();
  };
}

/** Outside initial-root owner only. The original normalized status is retained;
 * stopping a failed Worker never turns its result into successful work. */
export async function finalizeOwnedMimoWorker(jobId: string, startId: string, specSha256: string): Promise<{ jobId: string; startId: string; status: RuntimeResultEnvelope["status"] }> {
  return await withResearchJobMutationAsync(jobId, () => finalizeOwnedMimoWorkerUnlocked(jobId, startId, specSha256));
}
type PreservationOriginAuthority = Readonly<{
  assertCurrent(): Promise<() => void>;
  withPublication<T>(effect: () => Promise<T>): Promise<T>;
}>;
/** Explicit initial-root recovery by this qualified producer. Original launch,
 * registered authority and pins remain immutable; no request flag mints release. */
export async function recoverOwnedMimoWorkerPreservation(expected: RegisteredResearchStartIdentity) {
  assertResearchInitialRoot(true);
  researchRecord(expected, "jobId,startId,specSha256,requestSha256");
  return await withResearchJobMutationAsync(expected.jobId, async () => {
    const current = researchCurrentStart(expected.jobId), { spec } = current;
    if (!spec.registeredHandoff || spec.startId !== expected.startId || researchHash(current.bytes) !== expected.specSha256 ||
        spec.requestSha256 !== expected.requestSha256 || spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) researchInvalid();
    const producer = installedResearchRuntimeDirectory(), producerSha = researchArtifactDigest(producer);
    assertQualifiedResearchRuntimeArtifact(producer, producerSha);
    const original = await originalAbortAuthority(current); // Qualifies original bytes before its imports.
    const binding = spec.registeredHandoff;
    const assertCurrent = async (): Promise<() => void> => {
      assertQualifiedResearchRuntimeArtifact(producer, producerSha);
      assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256);
      const assertOriginal = await original.assertRegisteredResearchHandoffCurrent(binding, spec.request);
      return () => { assertQualifiedResearchRuntimeArtifact(producer, producerSha);
        assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256); assertOriginal(); };
    };
    return await finalizeOwnedMimoWorkerUnlocked(expected.jobId, expected.startId, expected.specSha256, {
      assertCurrent, withPublication: async effect => await original.withRegisteredResearchHandoffPublication(binding, spec.request, effect),
    });
  });
}
/** Explicit terminal-only settlement. Authenticated old scope bytes never become
 * a launch permit; current permissions and locks authorize the preservation. */
export async function repairOwnedMimoWorkerTerminalHandoff(expected: RegisteredResearchStartIdentity, historicalScope: unknown) {
  assertResearchInitialRoot(true);
  researchRecord(expected, "jobId,startId,specSha256,requestSha256");
  return await withResearchJobMutationAsync(expected.jobId, async () => {
    let current: ReturnType<typeof researchCurrentStart>;
    try { current = researchCurrentStart(expected.jobId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; current = terminalResearchStart(expected.jobId); }
    if (current.spec.startId !== expected.startId || researchHash(current.bytes) !== expected.specSha256 ||
        current.spec.requestSha256 !== expected.requestSha256) researchInvalid();
    const repair = await prepareResearchTerminalHandoffRepair(current, historicalScope);
    return await finalizeOwnedMimoWorkerUnlocked(expected.jobId, expected.startId, expected.specSha256, undefined, repair);
  });
}
/** Reservation release only for an authenticated historical native stop before
 * its first provider reservation. This does not create a Worker result. */
export async function releaseStoppedOwnedMimoWorkerBeforeProvider(expected: RegisteredResearchStartIdentity, historicalScope: unknown) {
  assertResearchInitialRoot(true); researchRecord(expected, "jobId,startId,specSha256,requestSha256");
  return await withResearchJobMutationAsync(expected.jobId, async () => {
    if (optionalResearchBytes(join(researchJobAuthority(expected.jobId), "active.json"))) researchInvalid();
    const current = terminalResearchStart(expected.jobId);
    if (current.spec.startId !== expected.startId || researchHash(current.bytes) !== expected.specSha256 ||
        current.spec.requestSha256 !== expected.requestSha256) researchInvalid();
    return await releaseResearchStoppedBeforeProvider(current, historicalScope);
  });
}
/** The scan failing says nothing about launch admission; name it, with its closed warning, instead of the generic denial. */
function assertWorkspaceChangesAvailable(warning: WorkspaceChangedFilesWarning | undefined): void {
  if (warning !== undefined) throw new Error(`hosted_mimo_worker_changed_files_unavailable:${warning}`);
}
async function finalizeOwnedMimoWorkerUnlocked(jobId: string, startId: string, specSha256: string,
  originAuthority?: PreservationOriginAuthority, terminalRepair?: Awaited<ReturnType<typeof prepareResearchTerminalHandoffRepair>>
): Promise<{ jobId: string; startId: string; status: RuntimeResultEnvelope["status"] }> {
  assertResearchInitialRoot(true);
  let current: ReturnType<typeof researchCurrentStart>, released = false;
  try { current = researchCurrentStart(jobId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    current = terminalResearchStart(jobId); released = true;
  }
  if (current.spec.startId !== startId || researchHash(current.bytes) !== specSha256 ||
      current.spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) researchInvalid();
  let assertOriginal = await originAuthority?.assertCurrent();
  const registered = current.spec.registeredHandoff;
  let assertRegisteredBytes: (() => void) | undefined;
  if (registered) {
    if (terminalRepair) assertRegisteredBytes = terminalRepair.assertCurrent;
    else {
      if (!released) await prepareResearchRegisteredHandoffAuthority(jobId, startId, assertResearchInitialRoot, true);
      assertRegisteredBytes = await assertRegisteredResearchHandoffCurrent(registered, current.spec.request);
    }
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
    assertRegisteredBytes?.(); assertOriginal?.();
  };
  if (!released && !terminalRepair) {
    if (registered) await withCodexGoalRegistryMutation({ registryRootDir: registered.registryRootDir,
      requireExistingRegistryRoot: true, effect: async () => {
        await assertRegisteredResearchHandoffCurrent(registered, current.spec.request);
        stopResearchStartForCancellation(jobId, current);
      } });
    else stopResearchStartForCancellation(jobId, current);
  }
  assertTerminal();
  const guard = async (): Promise<void> => {
    if (originAuthority) assertOriginal = await originAuthority.assertCurrent();
    if (registered && !terminalRepair) assertRegisteredBytes = await assertRegisteredResearchHandoffCurrent(registered, current.spec.request);
    assertTerminal();
  };
  const publicationLease = terminalRepair?.withPublication ?? (registered && !released ? (originAuthority
    ? originAuthority.withPublication : researchHandoffPublicationLease(jobId, startId)) : undefined);
  const publishTerminal = async (): Promise<{ jobId: string; startId: string; status: RuntimeResultEnvelope["status"] }> => {
  if (!existsSync(publicationPath)) {
    if (released) researchInvalid();
    const workspace = await changedFilesFromWorkspace(current.spec.request.workspacePath, true);
    assertWorkspaceChangesAvailable(workspace.warning);
    let outcome: { readonly reconciled: Awaited<ReturnType<typeof materializeReconciledTerminalCodexGoalHandoff>> }
      | { readonly refused: Readonly<{ reason: HandoffPreservationRefusalReason; receiptSha256: string }> };
    try {
      outcome = { reconciled: await materializeReconciledTerminalCodexGoalHandoff({ config: current.spec.request, changedFiles: workspace.changedFiles,
        publicationAuthority: { assertPublicationAuthorized: guard, captureMode: TerminalHandoffCaptureMode.PreserveWorkspace } }) };
    } catch (error) {
      const reason = handoffPreservationRefusalReason(error);
      if (reason === undefined) throw error;
      await guard(); // Authenticated cold owner/candidate/registered witnesses, not the thrown message alone.
      const producer = installedResearchRuntimeDirectory(), producerSha = researchArtifactDigest(producer);
      assertQualifiedResearchRuntimeArtifact(producer, producerSha);
      const refusal = { schemaVersion: 1, jobId, startId, specSha256, requestSha256: current.spec.requestSha256,
        candidateSha256: researchHash(candidateBytes), bindingSha256: researchHash(researchRead(join(current.directory, "binding.json"))),
        originalRuntimeDirectory: current.spec.runtimeDirectory, originalArtifactSha256: current.spec.artifactSha256,
        producerRuntimeDirectory: producer, producerArtifactSha256: producerSha, reason, budget: handoffPreservationBudget,
        processTerminal: true, preservationComplete: false, writerReleased: false };
      const path = join(current.directory, "preservation-refusal." + producerSha + ".json"), previous = optionalResearchBytes(path);
      if (previous && !isDeepStrictEqual(researchJson(previous), refusal)) researchInvalid();
      assertQualifiedResearchRuntimeArtifact(current.spec.runtimeDirectory, current.spec.artifactSha256);
      await guard(); assertQualifiedResearchRuntimeArtifact(producer, producerSha);
      if (!previous) researchPublish(path, refusal, true);
      // Terminal refusal: the receipt is the output proof and the workspace stays the copy of record,
      // so a result publishes without a packet and the reservation still releases below, last.
      outcome = { refused: { reason, receiptSha256: researchHash(researchRead(path)) } };
    }
    await guard();
    // The candidate's own count and marker describe its list; the publication states its own.
    const { changedFilesCount: _candidateCount, ...candidateDetails } = candidate.details ?? {};
    let result: RuntimeResultEnvelope;
    if ("reconciled" in outcome) {
      // The publication is read back through the same 1 MiB limit as the candidate: it keeps a bounded sample.
      const reported = boundedChangedFiles(outcome.reconciled.changedPaths), notes = boundedChangedFilesNotes(reported);
      result = buildRuntimeResultEnvelope({ ...candidate, changedFiles: reported.changedFiles,
        artifacts: outcome.reconciled.artifacts, evidence: [...candidate.evidence.filter(value => value !== "patch_preserve_unavailable" && value !== changedFilesTruncatedEvidence), ...notes.evidence],
        details: { ...candidateDetails, ...terminalCodexGoalHandoffResultDetails(outcome.reconciled.handoff), ...notes.details }, updatedAt: new Date(candidate.updatedAt!) });
    } else {
      // Changed paths are never exported on refusal: only their count, which is not the refused metadata.
      result = buildRuntimeResultEnvelope({ ...candidate, changedFiles: [], artifacts: [],
        evidence: [...candidate.evidence.filter(value => value !== "patch_preserve_unavailable" && value !== changedFilesTruncatedEvidence),
          `handoff_preservation_refused:${outcome.refused.reason}`],
        details: { ...candidateDetails, changedFilesCount: String(workspace.changedFiles.length),
          preservationRefusalReason: outcome.refused.reason, preservationRefusalReceiptSha256: outcome.refused.receiptSha256,
          preservationRefusalWorkspaceRetained: "true" }, updatedAt: new Date(candidate.updatedAt!) });
    }
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
      assertTerminal();
      // An accepted response alone is not quota recovery. Only this existing cold
      // native/provider boundary can publish the exact-current-key exemption.
      try { if (!terminalRepair) await settleResearchMimoCapacityRecovery(current, { assertTerminal, withPublication: async effect => await effect() }); }
      catch { /* Changed limits/uncertain custody retain the consumed claim, not availability. */ }
      assertTerminal(); terminalRepair?.assertPublished();
      releaseTerminalResearchStart(jobId, current, assertRegisteredBytes); // Reservation release is always last.
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
/** Read-only and filesystem-only: the current start of a job whose MiMo candidate has no publication yet. It is the
 * cheap first stage of the pending-finalization rule, so callers can drop finished jobs before asking systemd. */
export function observeMimoCandidateAwaitingPublication(jobId: string): { readonly directory: string; readonly spec: ReturnType<typeof researchCurrentStart>["spec"]; readonly bytes: Buffer } | undefined {
  let current: ReturnType<typeof researchCurrentStart>;
  try { current = researchCurrentStart(jobId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!existsSync(join(current.directory, "mimo-candidate.json")) || existsSync(join(current.directory, "mimo-publication.json"))) return undefined;
  return current;
}
/** Read-only: a job whose finished MiMo candidate waits for finalization. The candidate exists, nothing is published,
 * and the runtime and every provider unit are inactive, so a Status can finalize it now. Nothing is written, locked or
 * reconciled. The single owner of this selection rule; `runtimeDirectory` is the release the job was started on and
 * therefore the release its finalization runs on. */
export function observePendingMimoFinalization(jobId: string): { readonly startId: string; readonly candidateSha256: string; readonly runtimeDirectory: string } | undefined {
  const current = observeMimoCandidateAwaitingPublication(jobId);
  if (!current) return undefined;
  if (!inactiveResearchUnit(current.spec.unit, researchDescription(jobId, researchHash(current.bytes)))) return undefined;
  let providers: string[] = [];
  try { providers = researchProviderUnits(current.directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const unit of providers) if (researchProviderLifecycle(current.directory, unit)) return undefined;
  return { startId: current.spec.startId, candidateSha256: researchHash(researchRead(join(current.directory, "mimo-candidate.json"))), runtimeDirectory: current.spec.runtimeDirectory };
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
  const abort = optionalResearchBytes(join(directory, "unsubmitted-abort.json"));
  if (abort) {
    const r = researchRecord(researchJson(abort), "schemaVersion,kind,jobId,startId,specSha256,requestSha256,grantSha256,submitterOwnerSha256,submitterAuditSha256,producerRuntimeDirectory,producerArtifactSha256,unmountedPins");
    if (r.schemaVersion !== 1 || r.kind !== ResearchEarlyAbortKind.Unsubmitted || r.jobId !== jobId || r.startId !== spec.startId ||
        r.specSha256 !== researchHash(bytes) || r.requestSha256 !== spec.requestSha256 || r.grantSha256 !== spec.grantSha256 ||
        ![r.submitterOwnerSha256, r.submitterAuditSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
        typeof r.producerRuntimeDirectory !== "string" || typeof r.producerArtifactSha256 !== "string") researchInvalid();
    assertQualifiedResearchRuntimeArtifact(r.producerRuntimeDirectory, r.producerArtifactSha256);
    assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256);
    if (researchHash(researchRead(join(researchJobAuthority(jobId), "grant.json"))) !== spec.grantSha256 ||
        researchHash(researchRead(join(researchJobAuthority(jobId), "project-worker-request.json"))) !== spec.requestSha256 ||
        !isDeepStrictEqual(researchJson(researchRead(join(directory, "closing.json"))), { schemaVersion: 1, specSha256: researchHash(bytes) }) ||
        !isDeepStrictEqual(assertUnsubmittedResearchStart({ directory, bytes, spec }), r.unmountedPins)) researchInvalid();
  } else assertRegisteredResearchHandoffPin(spec, directory);
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
  assertWorkspaceChangesAvailable(workspace.warning);
  const preserved = await materializeReconciledTerminalCodexGoalHandoff({
    config: current.spec.request, changedFiles: workspace.changedFiles,
    publicationAuthority: { assertPublicationAuthorized: guard, captureMode: TerminalHandoffCaptureMode.PreserveWorkspace,
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
