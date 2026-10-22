import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence, type LocalControllerMaintenanceFence }
  from "@vioxen/subscription-runtime/store-local-file";
import { codexGoalJobDurableHandoffRootDir } from "../application/codex-goal-job-launch-loader";
import { withCodexGoalRegistryMutation } from "../codex-goal-job-manifest-revision";
import { hostedMimoBridgeMetadataBytes } from "../hosted-mimo-project-bridge";
import { readPrivateHostedMimoOperationBytes } from "../hosted-mimo-project-bridge-operation";
import { installedResearchRuntimeDirectory } from "../research-launch-admission";
import { researchCustody, researchHash, researchJson } from "../research-launch-files";
import { assertResearchInitialRoot, assertResearchSharedHost } from "../research-launch-host";
import { researchJobRuntimeNamespaceAbsent } from "../research-job-runtime-provenance";
import { JobRetirementDeletionScope, JobRetirementDocumentKind, JobRetirementLayoutId, JobRetirementOutputKind, JobRetirementPinAction,
  JobRetirementRefusal, JobRetirementRefused, JobRetirementRole, JobTerminalKind, jobRetirementContractVersion, jobRetirementPlanSchema,
  jobRetirementReceiptPath, jobRetirementRecordPaths, jobRetirementWorkstreamTombstonePath, refuseRetirement, type ClosedJobRecord,
  type JobRetirementOutput, type JobRetirementPin, type JobRetirementPlan, type JobTerminalProof, type RetiredJobRecord,
  type RetiredWorkstreamRecord, type RetirementReceipt } from "./job-retirement-contract";
import { assertNoForeignReferences, assertNoOtherJobClaims } from "./job-retirement-census";
import { linkedWorktrees } from "./job-retirement-git";
import { assertSameWorkspaceIdentity, observeRetirementWorkspace, proveJobOutput, type ObservedWorkspace } from "./job-retirement-output";
import { assertJobPinsRemovable, plannedJobPins, systemRetirementHost, tearDownJobPins, type RetirementHost } from "./job-retirement-pins";
import { assertRetirementRecordValid, jobRetirementWorkstreamGuardPath, observeJobRetirement, observeRetiredWorkstream, publishOrVerifyRetirementRecord,
  publishRetirementRecord, readRetirementRecordBytes, withdrawRetirementGuard, JobRetirementState } from "./job-retirement-records";
import { assertClosedNativeTerminalCurrent, proveJobTerminal } from "./job-retirement-terminal";
import { assertFenceRootsPresent, assertWorkstreamRegistryPlanned, loadRetirementUnit, resolveRetirementTarget, type MimoWorkstreamFacts, type RetirementJobEntry,
  type RetirementUnitTarget } from "./job-retirement-unit";

export const jobRetirementPlanDirectory = "/etc/subscription-runtime/job-retirement";
const fenceTimeoutMs = 60_000, fenceRetryMs = 2_000, planMaxBytes = 1024 * 1024;
const fenceRefusals = ["controller_maintenance_fence_active", "controller_maintenance_activity_active"];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const inside = (path: string, root: string) => path === root || path.startsWith(root + "/");
const placeholderSha256 = "0".repeat(64);

export enum JobRetirementStep { Fenced = "fenced", Guarded = "guarded", Closed = "closed", PinsTornDown = "pins-torn-down", Tombstoned = "tombstoned",
  WorkstreamTombstoned = "workstream-tombstoned" }
/** The CLI passes only `dryRun` or `cancel`; timing, the host and the step observer are TEST seams. */
export type JobRetirementOptions = Readonly<{
  dryRun?: boolean; cancel?: boolean; fenceTimeoutMs?: number; fenceRetryMs?: number; host?: RetirementHost;
  afterStep?: (step: JobRetirementStep) => void; now?: () => Date;
}>;
type Context = Readonly<{ planSha256: string; target: RetirementUnitTarget; host: RetirementHost; now: () => Date }>;
type Evaluation = Readonly<{
  entry: RetirementJobEntry; state: "pending" | JobRetirementState;
  terminal?: JobTerminalProof; output?: JobRetirementOutput; workspace?: ObservedWorkspace;
  pins: ReturnType<typeof plannedJobPins>; closedBytes?: Buffer; retiredBytes?: Buffer; retired?: RetiredJobRecord;
}>;

/** A root-owned `0600` plan in the root-owned `0700` plan directory, or a refusal. */
function readPlan(planPath: string) {
  if (dirname(planPath) !== jobRetirementPlanDirectory) refuseRetirement(JobRetirementRefusal.PlanInvalid);
  let bytes: Buffer, value: unknown;
  try { researchCustody(jobRetirementPlanDirectory, true); bytes = readPrivateHostedMimoOperationBytes(planPath, planMaxBytes); value = researchJson(bytes); }
  catch { return refuseRetirement(JobRetirementRefusal.PlanInvalid); }
  const parsed = jobRetirementPlanSchema.safeParse(value);
  if (!parsed.success) return refuseRetirement(JobRetirementRefusal.PlanInvalid);
  return { bytes, plan: parsed.data, planSha256: researchHash(bytes) };
}
async function acquireFences(roots: readonly string[], owner: string, options: JobRetirementOptions): Promise<LocalControllerMaintenanceFence[]> {
  const deadline = Date.now() + (options.fenceTimeoutMs ?? fenceTimeoutMs);
  for (;;) {
    const held: LocalControllerMaintenanceFence[] = [];
    try {
      for (const root of roots) held.push(await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: root, owner }));
      return held;
    } catch (error) {
      for (const fence of held.reverse()) await releaseLocalControllerMaintenanceFence(fence);
      if (!fenceRefusals.includes((error as Error).message)) throw error;
    }
    if (Date.now() >= deadline) refuseRetirement(JobRetirementRefusal.FenceBusy);
    await sleep(options.fenceRetryMs ?? fenceRetryMs);
  }
}
async function withFences<T>(context: Context, options: JobRetirementOptions, effect: () => Promise<T>): Promise<T> {
  const fences = await acquireFences(context.target.fenceRoots, "job-retirement:" + context.planSha256, options);
  // Fences are always released: a closed record, and for MiMo the durable
  // guard, keep the job or workstream closed across a failure or crash.
  try { return await effect(); } finally { for (const fence of fences.reverse()) await releaseLocalControllerMaintenanceFence(fence); }
}
const refusalOf = (error: unknown): JobRetirementRefusal | undefined => error instanceof JobRetirementRefused ? error.reason : undefined;
function withJob(error: unknown, jobId: string): unknown {
  return error instanceof JobRetirementRefused && !error.jobId ? new JobRetirementRefused(error.reason, jobId) : error;
}
const forJob = async <T>(jobId: string, effect: () => T | Promise<T>): Promise<T> => {
  try { return await effect(); } catch (error) { throw withJob(error, jobId); }
};
const forJobSync = <T>(jobId: string, effect: () => T): T => {
  try { return effect(); } catch (error) { throw withJob(error, jobId); }
};

/** One job's state and every proof the next effects rely on. Throws the first refusal. */
async function evaluateJob(entry: RetirementJobEntry, context: Context): Promise<Evaluation> {
  const { registryRootDir } = context.target, paths = jobRetirementRecordPaths(registryRootDir, entry.jobId);
  const observed = observeJobRetirement(registryRootDir, entry.jobId);
  if (observed && observed.record.planSha256 !== context.planSha256) refuseRetirement(JobRetirementRefusal.RecordConflict, entry.jobId);
  if (observed && (observed.record.manifestSha256 !== entry.manifestSha256 || observed.record.role !== entry.role))
    refuseRetirement(JobRetirementRefusal.RecordConflict, entry.jobId);
  if (observed?.state === JobRetirementState.Retired) {
    const closedBytes = readRetirementRecordBytes(paths.closed);
    if (!closedBytes || researchHash(closedBytes) !== observed.record.closedSha256) return refuseRetirement(JobRetirementRefusal.RecordConflict, entry.jobId);
    await forJob(entry.jobId, () => assertSameWorkspaceIdentity(observed.record.workspace));
    return { entry, state: observed.state, pins: [], closedBytes, retiredBytes: readRetirementRecordBytes(paths.retired)!, retired: observed.record };
  }
  const prove = () => proveJobTerminal({ manifest: entry.manifest, role: entry.role, startedByBridge: entry.startedByBridge });
  const terminal = await forJob(entry.jobId, async () => {
    if (observed?.state !== JobRetirementState.Retiring) return await prove();
    const closed = observed.record;
    // A native start may have lost its pins to this retirement; any other kind is proven again in full.
    if (closed.terminal.kind === JobTerminalKind.NativeReleased)
      assertClosedNativeTerminalCurrent(entry.manifest, closed.terminal, closed.bootId, context.host.bootId());
    else if (!isDeepStrictEqual(await prove(), closed.terminal)) refuseRetirement(JobRetirementRefusal.TerminalUnproven);
    return closed.terminal;
  });
  if ((terminal.kind === JobTerminalKind.NeverStarted || terminal.kind === JobTerminalKind.ControllerClosed) &&
      entry.planned.output.kind !== JobRetirementOutputKind.Clean) refuseRetirement(JobRetirementRefusal.OutputKindInvalid, entry.jobId);
  const workspace = await forJob(entry.jobId, () => observeRetirementWorkspace(entry.manifest.workspacePath));
  // The controller's workspace is the source; the unit checks it as a whole.
  const output = await forJob(entry.jobId, () => entry.role === JobRetirementRole.Controller
    ? { kind: JobRetirementOutputKind.Clean as const, head: workspace.repository.head }
    : proveJobOutput({ jobId: entry.jobId, taskId: entry.manifest.taskId, workspace, planned: entry.planned.output, branches: entry.branches,
      durableHandoffRootDir: codexGoalJobDurableHandoffRootDir(entry.manifest, registryRootDir) }));
  const pins = await forJob(entry.jobId, () => {
    const planned = researchJobRuntimeNamespaceAbsent(entry.jobId) ? [] : plannedJobPins(entry.manifest, workspace.identity);
    assertJobPinsRemovable(planned, context.host);
    return planned;
  });
  return { entry, state: observed?.state ?? "pending", terminal, output, workspace, pins,
    ...(observed ? { closedBytes: readRetirementRecordBytes(paths.closed)! } : {}) };
}
/** Job units: one workspace and the planned jobs sharing it, so nothing outside may depend on it. */
function assertJobUnit(evaluation: Evaluation, context: Context, plan: JobRetirementPlan): void {
  const workspace = evaluation.workspace;
  if (!workspace) return;
  if (!workspace.repository.linked) for (const [, path] of linkedWorktrees(workspace.repository.commonDir))
    if (!inside(path, workspace.identity.path) && existsSync(path)) refuseRetirement(JobRetirementRefusal.WorktreeOutsideUnit, evaluation.entry.jobId);
  assertNoOtherJobClaims(workspace.identity.path,
    new Set(plan.jobs.map(job => jobRetirementRecordPaths(context.target.registryRootDir, job.jobId).manifest)));
  assertNoForeignReferences(workspace.identity.path);
}
/** The MiMo unit is its scratch root; only its own binding and registry's jobs may claim paths in it. */
/** `entries` is every planned job, evaluated or refused alike: a planned manifest
 * is never a foreign claimant, so a per-job refusal cannot surface as workspace_shared. */
function assertWorkstreamUnit(facts: MimoWorkstreamFacts, entries: readonly RetirementJobEntry[], context: Context): void {
  assertNoOtherJobClaims(facts.binding.scratchRoot, new Set([context.target.mimo!.bindingPath,
    ...entries.map(entry => jobRetirementRecordPaths(context.target.registryRootDir, entry.jobId).manifest)]));
  assertNoForeignReferences(facts.binding.scratchRoot);
}

function closedRecord(evaluation: Evaluation, context: Context): ClosedJobRecord {
  return { schema: JobRetirementDocumentKind.ClosedJob, schemaVersion: jobRetirementContractVersion, planSha256: context.planSha256,
    runtimeRelease: installedResearchRuntimeDirectory(), registryRootDir: context.target.registryRootDir, jobId: evaluation.entry.jobId,
    role: evaluation.entry.role, manifestSha256: evaluation.entry.manifestSha256, terminal: evaluation.terminal!, bootId: context.host.bootId(),
    closedAt: context.now().toISOString() };
}
function retiredRecord(evaluation: Evaluation, context: Context, closedBytes: Buffer | undefined, pins: readonly JobRetirementPin[]): RetiredJobRecord {
  const { target } = context, mimo = target.layout.id === JobRetirementLayoutId.MimoWorkstream;
  return { schema: JobRetirementDocumentKind.RetiredJob, schemaVersion: jobRetirementContractVersion, planSha256: context.planSha256,
    runtimeRelease: installedResearchRuntimeDirectory(), layout: target.layout.id, registryRootDir: target.registryRootDir,
    jobId: evaluation.entry.jobId, role: evaluation.entry.role, manifestSha256: evaluation.entry.manifestSha256,
    closedSha256: closedBytes ? researchHash(closedBytes) : placeholderSha256, terminal: evaluation.terminal!, output: evaluation.output!,
    workspace: evaluation.workspace!.identity,
    deletion: mimo ? { scope: JobRetirementDeletionScope.Workstream, workstreamTombstone: jobRetirementWorkstreamTombstonePath(target.layout.stateDir) }
      : { scope: JobRetirementDeletionScope.Workspace },
    pins: [...pins], retiredAt: context.now().toISOString() };
}
type Tombstone = Readonly<{ jobId: string; role: JobRetirementRole; bytes?: Buffer }>;
function workstreamRecord(facts: MimoWorkstreamFacts, context: Context, tombstones: readonly Tombstone[]): RetiredWorkstreamRecord {
  return { schema: JobRetirementDocumentKind.RetiredWorkstream, schemaVersion: jobRetirementContractVersion, planSha256: context.planSha256,
    runtimeRelease: installedResearchRuntimeDirectory(), projectId: facts.binding.projectId, workstreamId: facts.binding.workstreamId,
    machineId: facts.binding.machineId, bindingSha256: facts.bindingSha256, registryRootDir: context.target.registryRootDir,
    scratchRoot: facts.scratchRoot, source: facts.source,
    jobs: tombstones.map(row => ({ jobId: row.jobId, role: row.role, tombstoneSha256: row.bytes ? researchHash(row.bytes) : placeholderSha256 })),
    unregisteredAttempts: [...facts.unregisteredAttempts], retiredAt: context.now().toISOString() };
}
function receiptRecord(context: Context, tombstones: readonly { jobId: string; record: RetiredJobRecord; sha256: string }[],
  workstreamBytes: Buffer | undefined): RetirementReceipt {
  return { schema: JobRetirementDocumentKind.Receipt, schemaVersion: jobRetirementContractVersion, planSha256: context.planSha256,
    runtimeRelease: installedResearchRuntimeDirectory(), layout: context.target.layout.id, registryRootDir: context.target.registryRootDir,
    jobs: tombstones.map(row => ({ jobId: row.jobId, closedSha256: row.record.closedSha256, tombstoneSha256: row.sha256, pins: row.record.pins })),
    workstreamTombstoneSha256: workstreamBytes ? researchHash(workstreamBytes) : null, completedAt: context.now().toISOString() };
}
const tombstoneRows = (tombstones: readonly { jobId: string; bytes: Buffer }[]) =>
  tombstones.map(row => ({ jobId: row.jobId, record: researchJson(row.bytes) as RetiredJobRecord, sha256: researchHash(row.bytes) }));
const tombstonePath = (context: Context, jobId: string) => jobRetirementRecordPaths(context.target.registryRootDir, jobId).retired;
/** Every record this plan will write, as its readers will see it, checked before the first effect. */
function assertDraftsValid(evaluations: readonly Evaluation[], facts: MimoWorkstreamFacts | undefined, context: Context): void {
  const drafts = evaluations.map(evaluation => {
    if (evaluation.retired) return { jobId: evaluation.entry.jobId, record: evaluation.retired, sha256: researchHash(evaluation.retiredBytes!) };
    const paths = jobRetirementRecordPaths(context.target.registryRootDir, evaluation.entry.jobId);
    if (!evaluation.closedBytes) forJobSync(evaluation.entry.jobId, () => assertRetirementRecordValid(paths.closed, closedRecord(evaluation, context)));
    const pins = evaluation.pins.map(pin => ({ path: pin.path, action: JobRetirementPinAction.Unmounted }));
    const record = retiredRecord(evaluation, context, evaluation.closedBytes, pins);
    forJobSync(evaluation.entry.jobId, () => assertRetirementRecordValid(paths.retired, record));
    return { jobId: evaluation.entry.jobId, record, sha256: placeholderSha256 };
  });
  const workstream = facts ? workstreamRecord(facts, context, drafts.map(row => ({ jobId: row.jobId, role: row.record.role }))) : undefined;
  if (workstream) assertRetirementRecordValid(jobRetirementWorkstreamTombstonePath(context.target.layout.stateDir), workstream);
  assertRetirementRecordValid(jobRetirementReceiptPath(context.target.layout.stateDir, context.planSha256),
    receiptRecord(context, drafts, workstream ? Buffer.from(JSON.stringify(workstream)) : undefined));
}
function receiptDirectory(stateDir: string): void {
  const directory = join(stateDir, "job-retirements");
  researchCustody(stateDir);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  researchCustody(directory, true);
}
/** The MiMo guard names its plan; a replay of another plan is refused. */
function workstreamGuard(stateRoot: string, planSha256: string): Buffer | undefined {
  const bytes = readRetirementRecordBytes(jobRetirementWorkstreamGuardPath(stateRoot));
  if (bytes && !isDeepStrictEqual(researchJson(bytes), { schemaVersion: 1, planSha256 })) refuseRetirement(JobRetirementRefusal.RecordConflict);
  return bytes;
}

/** Withdraw a retirement that has closed nothing: only the MiMo guard of this
 * plan may exist, and removing it reopens the workstream. Anything closed or
 * retired already can only be finished, by replaying the same plan. */
function cancelRetirement(plan: JobRetirementPlan, context: Context) {
  const stateRoot = context.target.mimo?.binding.stateRoot;
  if (stateRoot && observeRetiredWorkstream(stateRoot)) refuseRetirement(JobRetirementRefusal.RetirementPending);
  for (const job of plan.jobs)
    if (observeJobRetirement(context.target.registryRootDir, job.jobId)) refuseRetirement(JobRetirementRefusal.RetirementPending, job.jobId);
  const guard = stateRoot ? workstreamGuard(stateRoot, context.planSha256) : undefined;
  if (guard) withdrawRetirementGuard(stateRoot!);
  return { ok: true, cancelled: guard !== undefined, planSha256: context.planSha256 };
}

/** Root operator CLI: retire one exact job or one MiMo workstream from a reviewed
 * plan. The runtime owns the fact; deleting workspace bodies is the host tool's. */
export async function retireHostedJobs(planPath: string, options: JobRetirementOptions = {}): Promise<unknown> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const { plan, planSha256 } = readPlan(planPath);
  let machineId: string | undefined;
  try { machineId = hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim(); } catch { /* Refused below. */ }
  if (machineId !== plan.machineId) refuseRetirement(JobRetirementRefusal.MachineMismatch);
  const target = resolveRetirementTarget(plan);
  const context: Context = { planSha256, target, host: options.host ?? systemRetirementHost, now: options.now ?? (() => new Date()) };
  assertFenceRootsPresent(target);
  if (options.cancel) return await withFences(context, options, async () => cancelRetirement(plan, context));
  // A completed workstream may already have lost its scratch root to the host
  // tool: only its records are read, and a missing receipt is written from them.
  const completed = target.mimo && observeRetiredWorkstream(target.mimo.binding.stateRoot);
  if (completed) {
    if (completed.record.planSha256 !== planSha256) refuseRetirement(JobRetirementRefusal.RecordConflict);
    const receiptPath = jobRetirementReceiptPath(target.layout.stateDir, planSha256);
    if (!options.dryRun) await withFences(context, options, async () => {
      if (readRetirementRecordBytes(receiptPath)) return;
      const tombstones = completed.record.jobs.map(job => {
        const bytes = readRetirementRecordBytes(tombstonePath(context, job.jobId));
        if (!bytes || researchHash(bytes) !== job.tombstoneSha256) return refuseRetirement(JobRetirementRefusal.RecordConflict, job.jobId);
        return { jobId: job.jobId, bytes };
      });
      receiptDirectory(target.layout.stateDir);
      publishOrVerifyRetirementRecord(receiptPath, receiptRecord(context, tombstoneRows(tombstones), readRetirementRecordBytes(completed.path)), "completedAt");
    });
    return { ok: true, alreadyRetired: true, planSha256, workstreamTombstonePath: completed.path, workstreamTombstoneSha256: completed.sha256, receiptPath };
  }
  if (options.dryRun) return await dryRun(plan, context);
  return await withFences(context, options, async () => {
    options.afterStep?.(JobRetirementStep.Fenced);
    const unit = loadRetirementUnit(plan, target), evaluations: Evaluation[] = [];
    if (target.mimo) workstreamGuard(target.mimo.binding.stateRoot, planSha256);
    for (const entry of unit.jobs) evaluations.push(await evaluateJob(entry, context));
    if (unit.mimo) assertWorkstreamUnit(unit.mimo, unit.jobs, context);
    else for (const evaluation of evaluations) assertJobUnit(evaluation, context, plan);
    assertDraftsValid(evaluations, unit.mimo, context);
    receiptDirectory(target.layout.stateDir);
    // Effects. Every record is exclusive, complete when visible and replay-verified.
    // Job creation checks the guard under the same registry lock, so a job is
    // either published before the guard and seen here, or refused.
    const stateRoot = target.mimo?.binding.stateRoot;
    if (stateRoot) await withCodexGoalRegistryMutation({ registryRootDir: target.registryRootDir, requireExistingRegistryRoot: true,
      effect: async () => {
        if (!workstreamGuard(stateRoot, planSha256)) publishRetirementRecord(jobRetirementWorkstreamGuardPath(stateRoot), { schemaVersion: 1, planSha256 });
        assertWorkstreamRegistryPlanned(plan, target);
      } });
    options.afterStep?.(JobRetirementStep.Guarded);
    const ordered = [...evaluations].sort((left, right) => Number(left.entry.role === JobRetirementRole.Controller) - Number(right.entry.role === JobRetirementRole.Controller));
    const closed = new Map<string, Buffer>();
    for (const evaluation of ordered) closed.set(evaluation.entry.jobId, evaluation.closedBytes ?? publishOrVerifyRetirementRecord(
      jobRetirementRecordPaths(target.registryRootDir, evaluation.entry.jobId).closed, closedRecord(evaluation, context), "closedAt"));
    options.afterStep?.(JobRetirementStep.Closed);
    const pins = new Map<string, JobRetirementPin[]>();
    for (const evaluation of ordered) if (evaluation.state !== JobRetirementState.Retired)
      pins.set(evaluation.entry.jobId, forJobSync(evaluation.entry.jobId, () => tearDownJobPins(evaluation.pins, context.host)));
    options.afterStep?.(JobRetirementStep.PinsTornDown);
    const tombstones = ordered.map(evaluation => ({ jobId: evaluation.entry.jobId, role: evaluation.entry.role,
      bytes: evaluation.retiredBytes ?? publishOrVerifyRetirementRecord(tombstonePath(context, evaluation.entry.jobId),
        retiredRecord(evaluation, context, closed.get(evaluation.entry.jobId)!, pins.get(evaluation.entry.jobId) ?? []), "retiredAt") }));
    options.afterStep?.(JobRetirementStep.Tombstoned);
    const workstreamPath = jobRetirementWorkstreamTombstonePath(target.layout.stateDir);
    const workstreamBytes = unit.mimo ? publishOrVerifyRetirementRecord(workstreamPath, workstreamRecord(unit.mimo, context, tombstones), "retiredAt") : undefined;
    if (unit.mimo) options.afterStep?.(JobRetirementStep.WorkstreamTombstoned);
    const receiptPath = jobRetirementReceiptPath(target.layout.stateDir, planSha256);
    const receiptBytes = publishOrVerifyRetirementRecord(receiptPath, receiptRecord(context, tombstoneRows(tombstones), workstreamBytes), "completedAt");
    return { ok: true, planSha256, receiptPath, receiptSha256: researchHash(receiptBytes),
      ...(workstreamBytes ? { workstreamTombstonePath: workstreamPath, workstreamTombstoneSha256: researchHash(workstreamBytes) } : {}),
      jobs: tombstones.map(row => ({ jobId: row.jobId, tombstonePath: tombstonePath(context, row.jobId), tombstoneSha256: researchHash(row.bytes) })) };
  });
}

/** Every check, no effect and no fence: per job the first refusal, if any. */
async function dryRun(plan: JobRetirementPlan, context: Context) {
  const jobs: Record<string, unknown>[] = [], evaluations: Evaluation[] = [];
  let unitBlocker: string | undefined;
  try {
    const unit = loadRetirementUnit(plan, context.target);
    if (context.target.mimo) workstreamGuard(context.target.mimo.binding.stateRoot, context.planSha256);
    for (const entry of unit.jobs) {
      try {
        const evaluation = await evaluateJob(entry, context);
        if (!unit.mimo) assertJobUnit(evaluation, context, plan);
        evaluations.push(evaluation);
        jobs.push({ jobId: entry.jobId, role: entry.role, state: evaluation.state, manifestSha256: entry.manifestSha256,
          terminal: evaluation.terminal?.kind ?? evaluation.retired?.terminal.kind, output: evaluation.output ?? evaluation.retired?.output,
          workspace: evaluation.workspace?.identity ?? evaluation.retired?.workspace, pins: evaluation.pins.map(pin => pin.path) });
      } catch (error) {
        const reason = refusalOf(error);
        if (!reason) throw error;
        jobs.push({ jobId: entry.jobId, role: entry.role, manifestSha256: entry.manifestSha256, blocker: reason });
      }
    }
    if (unit.mimo) assertWorkstreamUnit(unit.mimo, unit.jobs, context);
    if (evaluations.length === unit.jobs.length) assertDraftsValid(evaluations, unit.mimo, context);
  } catch (error) {
    const reason = refusalOf(error);
    if (!reason) throw error;
    const jobId = (error as JobRetirementRefused).jobId;
    unitBlocker = jobId ? `${reason}:${jobId}` : reason;
  }
  const ready = unitBlocker === undefined && jobs.every(job => job.blocker === undefined);
  return { ok: true, dryRun: true, planSha256: context.planSha256, target: plan.target, layout: context.target.layout.id, ready,
    ...(unitBlocker ? { unitBlocker } : {}), jobs, fenceRoots: context.target.fenceRoots };
}
