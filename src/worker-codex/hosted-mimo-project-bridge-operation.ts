import { trustedMimoProjectOperationLaunch } from "./trusted-custody-systemd-launch";
import { existsSync, mkdirSync, writeFileSync, renameSync, realpathSync, lstatSync, openSync, closeSync,
  fsyncSync, fstatSync, linkSync, unlinkSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { researchCustody, researchHash, researchRecord, researchPublish, isResearchDenialObservation, type ResearchDenialObservation } from "./research-launch-files";
import { WorkspaceChangedFilesWarning } from "./codex-goal-changed-files-report";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { handleHostedMimoProjectBridge, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding, assertHostedMimoAdmissionRepairStartRearm } from "./hosted-mimo-project-bridge";
import { withHostedMimoWorkstreamActivity } from "./hosted-mimo-project-workstream-fence";
import { retiredWorkstreamBridgeAnswer } from "./job-retirement/job-retirement-records";
import { beginMimoProjectStartControlTiming, createMimoProjectStartControlTiming, mimoProjectStartControlReceipt,
  MimoProjectStartControlTimingScope, type MimoProjectStartControlTimingObserver } from "./research-launch-admission-diagnostics";
import { readdirSync } from "node:fs";
import { InterruptedProjectCreateErrorCode, InterruptedProjectCreateDisposition, InterruptedProjectCreateTermination,
  type InterruptedProjectCreateOutcome } from "@vioxen/subscription-runtime/worker-core";
import { z } from "zod";
import { capturePublicationBusyStartRearm, assertPublicationBusyStartRearmCurrent, publicationBusyRearmPath,
  isPrelaunchStartFailureResult, type PublicationBusyStartRearmProof } from "./hosted-mimo-publication-busy-rearm";

// Canonical settlement representation belongs to the native operation store.
const settlementSha = z.string().regex(/^[a-f0-9]{64}$/), settlementId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), settlementHexId = z.string().regex(/^[a-f0-9]{32}$/);
export const mimoInterruptedOutcome: InterruptedProjectCreateOutcome = Object.freeze({ termination: InterruptedProjectCreateTermination.RuntimeTimeout,
  disposition: InterruptedProjectCreateDisposition.RetainedUnregisteredFailure, registrationPublished: false, payloadStarted: false, partialsPreserved: true });
export const mimoInterruptedFailureBytes = JSON.stringify({ ok: false, error: InterruptedProjectCreateErrorCode.RuntimeTimeout }) + "\n";
export const mimoInterruptedIntentSchema = z.object({ schemaVersion: z.literal(1), planSha256: settlementSha, machineId: settlementHexId, projectId: settlementId, workstreamId: settlementId, jobId: settlementId,
  ownerSha256: settlementSha, requestSha256: settlementSha, bindingSha256: settlementSha, resultSha256: settlementSha,
  witness: z.object({ unit: z.string().regex(/^subscription-runtime-mimo-project-[a-f0-9]{64}\.service$/), bootId: settlementHexId, invocationId: settlementHexId,
    startedMonotonicUs: z.string().regex(/^[1-9][0-9]{0,19}$/), failedMonotonicUs: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict(),
  partials: z.object({ attemptSha256: settlementSha, promptSha256: settlementSha, contractSha256: settlementSha, stateSha256: settlementSha, receiptSha256: settlementSha }).strict(),
  outcome: z.object({ termination: z.literal(InterruptedProjectCreateTermination.RuntimeTimeout), disposition: z.literal(InterruptedProjectCreateDisposition.RetainedUnregisteredFailure),
    registrationPublished: z.literal(false), payloadStarted: z.literal(false), partialsPreserved: z.literal(true) }).strict(), cpuCause: z.literal("unproven") }).strict();
export const mimoInterruptedReceiptSchema = z.object({ schemaVersion: z.literal(1), complete: z.boolean(), intentSha256: settlementSha, resultSha256: settlementSha }).strict();
export function readPrivateHostedMimoOperationBytes(path: string, maximum: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1 || (before.mode & 0o777) !== 0o600)
    throw new Error("mimo_project_bridge_operation_invalid");
  const bytes = hostedMimoBridgeMetadataBytes(path, maximum), after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode)
    throw new Error("mimo_project_bridge_operation_invalid");
  return bytes;
}
const ownedUnitFenceWaitMs = 120_000;
const fixedEntry = "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js";
const approvedErrorCodes = new Set([
  "safe_execution_workspace_locked",
  "protected_job_birth_publication_busy",
  "protected_job_birth_authority_invalid",
  "evidence_custody_bootstrap_evidence_basename_invalid",
  "evidence_custody_bootstrap_root_unsafe",
  "evidence_custody_bootstrap_anchor_unsafe",
  "hosted_ordinary_writer_extent_invalid",
  "controller_maintenance_fence_active",
  "controller_maintenance_activity_active",
]);
export function operationErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "mimo_project_bridge_operation_failed";
  // Errors can originate in another immutable release, with a different class identity.
  const typedCode: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
  if (typeof typedCode === "string" && approvedErrorCodes.has(typedCode)) return typedCode;
  const code = error.message.split(/[:;]/, 1)[0]!;
  if (approvedErrorCodes.has(code) || /^(?:mimo_project_bridge_|project_control_|hosted_research_|codex_goal_|owned_mimo_|mimo_admission_repair_|project_mimo_worker_|hosted_mimo_|codex_project_|hosted_stored_project_|job_retirement_)[a-z0-9_]{1,100}$/.test(code)) return code;
  switch (typedCode) {
    case "ENOENT": return "mimo_project_bridge_fs_not_found";
    case "EACCES": return "mimo_project_bridge_fs_access_denied";
    case "EPERM": return "mimo_project_bridge_fs_permission_denied";
    case "EEXIST": return "mimo_project_bridge_fs_already_exists";
  }
  if (error instanceof TypeError) return "mimo_project_bridge_type_error";
  if (error instanceof SyntaxError) return "mimo_project_bridge_parse_error";
  return "mimo_project_bridge_operation_failed";
}
/** Closed vocabulary of a Status or Stop failure cause; each member comes from its single owner. */
export type HostedMimoOperationCause = ResearchDenialObservation | WorkspaceChangedFilesWarning | `handoff_${string}` | "unknown";
export type HostedMimoOperationFailure = Readonly<{ ok: false; error: string; cause?: HostedMimoOperationCause }>;
// Exact messages only. The suffixes are closed vocabularies produced by the
// terminal handoff normalizer and the workspace change reader, never free text.
const handoffCauseSource = "handoff_[a-z0-9_]{1,80}|unknown";
const handoffUnavailable = new RegExp(`^dirty_terminal_handoff_unavailable:(${handoffCauseSource})$`);
const changedFilesWarnings = Object.values(WorkspaceChangedFilesWarning);
/** The closed cause vocabulary as a guard, for readers that must not copy anything else. */
export function isHostedMimoOperationCause(value: unknown): value is HostedMimoOperationCause {
  return typeof value === "string" && (new RegExp(`^(?:${handoffCauseSource})$`).test(value) || changedFilesWarnings.some(warning => warning === value) || isResearchDenialObservation(value));
}
const changedFilesUnavailable = new RegExp(`^hosted_mimo_worker_changed_files_unavailable:(${changedFilesWarnings.join("|")})$`);
/** The failure envelope of an operation. Only Status and Stop, which finalize a worker, add a closed `cause`;
 * the other operations keep the exact `{ ok, error }` shape that rearm and retirement compare. */
export function operationFailure(error: unknown, operation?: MimoProjectBridgeOperation): HostedMimoOperationFailure {
  const code = operationErrorCode(error);
  if (operation !== MimoProjectBridgeOperation.Status && operation !== MimoProjectBridgeOperation.Stop || !(error instanceof Error)) return { ok: false, error: code };
  const handoff = handoffUnavailable.exec(error.message);
  if (handoff) return { ok: false, error: "mimo_project_bridge_handoff_unavailable", cause: handoff[1] as `handoff_${string}` | "unknown" };
  const changed = changedFilesWarnings.find(warning => changedFilesUnavailable.exec(error.message)?.[1] === warning);
  if (changed) return { ok: false, error: code, cause: changed };
  // The originating release may carry another Error class; only the exact code and a closed observation count.
  if (error.message === "hosted_research_launch_denied" && isResearchDenialObservation(error.cause)) return { ok: false, error: code, cause: error.cause };
  return { ok: false, error: code };
}
function canonical(request: MimoProjectBridgeRequest): string {
  return JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))));
}
function operationFiles(request: MimoProjectBridgeRequest) {
  const root = `/srv/worker-state/mimo-projects/${request.projectId}/${request.workstreamId}/mimo-bridge-operations`;
  const name = `${request.jobId}.${request.operation}`;
  return { root, requestPath: join(root, name + ".request.json"), resultPath: join(root, name + ".result.json"), ownerPath: join(root, name + ".owner.json") };
}
function entry() {
  const path = realpathSync(fixedEntry);
  researchCustody(dirname(path));
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0) throw new Error("mimo_project_bridge_runtime_invalid");
  return path;
}
function owner(request: MimoProjectBridgeRequest) {
  const files = operationFiles(request), ownerBytes = hostedMimoBridgeMetadataBytes(files.ownerPath);
  const raw: unknown = JSON.parse(ownerBytes.toString());
  const hasRearm = !!raw && typeof raw === "object" && Object.hasOwn(raw, "rearmProof");
  const value = researchRecord(raw, "schemaVersion,requestSha256,generation,unit,description,entry,node" + (hasRearm ? ",rearmProof" : ""));
  const bytes = hostedMimoBridgeMetadataBytes(files.requestPath), retained = parseMimoProjectBridgeRequest(JSON.parse(bytes.toString()));
  const digest = researchHash(canonical(retained));
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
      (![MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop, MimoProjectBridgeOperation.Start].includes(retained.operation) && value.generation !== 0)) throw new Error("mimo_project_bridge_operation_invalid");
  const unitDigest = researchHash(digest + ":" + value.generation), unit = `subscription-runtime-mimo-project-${unitDigest}.service`;
  if (value.schemaVersion !== 1 || value.requestSha256 !== digest || value.unit !== unit || value.description !== `subscription-runtime MiMo project ${unitDigest}` ||
      retained.machineId !== request.machineId || retained.projectId !== request.projectId || retained.workstreamId !== request.workstreamId ||
      retained.jobId !== request.jobId || retained.operation !== request.operation) throw new Error("mimo_project_bridge_operation_invalid");
  if (retained.operation === MimoProjectBridgeOperation.Start && (value.generation as number) > 0) {
    const proof = researchRecord(value.rearmProof, "ownerSha256,requestSha256,resultSha256,receiptSha256");
    for (const hash of Object.values(proof)) if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("mimo_project_bridge_operation_invalid");
    const previousGeneration = (value.generation as number) - 1;
    for (const [path, expected] of [[files.ownerPath, proof.ownerSha256], [files.requestPath, proof.requestSha256], [files.resultPath, proof.resultSha256]])
      if (researchHash(hostedMimoBridgeMetadataBytes(path + ".generation-" + previousGeneration)) !== expected)
        throw new Error("mimo_project_bridge_operation_invalid");
    const oldOwner = JSON.parse(hostedMimoBridgeMetadataBytes(files.ownerPath + ".generation-" + previousGeneration).toString()) as { generation?: unknown; requestSha256?: unknown; unit?: unknown };
    const oldRequest = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(files.requestPath + ".generation-" + previousGeneration).toString()));
    if (oldOwner.generation !== previousGeneration || oldOwner.requestSha256 !== digest || canonical(oldRequest) !== canonical(retained) ||
        oldOwner.unit !== `subscription-runtime-mimo-project-${researchHash(digest + ":" + previousGeneration)}.service` ||
        !(admissionDenied(JSON.parse(hostedMimoBridgeMetadataBytes(files.resultPath + ".generation-" + previousGeneration).toString()))
          ? researchHash(hostedMimoBridgeMetadataBytes(join(dirname(files.root), "admission-repair-archives", request.jobId + ".finalization.json"))) === proof.receiptSha256
          : isPrelaunchStartFailureResult(JSON.parse(hostedMimoBridgeMetadataBytes(files.resultPath + ".generation-" + previousGeneration).toString())) &&
            researchHash(readPrivateHostedMimoOperationBytes(publicationBusyRearmPath(dirname(files.root), request.jobId, previousGeneration), 65536)) === proof.receiptSha256))
      throw new Error("mimo_project_bridge_operation_invalid");
  } else if (hasRearm) throw new Error("mimo_project_bridge_operation_invalid");
  return { ...files, value, retained, ownerBytes, requestBytes: bytes };
}
/** The same original store validates the owner for execution and reconciliation. */
export const readHostedMimoProjectOperationOwner = owner;
export type HostedMimoProjectOperationOwner = ReturnType<typeof owner>;

/** Exclusive, synced publication; a competing/partial result is never replaced. */
export function publishHostedMimoProjectOperationResult(current: HostedMimoProjectOperationOwner,
  serialized: string, assertCurrent: () => void): void {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const original = owner(current.retained);
  for (const key of ["root", "ownerPath", "requestPath", "resultPath"] as const)
    if (current[key] !== original[key]) throw new Error("mimo_project_bridge_operation_invalid");
  const directoryIdentity = lstatSync(current.root);
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() || directoryIdentity.uid !== 0 || directoryIdentity.gid !== 0)
    throw new Error("mimo_project_bridge_operation_invalid");
  const sameOwner = () => {
    assertCurrent();
    const directory = lstatSync(current.root);
    if (directory.dev !== directoryIdentity.dev || directory.ino !== directoryIdentity.ino)
      throw new Error("mimo_project_bridge_operation_invalid");
    if (!hostedMimoBridgeMetadataBytes(current.ownerPath).equals(current.ownerBytes) ||
        !hostedMimoBridgeMetadataBytes(current.requestPath).equals(current.requestBytes))
      throw new Error("mimo_project_bridge_operation_invalid");
  };
  sameOwner(); researchCustody(current.root, true);
  if (Buffer.byteLength(serialized) > 1048576 || existsSync(current.resultPath) || existsSync(current.resultPath + ".tmp"))
    throw new Error("mimo_project_bridge_operation_invalid");
  const temp = current.resultPath + ".tmp", fd = openSync(temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
      throw new Error("mimo_project_bridge_operation_invalid");
    writeFileSync(fd, serialized); fsyncSync(fd);
    const written = fstatSync(fd);
    sameOwner();
    const named = lstatSync(temp), after = fstatSync(fd);
    if (named.isSymbolicLink() || named.dev !== written.dev || named.ino !== written.ino || named.ctimeMs !== written.ctimeMs ||
        after.ctimeMs !== written.ctimeMs || after.size !== Buffer.byteLength(serialized))
      throw new Error("mimo_project_bridge_operation_invalid");
    // link publishes without replacement; retain the .tmp if publication is uncertain.
    linkSync(temp, current.resultPath); unlinkSync(temp);
    const directory = openSync(current.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { closeSync(fd); }
}
/** Incomplete settlement remains uncertain even when a failure result exists. */
export function hostedMimoInterruptedCreateComplete(current: HostedMimoProjectOperationOwner): boolean {
  try {
    if (current.retained.operation !== MimoProjectBridgeOperation.Create || current.value.generation !== 0) return false;
    const stem = join(dirname(current.root), "interrupted-create-settlements", current.retained.jobId);
    const intentBytes = readPrivateHostedMimoOperationBytes(stem + ".intent.json", 16384);
    const intent = mimoInterruptedIntentSchema.parse(JSON.parse(intentBytes.toString()));
    const receipt = mimoInterruptedReceiptSchema.parse(JSON.parse(readPrivateHostedMimoOperationBytes(stem + ".receipt.json", 4096).toString()));
    return receipt.complete && receipt.intentSha256 === researchHash(intentBytes) && receipt.resultSha256 === researchHash(mimoInterruptedFailureBytes) &&
      intent.resultSha256 === receipt.resultSha256 && intent.machineId === current.retained.machineId && intent.projectId === current.retained.projectId &&
      intent.workstreamId === current.retained.workstreamId && intent.jobId === current.retained.jobId && intent.witness.unit === current.value.unit &&
      intent.ownerSha256 === researchHash(current.ownerBytes) && intent.requestSha256 === researchHash(current.requestBytes) &&
      readPrivateHostedMimoOperationBytes(current.resultPath, 1048576).equals(Buffer.from(mimoInterruptedFailureBytes));
  } catch { return false; }
}
function admissionDenied(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === "error,ok" &&
    (value as { ok?: unknown }).ok === false && (value as { error?: unknown }).error === "project_control_admission_denied";
}
function observation(request: MimoProjectBridgeRequest): Record<string, unknown> {
  const files = operationFiles(request);
  if (!existsSync(files.ownerPath)) return { state: "absent" };
  const current = owner(request);
  const output = researchCommand("/usr/bin/systemctl", ["show", current.value.unit as string, "--property=Id,Description,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus,ControlGroup"]);
  const state = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (state.LoadState !== "not-found" && (state.Id !== current.value.unit || state.Description !== current.value.description))
    throw new Error("mimo_project_bridge_operation_invalid");
  const running = ["active", "activating", "deactivating", "reloading"].includes(state.ActiveState ?? "");
  if (running) return { state: "running", unit: current.value.unit };
  if (!existsSync(current.resultPath)) return { state: "unresolved", unit: current.value.unit };
  const result = JSON.parse(hostedMimoBridgeMetadataBytes(current.resultPath, 1048576).toString()) as { ok?: unknown; result?: unknown; error?: unknown };
  if (typeof result.ok !== "boolean") throw new Error("mimo_project_bridge_operation_invalid");
  if (result.error === InterruptedProjectCreateErrorCode.RuntimeTimeout && !hostedMimoInterruptedCreateComplete(current))
    return { state: "unresolved", unit: current.value.unit };
  return { state: "settled", unit: current.value.unit, result, terminalVerified: state.LoadState === "loaded" &&
    ["inactive", "failed"].includes(state.ActiveState ?? "") && state.MainPID === "0" };
}
/** Read-only operation state for maintenance that must not race bridge operations. */
export const observeHostedMimoProjectOperation = observation;
/** Read-only: the exact retained owner's unit is cold (zero PID, empty control
 * group, no queued job), the same proof controller recovery requires. */
export const hostedMimoProjectOperationCold = (request: MimoProjectBridgeRequest): boolean => recoverableStatus(request, "controller-recovery");
/** Status may reconcile an existing publication, but never submits a provider.
 * Recover only after the exact prior observer cannot execute any further work. */
function recoverableStatus(request: MimoProjectBridgeRequest, mode?: "controller-recovery"): boolean {
  const current = owner(request);
  return coldOperationUnit(current.value.unit as string, current.value.description as string, mode);
}
function coldOperationUnit(unit: string, description: string, mode?: "controller-recovery"): boolean {
  const output = researchCommand("/usr/bin/systemctl", ["show", unit, "--property=Id,Description,LoadState,ActiveState,MainPID,ControlGroup"]);
  const fields = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.Id !== unit || (fields.LoadState !== "not-found" && fields.Description !== description))
    throw new Error("mimo_project_bridge_operation_invalid");
  if (mode === "controller-recovery" && (fields.MainPID !== "0" || fields.ControlGroup !== "")) return false;
  if (!(fields.LoadState === "not-found" || fields.LoadState === "loaded" &&
      ["inactive", "failed"].includes(fields.ActiveState ?? "") && fields.MainPID === "0")) return false;
  const jobs = researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]);
  return !jobs.trim().split("\n").some(line => line.trim().split(/\s+/)[1] === unit);
}
export async function submitHostedMimoProjectBridge(value: unknown): Promise<unknown> {
  const request = parseMimoProjectBridgeRequest(value);
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== request.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  researchCustody(binding.stateRoot, true);
  // A retired workstream answers from its tombstones, without a lease, an owned
  // unit or a routed runtime, and therefore without opening any workspace.
  const retired = retiredWorkstreamBridgeAnswer(binding.stateRoot, request.jobId, isStatusOrStop(request));
  if (retired) return retired;
  return withHostedMimoWorkstreamActivity(binding.stateRoot, () => submitHostedMimoProjectBridgeUnfenced(value));
}
const isStatusOrStop = (request: MimoProjectBridgeRequest): boolean =>
  request.operation === MimoProjectBridgeOperation.Status || request.operation === MimoProjectBridgeOperation.Stop;
async function submitHostedMimoProjectBridgeUnfenced(value: unknown): Promise<unknown> {
  const request = parseMimoProjectBridgeRequest(value);
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== request.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  let previousStatus: unknown;
  let generation = 0;
  let rearmProof: Readonly<{ ownerSha256: string; requestSha256: string; resultSha256: string; receiptSha256: string }> | undefined;
  const retainedFiles = operationFiles(request);
  // A racing agent gets a retryable refusal before its job ID is consumed.
  if (request.operation === MimoProjectBridgeOperation.Create && !existsSync(retainedFiles.ownerPath) && request.sourceCommit !== binding.sourceCommit)
    throw new Error("mimo_project_bridge_source_mismatch");
  // A crash after archival must not resurrect generation zero as a fresh Start.
  if (request.operation === MimoProjectBridgeOperation.Start && !existsSync(retainedFiles.ownerPath) && existsSync(retainedFiles.root) &&
      readdirSync(retainedFiles.root).some(name => name.startsWith(`${request.jobId}.start.`)))
    throw new Error("mimo_project_bridge_operation_invalid");
  // Real submissions must retain the exact request. Synthetic observations
  // intentionally lack Create payload fields and only verify job identity.
  if (request.operation !== MimoProjectBridgeOperation.Status && existsSync(retainedFiles.ownerPath) &&
      owner(request).value.requestSha256 !== researchHash(canonical(request)))
    throw new Error("mimo_project_bridge_request_mismatch");
  if (request.operation === MimoProjectBridgeOperation.Stop) {
    for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair]) {
      const observed = observation({ ...request, operation });
      if (observed.state === "running" || [MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair].includes(operation) && observed.state === "unresolved")
        throw new Error("mimo_project_bridge_control_pending");
    }
    const prior = observation(request);
    // Only a verified terminal unit plus a durable settled result permits a
    // fresh explicit stop. An uncertain/collected unit keeps its exact owner.
    if (prior.state === "settled" && prior.terminalVerified === true) {
      const old = owner(request); generation = (old.value.generation as number) + 1;
      for (const path of [old.requestPath, old.resultPath, old.ownerPath]) renameSync(path, path + ".generation-" + old.value.generation);
    }
  }
  if (request.operation === MimoProjectBridgeOperation.Status) {
    const operations: Record<string, unknown> = {};
    for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Stop, MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair])
      operations[operation] = observation({ ...request, operation });
    // Status/finalization is a semantic mutation too; never run it under the
    // ingress timeout. The same owned status service is scheduled below when
    // no provider-control operation is still executing.
    if (Object.values(operations).some(row => (row as { state: string }).state === "running") ||
        [MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair].some(operation =>
          (operations[operation] as { state: string }).state === "unresolved")) return { ok: true, jobId: request.jobId, operations };
    const prior = observation(request);
    if (prior.state === "settled" || prior.state === "unresolved" && recoverableStatus(request)) {
      previousStatus = { operations, worker: prior.state === "settled" ? prior.result : prior };
      const old = owner(request); generation = (old.value.generation as number) + 1;
      const evidence = [old.requestPath, old.resultPath, old.resultPath + ".tmp", old.ownerPath]
        .filter(path => path === old.requestPath || path === old.ownerPath || existsSync(path));
      if (evidence.some(path => existsSync(path + ".generation-" + old.value.generation)))
        throw new Error("mimo_project_bridge_operation_invalid");
      for (const path of evidence) renameSync(path, path + ".generation-" + old.value.generation);
    } else if (prior.state !== "absent") return { ok: true, jobId: request.jobId, operations, worker: prior };
  }
  if (request.operation === MimoProjectBridgeOperation.Start || request.operation === MimoProjectBridgeOperation.RepairAdmission) {
    const created = observation({ ...request, operation: MimoProjectBridgeOperation.Create });
    if (created.state !== "settled" || (created.result as { ok?: boolean; result?: { ok?: boolean } })?.ok !== true ||
        (created.result as { result?: { ok?: boolean } })?.result?.ok !== true)
      throw new Error("mimo_project_bridge_creation_pending");
    if (request.operation === MimoProjectBridgeOperation.RepairAdmission) {
      for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop, MimoProjectBridgeOperation.FinalizeAdmissionRepair])
        if (observation({ ...request, operation }).state === "running") throw new Error("mimo_project_bridge_control_pending");
    } else {
      const repair = observation({ ...request, operation: MimoProjectBridgeOperation.RepairAdmission });
      const result = repair.result as { ok?: boolean; result?: { ok?: boolean } } | undefined;
      if (repair.state !== "absent" && (repair.state !== "settled" || result?.ok !== true || result.result?.ok !== true))
        throw new Error("mimo_project_bridge_control_pending");
      const finalized = observation({ ...request, operation: MimoProjectBridgeOperation.FinalizeAdmissionRepair });
      const finalResult = finalized.result as { ok?: boolean; result?: { ok?: boolean } } | undefined;
      if (finalized.state !== "absent" && (finalized.state !== "settled" || finalResult?.ok !== true || finalResult.result?.ok !== true))
        throw new Error("mimo_project_bridge_control_pending");
      const prior = observation(request);
      if (finalized.state === "settled" && prior.state === "settled" && admissionDenied(prior.result)) {
        // Only this exact failed Start may reconcile a collected unit. The
        // shared observer below requires exact Id, zero PID, empty cgroup and
        // no queued job; Stop's loaded-only replay rule remains unchanged.
        if (!recoverableStatus(request, "controller-recovery")) throw new Error("mimo_project_bridge_control_pending");
        const old = owner(request), previousStart = { ownerSha256: researchHash(hostedMimoBridgeMetadataBytes(old.ownerPath)),
          requestSha256: researchHash(hostedMimoBridgeMetadataBytes(old.requestPath)), resultSha256: researchHash(hostedMimoBridgeMetadataBytes(old.resultPath)) };
        const proof = await assertHostedMimoAdmissionRepairStartRearm(request, previousStart);
        if (!/^[a-f0-9]{64}$/.test(proof.receiptSha256) ||
            researchHash(hostedMimoBridgeMetadataBytes(join(dirname(old.root), "admission-repair-archives", request.jobId + ".finalization.json"))) !== proof.receiptSha256)
          throw new Error("mimo_project_bridge_operation_invalid");
        generation = (old.value.generation as number) + 1;
        const evidence = [old.requestPath, old.resultPath, old.ownerPath];
        if (evidence.some(path => existsSync(path + ".generation-" + old.value.generation))) throw new Error("mimo_project_bridge_operation_invalid");
        // Only this explicit Start archives bookkeeping. Provider authority is
        // still acquired by the unchanged original broker in the owned unit.
        for (const path of evidence) renameSync(path, path + ".generation-" + old.value.generation);
        rearmProof = { ...previousStart, receiptSha256: proof.receiptSha256 };
      } else if (prior.state === "settled" && isPrelaunchStartFailureResult(prior.result)) {
        if (!recoverableStatus(request, "controller-recovery")) throw new Error("mimo_project_bridge_control_pending");
        const old = owner(request), evidence = [old.requestPath, old.resultPath, old.ownerPath];
        if (existsSync(old.resultPath + ".tmp")) throw new Error("mimo_project_bridge_operation_invalid");
        if (evidence.some(path => existsSync(path + ".generation-" + old.value.generation))) throw new Error("mimo_project_bridge_operation_invalid");
        const previousStart = { ownerSha256: researchHash(old.ownerBytes), requestSha256: researchHash(old.requestBytes),
          resultSha256: researchHash(hostedMimoBridgeMetadataBytes(old.resultPath)) };
        const proofPath = publicationBusyRearmPath(binding.stateRoot, request.jobId, old.value.generation as number);
        const proof = await capturePublicationBusyStartRearm(request);
        // Fresh proof grants no launch authority. Retain it before archiving;
        // any partial publication remains uncertain and is never overwritten.
        if (!recoverableStatus(request, "controller-recovery") ||
            !hostedMimoBridgeMetadataBytes(old.ownerPath).equals(old.ownerBytes) ||
            !hostedMimoBridgeMetadataBytes(old.requestPath).equals(old.requestBytes) ||
            researchHash(hostedMimoBridgeMetadataBytes(old.resultPath)) !== previousStart.resultSha256)
          throw new Error("mimo_project_bridge_operation_invalid");
        researchPublish(proofPath, proof, true);
        rearmProof = { ...previousStart, receiptSha256: researchHash(readPrivateHostedMimoOperationBytes(proofPath, 65536)) };
        for (const path of evidence) renameSync(path, path + ".generation-" + old.value.generation);
        generation = (old.value.generation as number) + 1;
      }
    }
  }
  if (request.operation === MimoProjectBridgeOperation.FinalizeAdmissionRepair) {
    const repaired = observation({ ...request, operation: MimoProjectBridgeOperation.RepairAdmission });
    const result = repaired.result as { ok?: boolean; result?: { ok?: boolean } } | undefined;
    if (repaired.state !== "settled" || result?.ok !== true || result.result?.ok !== true)
      throw new Error("mimo_project_bridge_repair_pending");
    for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop])
      if (observation({ ...request, operation }).state === "running") throw new Error("mimo_project_bridge_control_pending");
  }
  const files = operationFiles(request);
  researchCustody(dirname(files.root));
  if (!existsSync(files.root)) mkdirSync(files.root, { mode: 0o700 });
  researchCustody(files.root);
  if (existsSync(files.ownerPath)) return { ok: true, jobId: request.jobId, operation: request.operation, ...observation(request) };
  const bytes = canonical(request), digest = researchHash(bytes), unitDigest = researchHash(digest + ":" + generation), unit = `subscription-runtime-mimo-project-${unitDigest}.service`;
  const description = `subscription-runtime MiMo project ${unitDigest}`, executable = entry(), node = realpathSync(process.execPath);
  researchCustody(dirname(node));
  const launch = trustedMimoProjectOperationLaunch({ request, requestSha256: digest, generation, unit, description,
    requestPath: files.requestPath, entry: executable, node, operationTimeoutMs: binding.operationTimeoutMs });
  writeFileSync(files.requestPath, bytes + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(files.ownerPath, JSON.stringify({ schemaVersion: 1, requestSha256: digest, generation, unit, description, entry: executable, node,
    ...(rearmProof ? { rearmProof } : {}) }) + "\n", { flag: "wx", mode: 0o600 });
  // The persisted exact owner precedes submission. A timeout never replaces it.
  researchCommand(launch.command, launch.args);
  return { ok: true, mode: "mimo_project_bridge_operation_started", operation: request.operation, unit, pending: true, jobId: request.jobId, ...(previousStatus ? previousStatus as object : {}) };
}
/** Only the installed owned service invokes this fixed execution mode. */
export async function executeHostedMimoProjectBridgeOperation(requestPath: string): Promise<boolean> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const request = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(requestPath).toString()));
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  researchCustody(binding.stateRoot, true);
  // The request and owner are already persisted, so a source advance must delay
  // this unit instead of leaving the operation without a published result.
  const fenceWaitMs = Math.min(ownedUnitFenceWaitMs, Math.floor(binding.operationTimeoutMs / 4));
  const timing = request.operation === MimoProjectBridgeOperation.Start ? createMimoProjectStartControlTiming() : undefined;
  const acquired = beginMimoProjectStartControlTiming(MimoProjectStartControlTimingScope.WorkstreamFenceAcquire, timing?.observe);
  return withHostedMimoWorkstreamActivity(binding.stateRoot, () => {
    acquired(); return executeHostedMimoProjectBridgeOperationUnfenced(requestPath, timing);
  }, { fenceWaitMs });
}
async function executeHostedMimoProjectBridgeOperationUnfenced(requestPath: string,
  timing?: Readonly<{ observe: MimoProjectStartControlTimingObserver; snapshot: ReturnType<typeof createMimoProjectStartControlTiming>["snapshot"] }>): Promise<boolean> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const request = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(requestPath).toString())), current = owner(request);
  if (current.requestPath !== requestPath || current.value.entry !== realpathSync(process.argv[1]!) || current.value.node !== realpathSync(process.execPath))
    throw new Error("mimo_project_bridge_operation_invalid");
  const service = researchCommand("/usr/bin/systemctl", ["show", current.value.unit as string, "--property=MainPID,Description"]);
  if (!service.split("\n").includes("MainPID=" + process.pid) || !service.split("\n").includes("Description=" + current.value.description))
    throw new Error("mimo_project_bridge_operation_invalid");
  let result: unknown, serialized: string;
  try {
    if (request.operation === MimoProjectBridgeOperation.Start && (current.value.generation as number) > 0) {
      const previousGeneration = (current.value.generation as number) - 1;
      if (isPrelaunchStartFailureResult(JSON.parse(hostedMimoBridgeMetadataBytes(current.resultPath + ".generation-" + previousGeneration).toString()))) {
        const oldOwner = JSON.parse(hostedMimoBridgeMetadataBytes(current.ownerPath + ".generation-" + previousGeneration).toString()) as { unit: string; description: string };
        if (!coldOperationUnit(oldOwner.unit, oldOwner.description, "controller-recovery")) throw new Error("mimo_project_bridge_control_pending");
        const proof = JSON.parse(readPrivateHostedMimoOperationBytes(publicationBusyRearmPath(dirname(current.root), request.jobId, previousGeneration), 65536).toString()) as PublicationBusyStartRearmProof;
        await assertPublicationBusyStartRearmCurrent(request, proof);
      }
    }
    result = { ok: true, result: await handleHostedMimoProjectBridge(request, timing?.observe) };
    serialized = JSON.stringify(result) + "\n";
    if (Buffer.byteLength(serialized) > 1048576) throw new Error("mimo_project_bridge_response_invalid");
    serialized = mimoProjectStartControlReceipt(serialized, timing);
  }
  catch (error) {
    result = operationFailure(error, request.operation);
    serialized = JSON.stringify(result) + "\n";
  }
  // Publication failures remain uncertain; never replace them with a failure
  // envelope or replay a handler whose effects may already have happened.
  publishHostedMimoProjectOperationResult(current, serialized, () => {});
  // The owned unit's journal carries the closed fields of a failure and no error text. It is
  // written only once the result is durable, and a diagnostic failure cannot replace that result.
  const settled = result as { ok: boolean; error?: string; cause?: string };
  if (!settled.ok) try { process.stdout.write(JSON.stringify({ operation: request.operation, ok: false, error: settled.error,
    ...(settled.cause === undefined ? {} : { cause: settled.cause }) }) + "\n"); } catch { /* Diagnostics never replace the published result. */ }
  const outcome = result as { ok: boolean; result?: { ok?: boolean } };
  return outcome.ok && outcome.result?.ok !== false;
}

/** Recovery consumes the same exact owner/digest observer as normal ingress.
 * Collected units require a durable failure and no queued unit job. */
export async function assertHostedMimoRecoveryOperationsSettled(binding: { stateRoot: string; projectId: string; workstreamId: string; machineId: string }): Promise<void> {
  const root = join(binding.stateRoot, "mimo-bridge-operations");
  if (!existsSync(root)) { researchCustody(binding.stateRoot); return; }
  researchCustody(root, true);
  const names = readdirSync(root);
  for (const name of names) {
    if (/\.generation-\d+$/.test(name)) continue;
    if (name.endsWith(".request.json") || name.endsWith(".result.json")) {
      if (!names.includes(name.replace(/\.(?:request|result)\.json$/, ".owner.json"))) throw new Error("mimo_project_bridge_recovery_denied");
    } else if (!name.endsWith(".owner.json")) throw new Error("mimo_project_bridge_recovery_denied");
  }
  for (const name of readdirSync(root).filter(name => name.endsWith(".owner.json"))) {
    const requestPath = join(root, name.replace(/\.owner\.json$/, ".request.json"));
    const request = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(requestPath).toString()));
    if (request.projectId !== binding.projectId || request.workstreamId !== binding.workstreamId || request.machineId !== binding.machineId)
      throw new Error("mimo_project_bridge_recovery_denied");
    const current = owner(request), observed = observation(request);
    const result = observed.result as { ok?: boolean; result?: { ok?: boolean } } | undefined;
    if (current.ownerPath !== join(root, name) || observed.state !== "settled" || !recoverableStatus(request, "controller-recovery") ||
        (request.operation !== MimoProjectBridgeOperation.Status && result?.ok !== false && result?.result?.ok !== false))
      throw new Error("mimo_project_bridge_recovery_denied");
  }
}
