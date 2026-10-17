import { z } from "zod";

/** Versioned host contract for retired jobs. The host retention tool consumes
 * `host-integration/job-retirement/v1`, which a test regenerates from this file.
 * Pure on purpose: zod only, no filesystem, so a plain Node script can load it. */
export const jobRetirementContractVersion = 1;
export const jobRetirementRefusalPrefix = "job_retirement_";

/** Every reason the operator command can refuse with, after the prefix above. */
export enum JobRetirementRefusal {
  PlanInvalid = "plan_invalid", MachineMismatch = "machine_mismatch", LayoutUnsupported = "layout_unsupported",
  UnitMustBeWorkstream = "unit_must_be_workstream", ControllerRequiresWorkstream = "controller_requires_workstream",
  ControllerMissing = "controller_missing", BindingMismatch = "binding_mismatch", RouteOpen = "route_open",
  RecoveryPending = "recovery_pending", FenceBusy = "fence_busy", PlanJobsMismatch = "plan_jobs_mismatch",
  RegistryEntryIncomplete = "registry_entry_incomplete", ManifestMismatch = "manifest_mismatch", ManifestInvalid = "manifest_invalid",
  JobRootColocated = "job_root_colocated", WorkspaceMissing = "workspace_missing", WorkspaceOutsideScratch = "workspace_outside_scratch",
  AccountReserved = "account_reserved", ActiveStart = "active_start", TerminalUnproven = "terminal_unproven",
  CandidateUnpublished = "candidate_unpublished", WriterNotReleased = "writer_not_released", RunnerNotDisposed = "runner_not_disposed",
  WorkerAlive = "worker_alive", NeverStartedUnproven = "never_started_unproven", OutputKindInvalid = "output_kind_invalid",
  OperationsUnsettled = "operations_unsettled", AttemptUnaccounted = "attempt_unaccounted", HandoffMissing = "handoff_missing",
  HandoffInvalid = "handoff_invalid", HandoffIncomplete = "handoff_incomplete", HandoffStale = "handoff_stale",
  WorkspaceDirty = "workspace_dirty", BranchUnpublishedCommits = "branch_unpublished_commits", StashPresent = "stash_present",
  WorktreeOutsideUnit = "worktree_outside_unit", AlternatesReferenced = "alternates_referenced", AlternatesUnsupported = "alternates_unsupported",
  ReferenceCensusIncomplete = "reference_census_incomplete", WorkspaceShared = "workspace_shared", StateInsideUnit = "state_inside_unit",
  WorkspaceForeignOwner = "workspace_foreign_owner", GitConfigUnsafe = "git_config_unsafe", GitSubmodulePresent = "git_submodule_present",
  GitIndexMasked = "git_index_masked", GitLimitExceeded = "git_limit_exceeded", RecordInvalid = "record_invalid",
  RetirementPending = "retirement_pending",
  ScratchUnknownEntry = "scratch_unknown_entry", SourceMismatch = "source_mismatch", PinUnexpected = "pin_unexpected", PinBusy = "pin_busy",
  RecordConflict = "record_conflict", TombstoneIdentityMismatch = "tombstone_identity_mismatch",
}
export class JobRetirementRefused extends Error {
  readonly code: string;
  constructor(readonly reason: JobRetirementRefusal, readonly jobId?: string) {
    super(jobRetirementRefusalPrefix + reason);
    this.code = jobRetirementRefusalPrefix + reason;
  }
}
export const refuseRetirement = (reason: JobRetirementRefusal, jobId?: string): never => { throw new JobRetirementRefused(reason, jobId); };

export enum JobRetirementLayoutId { ProjectWorkstream = "project-workstream", FlatWorkstream = "flat-workstream", MimoWorkstream = "mimo-workstream" }
export enum JobRetirementUnit { Job = "job", Workstream = "workstream" }
export enum JobRetirementRole { Worker = "worker", Controller = "controller" }
export enum JobTerminalKind { NativeReleased = "native-released", RunnerDisposed = "runner-disposed", NeverStarted = "never-started", ControllerClosed = "controller-closed" }
export enum JobRetirementOutputKind { Handoff = "handoff", Clean = "clean" }
export enum JobRetirementDeletionScope { Workspace = "workspace", Workstream = "workstream" }
export enum JobRetirementPinAction { Unmounted = "unmounted", NotMounted = "not-mounted" }
/** Which runtime fact proved a job without a native start terminal. */
export enum JobRetirementAuthorityProof { Released = "released", Absent = "absent" }
export enum JobRetirementDocumentKind {
  ClosedJob = "subscription-runtime-closed-job", RetiredJob = "subscription-runtime-retired-job",
  RetiredWorkstream = "subscription-runtime-retired-workstream", Receipt = "subscription-runtime-job-retirement-receipt",
}

const segment = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}", mimoSegment = "[a-z0-9][a-z0-9._-]{0,127}";
/** Registry roots the runtime can retire jobs from. Patterns are anchored and
 * use positional groups only, so Python `re` and ECMAScript read them alike. */
export const jobRetirementLayouts = Object.freeze({
  schema: "subscription-runtime-job-retirement-layouts", schemaVersion: jobRetirementContractVersion,
  layouts: Object.freeze([
    Object.freeze({ id: JobRetirementLayoutId.ProjectWorkstream, unit: JobRetirementUnit.Job,
      registryPattern: `^/srv/worker-state/jobs/(${segment})/(${segment})/registry$`, groups: Object.freeze(["projectId", "workstreamId"]),
      stateDir: "/srv/worker-state/jobs/{projectId}/{workstreamId}", scratchRoot: "/srv/workers/jobs/{projectId}/{workstreamId}" }),
    Object.freeze({ id: JobRetirementLayoutId.FlatWorkstream, unit: JobRetirementUnit.Job,
      registryPattern: `^/srv/worker-state/jobs/(${segment})/registry$`, groups: Object.freeze(["workstreamId"]),
      stateDir: "/srv/worker-state/jobs/{workstreamId}", scratchRoot: "/srv/workers/jobs/{workstreamId}" }),
    Object.freeze({ id: JobRetirementLayoutId.MimoWorkstream, unit: JobRetirementUnit.Workstream,
      registryPattern: `^/srv/worker-state/mimo-projects/(${mimoSegment})/(${mimoSegment})/registry$`, groups: Object.freeze(["projectId", "workstreamId"]),
      stateDir: "/srv/worker-state/mimo-projects/{projectId}/{workstreamId}", scratchRoot: "/srv/workers/mimo-projects/{projectId}/{workstreamId}" }),
  ]),
  jobIdPattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
  records: Object.freeze({
    manifest: "{registryRootDir}/{jobId}/job.json", closed: "{registryRootDir}/{jobId}/terminal.json",
    retired: "{registryRootDir}/{jobId}/retired.json", workstreamTombstone: "{stateDir}/retired.json",
    receipt: "{stateDir}/job-retirements/{planSha256}.json",
    runnerEvents: "{jobRootDir}/{taskId}.events.jsonl", runnerDisposedEvent: "runner_disposed",
    mimoSource: "{scratchRoot}/source", mimoWorkspace: "{scratchRoot}/workspaces/{jobId}",
  }),
  /** Where the runtime looks for repositories that could borrow from a unit.
   * Bounded on purpose; the host tool runs its own host-wide check as well. */
  referenceCensus: Object.freeze({
    bindings: "/etc/subscription-runtime/mimo-projects/*/*.json",
    registries: Object.freeze(["/srv/worker-state/jobs/*/registry", "/srv/worker-state/jobs/*/*/registry", "/srv/worker-state/mimo-projects/*/*/registry"]),
    snapshots: "/srv/workers/mimo-project-snapshots/*/*",
  }),
});
export type JobRetirementLayout = Readonly<{
  id: JobRetirementLayoutId; unit: JobRetirementUnit; registryRootDir: string; stateDir: string; scratchRoot: string;
  projectId?: string; workstreamId: string;
}>;
/** The one place a registry root becomes a layout; `undefined` is unsupported. */
export function resolveJobRetirementLayout(registryRootDir: string): JobRetirementLayout | undefined {
  for (const layout of jobRetirementLayouts.layouts) {
    const match = new RegExp(layout.registryPattern).exec(registryRootDir);
    if (!match) continue;
    const values = Object.fromEntries(layout.groups.map((name, index) => [name, match[index + 1]!])) as Record<string, string>;
    const fill = (template: string) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key]!);
    return Object.freeze({ id: layout.id, unit: layout.unit, registryRootDir, stateDir: fill(layout.stateDir), scratchRoot: fill(layout.scratchRoot),
      ...(values.projectId === undefined ? {} : { projectId: values.projectId }), workstreamId: values.workstreamId! });
  }
  return undefined;
}
export const jobRetirementRecordPaths = (registryRootDir: string, jobId: string) => ({
  manifest: `${registryRootDir}/${jobId}/job.json`, closed: `${registryRootDir}/${jobId}/terminal.json`, retired: `${registryRootDir}/${jobId}/retired.json`,
});
export const jobRetirementWorkstreamTombstonePath = (stateDir: string): string => `${stateDir}/retired.json`;
export const jobRetirementReceiptPath = (stateDir: string, planSha256: string): string => `${stateDir}/job-retirements/${planSha256}.json`;

// Structural schemas. Cross-field rules live in validateJobRetirementDocument.
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitObject = z.string().regex(/^[a-f0-9]{40}$/);
const absolutePath = z.string().max(4096).regex(/^(?!.*\/\.{1,2}(?:\/|$))\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
const jobId = z.string().regex(new RegExp(jobRetirementLayouts.jobIdPattern));
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const directoryIdentity = z.object({ path: absolutePath, device: z.number().int().min(0), inode: z.number().int().min(1) }).strict();
const role = z.enum(JobRetirementRole);
const terminal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(JobTerminalKind.NativeReleased), startId: z.string().regex(/^[a-f0-9-]{36}$/),
    specSha256: sha256, lastTerminalSha256: sha256 }).strict(),
  z.object({ kind: z.literal(JobTerminalKind.RunnerDisposed), eventsPath: absolutePath, lastEventSha256: sha256 }).strict(),
  z.object({ kind: z.literal(JobTerminalKind.NeverStarted), birth: z.enum(JobRetirementAuthorityProof) }).strict(),
  z.object({ kind: z.literal(JobTerminalKind.ControllerClosed), writer: z.enum(JobRetirementAuthorityProof) }).strict(),
]);
const output = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(JobRetirementOutputKind.Handoff), packetPath: absolutePath, manifestSha256: sha256, head: gitObject }).strict(),
  z.object({ kind: z.literal(JobRetirementOutputKind.Clean), head: gitObject }).strict(),
]);
const pin = z.object({ path: absolutePath, action: z.enum(JobRetirementPinAction) }).strict();
const header = { schemaVersion: z.literal(jobRetirementContractVersion), planSha256: sha256, runtimeRelease: absolutePath } as const;

/** `{registryRootDir}/{jobId}/terminal.json`: the explicit runtime record that the
 * job is terminal and will never start again. Written first, under the fence.
 * `bootId` lets a replay after a reboot rely on the reboot itself: nothing of
 * the closing boot, a pin or a provider unit, can still be running. */
export const closedJobSchema = z.object({ schema: z.literal(JobRetirementDocumentKind.ClosedJob), ...header,
  registryRootDir: absolutePath, jobId, role, manifestSha256: sha256, terminal,
  bootId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/), closedAt: utc }).strict();
/** `{registryRootDir}/{jobId}/retired.json`: Status and Stop answer from it alone. */
export const retiredJobSchema = z.object({ schema: z.literal(JobRetirementDocumentKind.RetiredJob), ...header,
  layout: z.enum(JobRetirementLayoutId), registryRootDir: absolutePath, jobId, role, manifestSha256: sha256, closedSha256: sha256,
  terminal, output, workspace: directoryIdentity,
  deletion: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal(JobRetirementDeletionScope.Workspace) }).strict(),
    z.object({ scope: z.literal(JobRetirementDeletionScope.Workstream), workstreamTombstone: absolutePath }).strict(),
  ]),
  pins: z.array(pin).max(768), retiredAt: utc }).strict();
/** `{stateDir}/retired.json`: the MiMo unit. Only this record names the scratch root. */
export const retiredWorkstreamSchema = z.object({ schema: z.literal(JobRetirementDocumentKind.RetiredWorkstream), ...header,
  projectId: z.string().regex(new RegExp(`^${mimoSegment}$`)), workstreamId: z.string().regex(new RegExp(`^${mimoSegment}$`)),
  machineId: z.string().regex(/^[a-f0-9]{32}$/), bindingSha256: sha256, registryRootDir: absolutePath,
  scratchRoot: directoryIdentity, source: directoryIdentity.extend({ head: gitObject, alternates: z.array(z.string().max(4096)).max(64) }).strict(),
  jobs: z.array(z.object({ jobId, role, tombstoneSha256: sha256 }).strict()).min(1).max(4096),
  unregisteredAttempts: z.array(z.object({ jobId, workspace: directoryIdentity.nullable() }).strict()).max(4096),
  retiredAt: utc }).strict();
export const retirementReceiptSchema = z.object({ schema: z.literal(JobRetirementDocumentKind.Receipt), ...header,
  layout: z.enum(JobRetirementLayoutId), registryRootDir: absolutePath,
  jobs: z.array(z.object({ jobId, closedSha256: sha256, tombstoneSha256: sha256, pins: z.array(pin).max(768) }).strict()).min(1).max(4096),
  workstreamTombstoneSha256: sha256.nullable(), completedAt: utc }).strict();
export type ClosedJobRecord = z.infer<typeof closedJobSchema>;
export type RetiredJobRecord = z.infer<typeof retiredJobSchema>;
export type RetiredWorkstreamRecord = z.infer<typeof retiredWorkstreamSchema>;
export type RetirementReceipt = z.infer<typeof retirementReceiptSchema>;
export type JobTerminalProof = z.infer<typeof terminal>;
export type JobRetirementOutput = z.infer<typeof output>;
export type JobRetirementPin = z.infer<typeof pin>;
export type DirectoryIdentityRecord = z.infer<typeof directoryIdentity>;
const documentSchema = z.discriminatedUnion("schema", [closedJobSchema, retiredJobSchema, retiredWorkstreamSchema, retirementReceiptSchema]);

/** Reviewed operator input in `/etc/subscription-runtime/job-retirement/`. Not a
 * host record: the host tool never reads plans, only what a plan produced. */
export enum JobRetirementTargetKind { Job = "job", MimoWorkstream = "mimo-workstream" }
export const jobRetirementPlanSchema = z.object({ schemaVersion: z.literal(1), machineId: z.string().regex(/^[a-f0-9]{32}$/),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal(JobRetirementTargetKind.Job), registryRootDir: absolutePath, jobId }).strict(),
    z.object({ kind: z.literal(JobRetirementTargetKind.MimoWorkstream), projectId: z.string().regex(new RegExp(`^${mimoSegment}$`)),
      workstreamId: z.string().regex(new RegExp(`^${mimoSegment}$`)), expectedBindingSha256: sha256 }).strict(),
  ]),
  jobs: z.array(z.object({ jobId, expectedManifestSha256: sha256, output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal(JobRetirementOutputKind.Handoff), manifestSha256: sha256 }).strict(),
    z.object({ kind: z.literal(JobRetirementOutputKind.Clean) }).strict(),
  ]) }).strict()).min(1).max(4096),
}).strict().refine(plan => new Set(plan.jobs.map(job => job.jobId)).size === plan.jobs.length);
export type JobRetirementPlan = z.infer<typeof jobRetirementPlanSchema>;
export type PlannedRetirementJob = JobRetirementPlan["jobs"][number];

/** JSON Schema 2020-12 of every host-facing record, committed as `v1/schema.json`. */
export function jobRetirementJsonSchema(): Record<string, unknown> {
  const registry = z.registry<{ id: string; title: string }>();
  registry.add(directoryIdentity, { id: "directoryIdentity", title: "Directory path with its device and inode" });
  registry.add(terminal, { id: "terminalProof", title: "Explicit runtime proof that a job is terminal" });
  registry.add(output, { id: "outputProof", title: "Where the workspace content is preserved" });
  registry.add(pin, { id: "pin", title: "Research pin handled by the retirement" });
  registry.add(closedJobSchema, { id: "closedJob", title: "Closed job (terminal.json)" });
  registry.add(retiredJobSchema, { id: "retiredJob", title: "Retired job tombstone (retired.json)" });
  registry.add(retiredWorkstreamSchema, { id: "retiredWorkstream", title: "Retired MiMo workstream tombstone" });
  registry.add(retirementReceiptSchema, { id: "receipt", title: "Retirement receipt" });
  return { ...z.toJSONSchema(documentSchema, { target: "draft-2020-12", metadata: registry }),
    $id: "https://github.com/vioxen/subscription-runtime/host-integration/job-retirement/v1/schema.json",
    title: "subscription-runtime job retirement records, version 1" };
}

/** Rules a JSON Schema cannot state. Rule names are the stable `reason` values. */
export enum JobRetirementDocumentRule {
  Schema = "schema", LayoutUnknown = "layout_unknown", LayoutMismatch = "layout_mismatch",
  WorkspaceOutsideScratch = "workspace_outside_scratch", DeletionScopeInvalid = "deletion_scope_invalid",
  SourcePathInvalid = "source_path_invalid", DuplicateJob = "duplicate_job", RoleTerminalMismatch = "role_terminal_mismatch",
}
export type JobRetirementDocument = z.infer<typeof documentSchema>;
export type JobRetirementDocumentVerdict = { ok: true; document: JobRetirementDocument } | { ok: false; reason: JobRetirementDocumentRule };
const inside = (path: string, root: string) => path.startsWith(root + "/");

export function validateJobRetirementDocument(value: unknown): JobRetirementDocumentVerdict {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: JobRetirementDocumentRule.Schema };
  const document = parsed.data, fail = (reason: JobRetirementDocumentRule) => ({ ok: false as const, reason });
  if (document.schema === JobRetirementDocumentKind.RetiredWorkstream) {
    const layout = resolveJobRetirementLayout(document.registryRootDir);
    if (!layout || layout.id !== JobRetirementLayoutId.MimoWorkstream || layout.projectId !== document.projectId ||
        layout.workstreamId !== document.workstreamId) return fail(JobRetirementDocumentRule.LayoutMismatch);
    if (document.scratchRoot.path !== layout.scratchRoot) return fail(JobRetirementDocumentRule.WorkspaceOutsideScratch);
    if (document.source.path !== `${layout.scratchRoot}/source`) return fail(JobRetirementDocumentRule.SourcePathInvalid);
    const ids = [...document.jobs.map(job => job.jobId), ...document.unregisteredAttempts.map(attempt => attempt.jobId)];
    if (new Set(ids).size !== ids.length) return fail(JobRetirementDocumentRule.DuplicateJob);
    if (document.jobs.filter(job => job.role === JobRetirementRole.Controller).length !== 1) return fail(JobRetirementDocumentRule.RoleTerminalMismatch);
    if (document.unregisteredAttempts.some(({ jobId, workspace }) => workspace && workspace.path !== `${layout.scratchRoot}/workspaces/${jobId}`))
      return fail(JobRetirementDocumentRule.WorkspaceOutsideScratch);
    return { ok: true, document };
  }
  const layout = resolveJobRetirementLayout(document.registryRootDir);
  if (!layout) return fail(JobRetirementDocumentRule.LayoutUnknown);
  if (document.schema === JobRetirementDocumentKind.Receipt) return document.layout === layout.id ? { ok: true, document } : fail(JobRetirementDocumentRule.LayoutMismatch);
  const controller = document.role === JobRetirementRole.Controller, kind = document.terminal.kind;
  const mimo = layout.id === JobRetirementLayoutId.MimoWorkstream;
  // Only a MiMo workstream retires its controller, always together with the unit.
  if (controller !== (kind === JobTerminalKind.ControllerClosed) || controller && !mimo) return fail(JobRetirementDocumentRule.RoleTerminalMismatch);
  if (document.schema === JobRetirementDocumentKind.ClosedJob) return { ok: true, document };
  if (document.layout !== layout.id) return fail(JobRetirementDocumentRule.LayoutMismatch);
  const workspace = document.workspace.path;
  if (mimo ? workspace !== (controller ? `${layout.scratchRoot}/source` : `${layout.scratchRoot}/workspaces/${document.jobId}`)
      : !inside(workspace, layout.scratchRoot)) return fail(JobRetirementDocumentRule.WorkspaceOutsideScratch);
  const deletion = document.deletion;
  if (mimo ? deletion.scope !== JobRetirementDeletionScope.Workstream || deletion.workstreamTombstone !== jobRetirementWorkstreamTombstonePath(layout.stateDir)
      : deletion.scope !== JobRetirementDeletionScope.Workspace) return fail(JobRetirementDocumentRule.DeletionScopeInvalid);
  return { ok: true, document };
}

/** What the host may do with one tombstone target it observed with lstat. */
export enum JobRetirementDeletionVerdict { Deletable = "deletable", Absent = "absent", IdentityMismatch = "identity_mismatch", NotDirectory = "not_directory", NotDeletable = "not_deletable" }
export type ObservedRetirementTarget = Readonly<{ kind: "absent" } | { kind: "directory" | "symlink" | "other"; device: number; inode: number }>;
/** Reference semantics for the host tool. A per-job MiMo tombstone never deletes
 * its own workspace: only the workstream tombstone covers the scratch root. */
export function jobRetirementDeletionVerdict(document: RetiredJobRecord | RetiredWorkstreamRecord, observed: ObservedRetirementTarget): JobRetirementDeletionVerdict {
  const target = document.schema === JobRetirementDocumentKind.RetiredWorkstream ? document.scratchRoot
    : document.deletion.scope === JobRetirementDeletionScope.Workspace ? document.workspace : undefined;
  if (!target) return JobRetirementDeletionVerdict.NotDeletable;
  if (observed.kind === "absent") return JobRetirementDeletionVerdict.Absent;
  if (observed.kind !== "directory") return JobRetirementDeletionVerdict.NotDirectory;
  return observed.device === target.device && observed.inode === target.inode ? JobRetirementDeletionVerdict.Deletable : JobRetirementDeletionVerdict.IdentityMismatch;
}

/** A record is only valid at the path its layout gives it. */
export function jobRetirementRecordLocationMatches(path: string, document: JobRetirementDocument): boolean {
  if (document.schema === JobRetirementDocumentKind.RetiredWorkstream) {
    const layout = resolveJobRetirementLayout(document.registryRootDir);
    return !!layout && path === jobRetirementWorkstreamTombstonePath(layout.stateDir);
  }
  if (document.schema === JobRetirementDocumentKind.Receipt) {
    const layout = resolveJobRetirementLayout(document.registryRootDir);
    return !!layout && path === jobRetirementReceiptPath(layout.stateDir, document.planSha256);
  }
  const paths = jobRetirementRecordPaths(document.registryRootDir, document.jobId);
  return path === (document.schema === JobRetirementDocumentKind.RetiredJob ? paths.retired : paths.closed);
}
/** Host obligation 4: a workstream tombstone covers exactly the job tombstones it lists. */
export function jobRetirementWorkstreamCovers(document: RetiredWorkstreamRecord,
  tombstoneSha256ByJob: ReadonlyMap<string, string | undefined>): boolean {
  return document.jobs.every(job => tombstoneSha256ByJob.get(job.jobId) === job.tombstoneSha256);
}
