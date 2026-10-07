import { createHash } from "node:crypto";
import { lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { consumedOutputRecordFromJson, ProjectOperation, type ProjectAccessScope, type ProjectAdmissionRequest } from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalJob, type CodexGoalJobManifest, type CodexGoalJobManifestInput, type CodexGoalJobSummary } from "../../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../../codex-goal-ops";
import { projectControlWorkspaceLockRoot, type ProjectControlWorkspaceLease } from "../../codex-goal-project-workspace-lock";
import type { CodexGoalProjectCreateWorktreeInput } from "./codex-goal-project-control-contracts";
import { defaultProjectControlGitPort } from "./adapters/host-command-adapters";
import { pathInsideOrEqual } from "./codex-goal-project-utils";
import { projectControlCanonicalWorkspacePath } from "./codex-goal-project-workspace-scope";
import { assertProjectPreStartAdmissionLaunchBinding } from "./codex-goal-project-pre-start-admission";
import { readBoundedFile } from "./codex-goal-project-pre-start-artifact-io";
import { parseWorkerLaunchSpec } from "./worker-launch-spec";
import { assertProjectControlledRuntimeInPlaceContinuation, type ProjectControlledRuntimeInPlaceContinuation } from "./codex-goal-project-in-place-continuation";
import { LocalConsumedOutputLedgerSource } from "./codex-goal-consumed-output-ledger-io";

// Only the broker's already-bound mutation ports supply these values. They are
// not transport request fields and cannot be replaced by a caller's exemption flag.
export type ProjectAdmissionTargetBinding = {
  readonly createWorktree?: CodexGoalProjectCreateWorktreeInput;
  readonly createManifest?: CodexGoalJobManifestInput;
  readonly start?: {
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
    readonly workspaceLease: ProjectControlWorkspaceLease;
    readonly continuation?: ProjectControlledRuntimeInPlaceContinuation;
  };
};

type TargetInput = {
  readonly registryRootDir: string;
  readonly controllerJobId?: string;
  readonly scope: ProjectAccessScope;
  readonly request?: ProjectAdmissionRequest;
  readonly binding?: ProjectAdmissionTargetBinding;
};

// Exact native containers, not a dot-directory or arbitrary-name exemption:
// broker authority, jobs' durable handoffs, consumed-ledger adapter/lock,
// project integration archive custody, native retirement receipts, and runtime state.
const registryInfrastructure = new Set([
  ".project-authority", ".project-control", "durable-handoffs", "consumed-output-ledger",
  ".consumed-output-ledger-mutation-locks", "archives", "state", ".run-events",
]);

function sameOwnedPaths(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return Boolean(left?.length && right?.length && isDeepStrictEqual([...left].sort(), [...right].sort()) &&
    left.every((path) => path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
      !path.split("/").some((segment) => segment === ".." || segment === ".")));
}

async function git(path: string, ...args: string[]): Promise<string> {
  return (await defaultProjectControlGitPort.run({ args: ["-C", path, ...args], timeoutMs: 10_000 })).stdout.trim();
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

async function prospectiveDirectoryIdentity(path: string): Promise<string> {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (await absent(ancestor)) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const status = await lstat(ancestor);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("project_control_future_parent_unsafe");
  return join(await realpath(ancestor), ...suffix);
}

async function futureCreationIdentity(input: Pick<TargetInput, "scope" | "binding" | "request">, ownershipRequired = true): Promise<string | undefined> {
  const target = input.binding?.createWorktree;
  const request = input.request;
  if (!target || !request || request.operation !== ProjectOperation.CreateWorktree ||
    request.jobId !== target.jobId || request.workspacePath !== target.path ||
    (ownershipRequired && (!target.jobId || !sameOwnedPaths(request.ownedPaths, target.ownedPaths))) || !isAbsolute(target.path) ||
    !/^[0-9a-f]{40}$/.test(target.expectedRevision) || !await absent(target.path)) return undefined;
  const identity = await prospectiveDirectoryIdentity(target.path);
  // The ancestor anchors a future identity; only the explicitly scoped root
  // grants authority. An absent worktree root never authorizes its siblings.
  let scoped = false;
  for (const root of [...(input.scope.workspaceRoots ?? []), ...(input.scope.worktreeRoots ?? []),
    ...(input.scope.isolatedWorkspaceRoot ? [input.scope.isolatedWorkspaceRoot] : [])]) {
    if (pathInsideOrEqual(identity, await prospectiveDirectoryIdentity(root))) scoped = true;
  }
  if (!scoped) return undefined;
  if (target.expectedRealPath && target.expectedRealPath !== identity) return undefined;
  const source = await projectControlCanonicalWorkspacePath(target.sourceWorkspacePath, input.scope);
  if (source !== target.expectedSourceRealPath ||
    await realpath(await git(source, "rev-parse", "--show-toplevel")) !== source ||
    await git(source, "rev-parse", `${target.expectedRevision}^{commit}`) !== target.expectedRevision) return undefined;
  if (!target.sourceRevisionPinned && !target.newBranch &&
    await git(source, "rev-parse", `${target.sourceRef ?? target.baseBranch ?? target.expectedRevision}^{commit}`) !== target.expectedRevision) return undefined;
  return identity;
}

export async function revalidateAdmissionCreatedWorktree(input: {
  readonly expectedIdentity: string; readonly target: CodexGoalProjectCreateWorktreeInput; readonly scope: ProjectAccessScope;
}): Promise<void> {
  const canonical = await projectControlCanonicalWorkspacePath(input.target.path, input.scope);
  if (canonical !== input.expectedIdentity || await git(canonical, "rev-parse", "HEAD") !== input.target.expectedRevision ||
    await realpath(await git(canonical, "rev-parse", "--show-toplevel")) !== canonical) {
    throw new Error("project_control_created_admission_target_changed");
  }
}

export async function admissionCreationTargetIdentity(input: TargetInput): Promise<string | undefined> {
  try { return await futureCreationIdentity(input); } catch { return undefined; }
}

export async function boundCreationTargetIdentity(input: {
  readonly target: CodexGoalProjectCreateWorktreeInput; readonly scope: ProjectAccessScope;
}): Promise<string | undefined> {
  try {
    return await futureCreationIdentity({ scope: input.scope,
      binding: { createWorktree: input.target }, request: { operation: ProjectOperation.CreateWorktree,
        workspacePath: input.target.path,
        ...(input.target.jobId ? { jobId: input.target.jobId } : {}),
      } }, false);
  } catch { return undefined; }
}

export function assertAdmissionLaunchIdentity(manifest: CodexGoalJobManifest, launch: CodexGoalLaunchInput): void {
  if (launch.config.jobId !== manifest.jobId || launch.config.taskId !== manifest.taskId ||
    launch.config.jobRootDir !== manifest.jobRootDir ||
    launch.config.promptPath !== manifest.promptPath) throw new Error("project_control_start_launch_identity_mismatch");
}

export async function assertAdmissionStoredLaunchIdentity(input: {
  readonly registryRootDir: string; readonly manifest: CodexGoalJobManifest; readonly launch: CodexGoalLaunchInput;
}): Promise<void> {
  const stored = await readCodexGoalJob({ registryRootDir: input.registryRootDir, jobId: input.manifest.jobId });
  if (!isDeepStrictEqual(stored, input.manifest)) throw new Error("project_control_start_manifest_changed");
  assertAdmissionLaunchIdentity(stored, input.launch);
  if (await realpath(stored.workspacePath) !== input.launch.config.workspacePath) throw new Error("project_control_start_launch_identity_mismatch");
}

async function neverLaunchedSelf(manifest: CodexGoalJobManifest, launch: CodexGoalLaunchInput, item: Readonly<Record<string, unknown>>, registryRootDir: string): Promise<boolean> {
  if (item.progressExists === true || item.progressPid !== undefined || item.progressStatus !== undefined ||
    item.lastProgressAt !== undefined || item.workerFreshProgressAlive === true ||
    (item.workerSupervisorKind !== undefined && item.workerSupervisorKind !== "none") ||
    ["attemptId", "attemptNumber", "activeAttempt", "workerPid", "supervisorPid"].some((key) => item[key] !== undefined)) return false;
  for (const path of [launch.config.outputPath, launch.config.progressPath, launch.logPath]) {
    if (path && !await absent(path)) return false;
  }
  const stateRoot = launch.config.stateRootDir ?? join(manifest.jobRootDir, "state");
  if (!await absent(stateRoot) && (await readdir(stateRoot)).length > 0) return false;
  const descriptor = manifest.projectPreStartAdmission;
  if (!descriptor) return false;
  const admissionDir = dirname(descriptor.contractPath);
  const entries = await readdir(manifest.jobRootDir, { withFileTypes: true });
  const colocated = resolve(manifest.jobRootDir) === join(resolve(registryRootDir), manifest.jobId);
  if (!entries.every((entry) => !entry.isSymbolicLink() &&
    ((entry.isFile() && (entry.name === basename(manifest.promptPath) || (colocated && entry.name === "job.json"))) ||
      (entry.isDirectory() && entry.name === basename(admissionDir))))) return false;
  const allowed = new Set([descriptor.contractPath, descriptor.statePath, descriptor.receiptPath].map((path) => basename(path)));
  return (await readdir(admissionDir, { withFileTypes: true })).every((entry) =>
    entry.isFile() && !entry.isSymbolicLink() && allowed.has(entry.name));
}

export async function admissionStartSelfIdentity(input: TargetInput & {
  readonly summaries: readonly CodexGoalJobSummary[];
  readonly overviewItems: readonly Readonly<Record<string, unknown>>[];
}): Promise<{ readonly jobId: string; readonly workspacePath: string } | undefined> {
  try {
    const start = input.binding?.start;
    const request = input.request;
    if (!start || !request || request.operation !== ProjectOperation.StartWorker ||
      request.jobId !== start.manifest.jobId || !request.workspacePath || !input.controllerJobId) return undefined;
    const workspace = await projectControlCanonicalWorkspacePath(request.workspacePath, input.scope);
    const lease = start.workspaceLease;
    if (workspace !== lease.canonicalWorkspacePath || workspace !== lease.lease.workspacePath ||
      await realpath(start.manifest.workspacePath) !== workspace || start.launch.config.workspacePath !== workspace ||
      start.launch.config.taskId !== start.manifest.taskId ||
      ![`project-start:${input.controllerJobId}:${request.jobId}`, `project-refill-start:${input.controllerJobId}:${request.jobId}`].includes(lease.lease.owner)) return undefined;
    const key = createHash("sha256").update(workspace).digest("hex");
    const lockPath = join(projectControlWorkspaceLockRoot(input.registryRootDir), "workspace-locks", key, "lock.json");
    const lockStat = await lstat(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size > 64 * 1024) return undefined;
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (lock.taskId !== lease.lease.lockId || lock.ownerId !== lease.lease.owner ||
      lock.workspacePath !== workspace || lock.ownerPid !== process.pid) return undefined;
    const stored = await readCodexGoalJob({ registryRootDir: input.registryRootDir, jobId: request.jobId });
    if (!isDeepStrictEqual(stored, start.manifest) || !stored.projectPreStartAdmission) return undefined;
    assertAdmissionLaunchIdentity(stored, start.launch);
    const summaries = input.summaries.filter((summary) => summary.jobId === request.jobId);
    const items = input.overviewItems.filter((item) => item.jobId === request.jobId);
    if (summaries.length !== 1 || items.length !== 1 ||
      await realpath(summaries[0]!.workspacePath) !== workspace ||
      resolve(summaries[0]!.manifestPath) !== join(resolve(input.registryRootDir), request.jobId, "job.json")) return undefined;
    const item = items[0]!;
    if (item.ok !== true || item.workerAlive !== false || item.workspaceConflict === true ||
      item.workerProcessAlive === true || item.progressProcessAlive === true) return undefined;
    if (start.continuation) {
      if (item.workerProcessAlive !== false || item.progressProcessAlive !== false ||
        item.workspaceDirty !== true || item.resultExists !== true ||
        !["none", "dirty_workspace_without_worker"].includes(String(item.activeWriterRisk)) ||
        !sameOwnedPaths(request.ownedPaths, start.continuation.ownedPaths)) return undefined;
      await assertProjectControlledRuntimeInPlaceContinuation({ manifest: stored,
        scope: input.scope, workspacePath: workspace, expected: start.continuation });
    } else {
      if (item.workspaceDirty !== false || item.resultExists !== false || item.activeWriterRisk !== "none") return undefined;
      // Dead native PIDs also map to false/false; only artifact-free prepared
      // state proves a fresh start without an authorized continuation.
      if (!await neverLaunchedSelf(stored, start.launch, item, input.registryRootDir)) return undefined;
    }
    const descriptor = stored.projectPreStartAdmission;
    const contractBefore = await readBoundedFile(descriptor.contractPath, 256 * 1024, "contract");
    await assertProjectPreStartAdmissionLaunchBinding({ manifest: stored, scope: input.scope,
      ...(start.continuation ? { workspaceMode: "admitted_input_patch_runtime_continuation" as const } : {}),
    });
    const contractAfter = await readBoundedFile(descriptor.contractPath, 256 * 1024, "contract");
    if (contractBefore !== contractAfter || !sameOwnedPaths(request.ownedPaths, parseWorkerLaunchSpec(JSON.parse(contractBefore)).ownedPaths)) return undefined;
    return { jobId: stored.jobId, workspacePath: workspace };
  } catch { return undefined; }
}

async function trustedUnpublishedStage(input: TargetInput, jobId: string): Promise<boolean> {
  const manifest = input.binding?.createManifest;
  const request = input.request;
  if (!manifest || !request || request.operation !== ProjectOperation.CreateJob || request.jobId !== jobId ||
    manifest.jobId !== jobId || resolve(manifest.jobRootDir) !== join(resolve(input.registryRootDir), jobId) ||
    request.workspacePath !== manifest.workspacePath || !manifest.projectPreStartAdmission || !request.ownedPaths?.length) return false;
  // Prepared target staging has only its bound prompt and pre-start artifacts.
  // Existing runtime/progress/output paths or arbitrary directories are not staging.
  const entries = await readdir(manifest.jobRootDir, { withFileTypes: true });
  const descriptor = manifest.projectPreStartAdmission;
  const admissionDir = dirname(descriptor.contractPath);
  if (dirname(admissionDir) !== resolve(manifest.jobRootDir) ||
    dirname(resolve(manifest.promptPath)) !== resolve(manifest.jobRootDir)) return false;
  if (!entries.every((entry) => !entry.isSymbolicLink() &&
    ((entry.isFile() && entry.name === basename(manifest.promptPath)) ||
      (entry.isDirectory() && entry.name === basename(admissionDir))))) return false;
  const contract = parseWorkerLaunchSpec(JSON.parse(await readBoundedFile(descriptor.contractPath, 256 * 1024, "contract")));
  if (contract.jobId !== manifest.jobId || contract.workspaceRoot !== manifest.workspacePath ||
    !sameOwnedPaths(request.ownedPaths, contract.ownedPaths)) return false;
  await projectControlCanonicalWorkspacePath(manifest.workspacePath, input.scope);
  // The same native prepared receipt that start verifies must already bind the
  // unpublished manifest, prompt, exact workspace HEAD and ownership contract.
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest, scope: input.scope,
  });
  return true;
}

async function consumedOutputInfrastructure(input: TargetInput, path: string): Promise<boolean> {
  const ledgers = (input.scope.consumedOutputLedgerRoots ?? []).map((root) => resolve(root))
    .filter((root) => root === path || (basename(path) === "consumed-output" && pathInsideOrEqual(root, path)));
  const evidenceRoots = input.scope.consumedOutputEvidenceRoots ?? [];
  if (ledgers.length === 0 || evidenceRoots.length === 0) return false;
  const archives = join(path, "archives");
  const configured = [...ledgers, ...evidenceRoots.map((root) => resolve(root))
    .filter((root) => root !== path && pathInsideOrEqual(root, path))];
  if (await realpath(path) !== path || (input.scope.deniedRoots ?? []).some((denied) =>
    [path, ...configured].some((root) => pathInsideOrEqual(resolve(denied), root) || pathInsideOrEqual(root, resolve(denied))))) return false;
  for (const root of configured) {
    const status = await lstat(root).catch((error: unknown) => {
      // Preserve the original lazy native archives case, never a missing ledger.
      if (root === archives && !ledgers.includes(root) && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (status && (!status.isDirectory() || status.isSymbolicLink() || await realpath(root) !== root)) return false;
  }
  for (const ledger of ledgers) {
    const items = join(ledger, "items"), status = await lstat(items);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(items) !== items) return false;
  }
  // Only true parent branches need a configured-child census. Data interiors
  // still receive the full bounded hidden-manifest/type/alias scan below.
  const nativeParents = new Set<string>();
  if (!ledgers.includes(path)) nativeParents.add(path);
  for (const root of configured.filter((root) => root !== path)) {
    for (let parent = dirname(root); parent !== path; parent = dirname(parent)) {
      if (configured.some((dataRoot) => pathInsideOrEqual(parent, dataRoot))) break;
      nativeParents.add(parent);
    }
  }
  // Ledger validation owns records; it does not discover nested job manifests.
  // Inspect names, refusing aliases/cycles; only the exact native item uses its reader.
  const pending = [path];
  const visited = new Set<string>();
  let inspected = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("consumed-output directory unsafe");
    const identity = `${before.dev}:${before.ino}`;
    if (visited.has(identity)) throw new Error("consumed-output directory alias");
    visited.add(identity);
    const nativeChildren = new Set(configured.filter((root) => root !== directory && pathInsideOrEqual(root, directory))
      .map((root) => root.slice(directory.length + 1).split("/")[0]!));
    if (ledgers.some((ledger) => dirname(ledger) === directory)) nativeChildren.add(".consumed-output-ledger-mutation-locks");
    for await (const entry of await opendir(directory)) {
      if (++inspected > 100_000) throw new Error("consumed-output inspection bound exceeded");
      if (nativeParents.has(directory) && (!nativeChildren.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())) {
        throw new Error(`unregistered consumed-output entry: ${entry.name}`);
      }
      if (entry.isSymbolicLink()) throw new Error("consumed-output entry symlink");
      if (entry.name === "job.json") {
        const ledger = ledgers.find((root) => directory === join(root, "items"));
        if (!ledger || !entry.isFile()) throw new Error("unregistered job inside consumed-output");
        const ledgerPath = join(directory, entry.name);
        const source = new LocalConsumedOutputLedgerSource(input.scope.consumedOutputEvidenceRoots ?? []);
        const loaded = await source.readEntries({ roots: [ledger] });
        const nativeEntry = loaded.entries.find((item) => item.ledgerPath === ledgerPath);
        const record = nativeEntry && await consumedOutputRecordFromJson({ ...nativeEntry, source });
        if (!record || record.jobId !== "job") throw new Error("invalid native job ledger record");
      }
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("consumed-output directory changed");
    }
  }
  return true;
}

export async function assertAdmissionRegistryComplete(input: TargetInput & {
  readonly summaries: readonly CodexGoalJobSummary[];
}): Promise<void> {
  let entries;
  try { entries = await readdir(input.registryRootDir, { withFileTypes: true }); }
  catch (error) {
    // Native listing yields no rows for an absent registry. Injected collection
    // ports can project fixtures from another store; there are no local entries
    // to silently omit in either case.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`registry entry symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const manifestPath = join(input.registryRootDir, entry.name, "job.json");
    if (await absent(manifestPath)) {
      if (registryInfrastructure.has(entry.name) ||
        await consumedOutputInfrastructure(input, join(resolve(input.registryRootDir), entry.name)) ||
        await trustedUnpublishedStage(input, entry.name)) continue;
      throw new Error(`unregistered registry directory: ${entry.name}`);
    }
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error(`registry manifest not regular: ${entry.name}`);
    const manifest = await readCodexGoalJob({ registryRootDir: input.registryRootDir, jobId: entry.name });
    const summaries = input.summaries.filter((summary) => summary.jobId === entry.name);
    if (manifest.jobId !== entry.name || summaries.length !== 1 ||
      resolve(summaries[0]!.manifestPath) !== resolve(manifestPath) ||
      summaries[0]!.workspacePath !== manifest.workspacePath) throw new Error(`registry listing incomplete: ${entry.name}`);
  }
}
