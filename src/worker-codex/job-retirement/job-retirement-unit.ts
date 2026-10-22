import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { codexGoalRegistryInfrastructureEntries } from "../application/project-control/codex-goal-project-admission-target";
import { parseStoredCodexGoalJobManifest, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { assertHostedMimoWorkstreamDeclaration, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding,
  type HostedMimoProjectBinding } from "../hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";
import { hostedMimoProjectOperationCold, observeHostedMimoProjectOperation } from "../hosted-mimo-project-bridge-operation";
import { researchCustody, researchHash } from "../research-launch-files";
import { JobRetirementLayoutId, JobRetirementRefusal, JobRetirementRole, JobRetirementTargetKind, JobRetirementUnit,
  refuseRetirement, resolveJobRetirementLayout, type DirectoryIdentityRecord, type JobRetirementLayout, type JobRetirementPlan,
  type PlannedRetirementJob } from "./job-retirement-contract";
import { alternatesOf, assertNoStash, assertNoUnpublishedCommits, inspectRetirementRepository, linkedWorktrees,
  withContentRefreshedIndex } from "./job-retirement-git";
import { retirementDirectoryIdentity } from "./job-retirement-output";

const manifestMaxBytes = 8 * 1024 * 1024;
const inside = (path: string, root: string) => path === root || path.startsWith(root + "/");
export type RetirementJobEntry = Readonly<{
  planned: PlannedRetirementJob; jobId: string; role: JobRetirementRole; manifestSha256: string; manifest: CodexGoalJobManifest;
  /** Local branches whose commits must already be upstream. */
  branches: readonly string[];
  startedByBridge: boolean;
}>;
export type MimoWorkstreamFacts = Readonly<{
  binding: HostedMimoProjectBinding; bindingSha256: string;
  scratchRoot: DirectoryIdentityRecord; source: DirectoryIdentityRecord & { head: string; alternates: string[] };
  unregisteredAttempts: readonly Readonly<{ jobId: string; workspace: DirectoryIdentityRecord | null }>[];
}>;
export type RetirementUnitTarget = Readonly<{
  layout: JobRetirementLayout; registryRootDir: string;
  /** Maintenance fence roots, acquired in this order. */
  fenceRoots: readonly string[];
  mimo?: Readonly<{ bindingPath: string; bindingBytes: Buffer; binding: HostedMimoProjectBinding }>;
}>;

function mimoBinding(plan: JobRetirementPlan) {
  if (plan.target.kind !== JobRetirementTargetKind.MimoWorkstream) return refuseRetirement(JobRetirementRefusal.PlanInvalid);
  const { projectId, workstreamId } = plan.target;
  const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1, machineId: plan.machineId, projectId, workstreamId,
    operation: MimoProjectBridgeOperation.Status, jobId: "job-retirement" });
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${projectId}/${workstreamId}.json`;
  let bindingBytes: Buffer, binding: HostedMimoProjectBinding;
  try { bindingBytes = hostedMimoBridgeMetadataBytes(bindingPath); binding = parseHostedMimoProjectBinding(JSON.parse(bindingBytes.toString()), request); }
  catch { return refuseRetirement(JobRetirementRefusal.BindingMismatch); }
  if (researchHash(bindingBytes) !== plan.target.expectedBindingSha256) refuseRetirement(JobRetirementRefusal.BindingMismatch);
  return { bindingPath, bindingBytes, binding };
}
function directory(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Exact manifest bytes without custody: a planned job's own entry is checked
 * for root-private custody separately, before any record is written there. */
function manifestBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > manifestMaxBytes) throw new Error("registry entry");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error("registry entry");
    return bytes;
  } finally { closeSync(fd); }
}
/** Read the registered manifests of a registry root, refusing half-written entries. */
function registryManifests(registryRootDir: string): Map<string, { bytes: Buffer; manifest: CodexGoalJobManifest }> {
  const rows = new Map<string, { bytes: Buffer; manifest: CodexGoalJobManifest }>();
  for (const entry of readdirSync(registryRootDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) refuseRetirement(JobRetirementRefusal.RegistryEntryIncomplete);
    if (!entry.isDirectory()) continue;
    const path = join(registryRootDir, entry.name, "job.json");
    if (!existsSync(path)) {
      if (codexGoalRegistryInfrastructureEntries.has(entry.name)) continue;
      refuseRetirement(JobRetirementRefusal.RegistryEntryIncomplete);
    }
    try {
      const bytes = manifestBytes(path), manifest = parseStoredCodexGoalJobManifest(JSON.parse(bytes.toString("utf8")));
      if (manifest.jobId !== entry.name) throw new Error("registry entry");
      rows.set(entry.name, { bytes, manifest });
    } catch { refuseRetirement(JobRetirementRefusal.RegistryEntryIncomplete); }
  }
  return rows;
}
/** Everything before the fence: which roots to fence. All facts are read again under it. */
export function resolveRetirementTarget(plan: JobRetirementPlan): RetirementUnitTarget {
  if (plan.target.kind === JobRetirementTargetKind.MimoWorkstream) {
    const mimo = mimoBinding(plan), layout = resolveJobRetirementLayout(mimo.binding.registryRootDir);
    if (!layout || layout.id !== JobRetirementLayoutId.MimoWorkstream || layout.stateDir !== mimo.binding.stateRoot ||
        layout.scratchRoot !== mimo.binding.scratchRoot) return refuseRetirement(JobRetirementRefusal.LayoutUnsupported);
    const controller = registryManifests(mimo.binding.registryRootDir).get(mimo.binding.controllerJobId);
    if (!controller) return refuseRetirement(JobRetirementRefusal.ControllerMissing);
    return { layout, registryRootDir: mimo.binding.registryRootDir, fenceRoots: [mimo.binding.stateRoot, controller.manifest.jobRootDir], mimo };
  }
  const layout = resolveJobRetirementLayout(plan.target.registryRootDir);
  if (!layout) return refuseRetirement(JobRetirementRefusal.LayoutUnsupported);
  if (layout.unit !== JobRetirementUnit.Job) return refuseRetirement(JobRetirementRefusal.UnitMustBeWorkstream);
  // Jobs sharing the target's workspace (a producer and its verifier) retire together.
  const targetJobId = plan.target.jobId;
  if (!plan.jobs.some(job => job.jobId === targetJobId)) return refuseRetirement(JobRetirementRefusal.PlanInvalid);
  // Project-control activity on any controller of this registry can touch the job.
  const controllers = [...registryManifests(layout.registryRootDir).values()]
    .filter(row => row.manifest.accessBoundary === AccessBoundary.ProjectScopedControl)
    .map(row => row.manifest).sort((left, right) => left.jobId.localeCompare(right.jobId));
  if (!controllers.length) return refuseRetirement(JobRetirementRefusal.ControllerMissing);
  return { layout, registryRootDir: layout.registryRootDir, fenceRoots: controllers.map(controller => controller.jobRootDir) };
}
export function assertFenceRootsPresent(target: RetirementUnitTarget): void {
  for (const root of target.fenceRoots) if (!directory(root)) refuseRetirement(JobRetirementRefusal.ControllerMissing);
}

function operationFacts(binding: HostedMimoProjectBinding) {
  const root = join(binding.stateRoot, "mimo-bridge-operations"), byJob = new Map<string, Map<MimoProjectBridgeOperation, ReturnType<typeof observe>>>();
  const observe = (jobId: string, operation: MimoProjectBridgeOperation) => observeHostedMimoProjectOperation({ kind: "MimoProject",
    schemaVersion: 1, machineId: binding.machineId, projectId: binding.projectId, workstreamId: binding.workstreamId, operation, jobId }) as
    { state: string; result?: { ok?: boolean; result?: { ok?: boolean } } };
  if (!existsSync(root)) return byJob;
  researchCustody(root, true);
  const operations = Object.values(MimoProjectBridgeOperation) as string[];
  for (const name of readdirSync(root)) {
    if (name.endsWith(".tmp")) refuseRetirement(JobRetirementRefusal.OperationsUnsettled);
    if (/\.generation-\d+$/.test(name) || /\.start\.publication-busy-rearm-\d+\.json$/.test(name)) continue;
    const match = /^(.+)\.([a-z-]+)\.(owner|request|result)\.json$/.exec(name);
    if (!match || !operations.includes(match[2]!)) refuseRetirement(JobRetirementRefusal.OperationsUnsettled);
    if (!existsSync(join(root, `${match![1]}.${match![2]}.owner.json`))) refuseRetirement(JobRetirementRefusal.OperationsUnsettled);
    if (match![3] !== "owner") continue;
    let observed: ReturnType<typeof observe>, cold: boolean;
    try {
      observed = observe(match![1]!, match![2] as MimoProjectBridgeOperation);
      cold = observed.state === "settled" && hostedMimoProjectOperationCold({ kind: "MimoProject", schemaVersion: 1, machineId: binding.machineId,
        projectId: binding.projectId, workstreamId: binding.workstreamId, operation: match![2] as MimoProjectBridgeOperation, jobId: match![1]! });
    } catch { return refuseRetirement(JobRetirementRefusal.OperationsUnsettled); }
    // Settled means a published result; cold means its exact unit has zero PID,
    // an empty control group and no queued job, so it can run no further work.
    if (!cold) refuseRetirement(JobRetirementRefusal.OperationsUnsettled);
    const rows = byJob.get(match![1]!) ?? new Map();
    rows.set(match![2] as MimoProjectBridgeOperation, observed); byJob.set(match![1]!, rows);
  }
  return byJob;
}
const succeeded = (row: { result?: { ok?: boolean; result?: { ok?: boolean } } } | undefined) =>
  row?.result?.ok === true && row.result.result?.ok !== false;
function identity(path: string): DirectoryIdentityRecord {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuseRetirement(JobRetirementRefusal.ScratchUnknownEntry);
  return retirementDirectoryIdentity(path);
}

/** Open by the same declaration Create checks; anything that closes Create closes it here. */
function routeOpen(binding: HostedMimoProjectBinding): boolean {
  const projects = "/etc/subscription-runtime/projects";
  if (!binding.routingEnabled || existsSync(`${projects}/${binding.projectId}.route-disabled`) ||
      existsSync(`${projects}/${binding.projectId}.d/${binding.workstreamId}.route-disabled`)) return false;
  try { assertHostedMimoWorkstreamDeclaration(binding, hostedMimoBridgeMetadataBytes(`${projects}/${binding.projectId}.d/${binding.workstreamId}.yml`).toString("utf8")); }
  catch { return false; }
  return true;
}
/** A workstream is retired whole: its registry holds exactly the planned jobs.
 * Checked again once the guard is visible, so a job created in between refuses. */
export function assertWorkstreamRegistryPlanned(plan: JobRetirementPlan, target: RetirementUnitTarget,
  manifests: ReadonlyMap<string, unknown> = registryManifests(target.registryRootDir)): void {
  const planned = new Set(plan.jobs.map(job => job.jobId));
  if (manifests.size !== planned.size || [...manifests.keys()].some(jobId => !planned.has(jobId))) refuseRetirement(JobRetirementRefusal.PlanJobsMismatch);
}
/** Load the planned jobs of the target under the fence and check the unit around them. */
export function loadRetirementUnit(plan: JobRetirementPlan, target: RetirementUnitTarget): { jobs: RetirementJobEntry[]; mimo?: MimoWorkstreamFacts } {
  const manifests = registryManifests(target.registryRootDir);
  const planned = new Map(plan.jobs.map(job => [job.jobId, job]));
  if (target.mimo) {
    if (!hostedMimoBridgeMetadataBytes(target.mimo.bindingPath).equals(target.mimo.bindingBytes)) refuseRetirement(JobRetirementRefusal.BindingMismatch);
    const { binding } = target.mimo;
    if (existsSync(join(binding.stateRoot, ".controller-recovery.json"))) refuseRetirement(JobRetirementRefusal.RecoveryPending);
    if (routeOpen(binding)) refuseRetirement(JobRetirementRefusal.RouteOpen);
    assertWorkstreamRegistryPlanned(plan, target, manifests);
    if (!manifests.has(binding.controllerJobId)) refuseRetirement(JobRetirementRefusal.ControllerMissing);
  } else {
    const workspace = plan.target.kind === JobRetirementTargetKind.Job ? manifests.get(plan.target.jobId)?.manifest.workspacePath : undefined;
    if ([...planned.keys()].some(jobId => manifests.get(jobId)?.manifest.workspacePath !== workspace || workspace === undefined))
      refuseRetirement(JobRetirementRefusal.PlanJobsMismatch);
  }
  const operations = target.mimo ? operationFacts(target.mimo.binding) : new Map();
  const jobs = plan.jobs.map(job => jobEntry(target, job, manifests.get(job.jobId)!, operations.get(job.jobId)?.get(MimoProjectBridgeOperation.Start)));
  return target.mimo ? { jobs, mimo: workstreamFacts(target.mimo, jobs, operations) } : { jobs };
}

function jobEntry(target: RetirementUnitTarget, planned: PlannedRetirementJob, registered: { bytes: Buffer; manifest: CodexGoalJobManifest },
  start: { result?: { ok?: boolean; result?: { ok?: boolean } } } | undefined): RetirementJobEntry {
  const { manifest } = registered, manifestSha256 = researchHash(registered.bytes), entry = join(target.registryRootDir, planned.jobId);
  if (manifestSha256 !== planned.expectedManifestSha256) refuseRetirement(JobRetirementRefusal.ManifestMismatch, planned.jobId);
  try { researchCustody(entry, true); } catch { refuseRetirement(JobRetirementRefusal.ManifestInvalid, planned.jobId); }
  // A job root the worker writes must never hold the records Status trusts.
  if (inside(manifest.jobRootDir, entry) || inside(entry, manifest.jobRootDir)) refuseRetirement(JobRetirementRefusal.JobRootColocated, planned.jobId);
  if (inside(manifest.jobRootDir, manifest.workspacePath) || inside(manifest.workspacePath, manifest.jobRootDir))
    refuseRetirement(JobRetirementRefusal.ManifestInvalid, planned.jobId);
  const controller = manifest.accessBoundary === AccessBoundary.ProjectScopedControl;
  const branches = [`refs/heads/feat/${planned.jobId}`];
  if (!target.mimo) {
    if (controller) refuseRetirement(JobRetirementRefusal.ControllerRequiresWorkstream, planned.jobId);
    if (!inside(manifest.workspacePath, target.layout.scratchRoot) || manifest.workspacePath === target.layout.scratchRoot)
      refuseRetirement(JobRetirementRefusal.WorkspaceOutsideScratch, planned.jobId);
    return { planned, jobId: planned.jobId, role: JobRetirementRole.Worker, manifestSha256, manifest, branches, startedByBridge: false };
  }
  const { binding } = target.mimo;
  if (planned.jobId === binding.controllerJobId) {
    if (!controller || manifest.workspacePath !== binding.sourceWorkspacePath || binding.sourceWorkspacePath !== join(binding.scratchRoot, "source"))
      refuseRetirement(JobRetirementRefusal.ManifestInvalid, planned.jobId);
    return { planned, jobId: planned.jobId, role: JobRetirementRole.Controller, manifestSha256, manifest, branches: [], startedByBridge: false };
  }
  if (controller || manifest.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || manifest.jobRootDir !== join(binding.stateRoot, "jobs", planned.jobId))
    refuseRetirement(JobRetirementRefusal.ManifestInvalid, planned.jobId);
  if (manifest.workspacePath !== join(binding.scratchRoot, "workspaces", planned.jobId)) refuseRetirement(JobRetirementRefusal.WorkspaceOutsideScratch, planned.jobId);
  return { planned, jobId: planned.jobId, role: JobRetirementRole.Worker, manifestSha256, manifest, branches, startedByBridge: succeeded(start) };
}

/** The MiMo unit is the scratch root: source plus every worktree. */
function workstreamFacts(mimo: NonNullable<RetirementUnitTarget["mimo"]>, jobs: readonly RetirementJobEntry[],
  operations: ReturnType<typeof operationFacts>): MimoWorkstreamFacts {
  const { binding } = mimo, registered = new Set(jobs.map(job => job.jobId));
  const attempts = join(binding.stateRoot, "mimo-bridge-attempts"), unregisteredAttempts: { jobId: string; workspace: DirectoryIdentityRecord | null }[] = [];
  for (const name of existsSync(attempts) ? readdirSync(attempts) : []) {
    const jobId = /^(.+)\.json$/.exec(name)?.[1];
    if (!jobId) refuseRetirement(JobRetirementRefusal.AttemptUnaccounted);
    if (registered.has(jobId!)) continue;
    // A Create that never registered: its settled result must be a failure.
    const create = operations.get(jobId!)?.get(MimoProjectBridgeOperation.Create);
    if (!create || create.result?.ok !== false && create.result?.result?.ok !== false) refuseRetirement(JobRetirementRefusal.AttemptUnaccounted, jobId);
    const workspace = join(binding.scratchRoot, "workspaces", jobId!);
    unregisteredAttempts.push({ jobId: jobId!, workspace: directory(workspace) ? identity(workspace) : null });
  }
  for (const jobId of operations.keys()) if (!registered.has(jobId) && !unregisteredAttempts.some(row => row.jobId === jobId))
    refuseRetirement(JobRetirementRefusal.AttemptUnaccounted, jobId);
  const workspaceNames = new Set([...jobs.filter(job => job.role === JobRetirementRole.Worker).map(job => job.jobId),
    ...unregisteredAttempts.map(row => row.jobId)]);
  for (const name of readdirSync(binding.scratchRoot)) if (name !== "source" && name !== "workspaces") refuseRetirement(JobRetirementRefusal.ScratchUnknownEntry);
  const workspaces = join(binding.scratchRoot, "workspaces");
  for (const name of directory(workspaces) ? readdirSync(workspaces) : []) if (!workspaceNames.has(name)) refuseRetirement(JobRetirementRefusal.ScratchUnknownEntry);
  const source = binding.sourceWorkspacePath, repository = inspectRetirementRepository(source);
  if (repository.linked || repository.head !== binding.sourceCommit ||
      withContentRefreshedIndex(source, git => git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"])).length)
    refuseRetirement(JobRetirementRefusal.SourceMismatch);
  assertNoUnpublishedCommits(source, ["HEAD"], true);
  assertNoStash(source);
  // Every worktree registered in the source must be one of the unit's own.
  for (const [, path] of linkedWorktrees(repository.commonDir)) {
    const name = path.slice(workspaces.length + 1);
    if (dirname(path) === workspaces && workspaceNames.has(name)) continue;
    if (!existsSync(path)) continue; // Stale registration: nothing outside depends on it.
    refuseRetirement(JobRetirementRefusal.WorktreeOutsideUnit);
  }
  return { binding, bindingSha256: researchHash(mimo.bindingBytes), scratchRoot: identity(binding.scratchRoot),
    source: { ...identity(source), head: repository.head, alternates: alternatesOf(join(repository.commonDir, "objects")) }, unregisteredAttempts };
}
