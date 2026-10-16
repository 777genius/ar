import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { assertResearchInitialRoot, assertResearchSharedHost } from "./research-launch-host";
import { researchCustody, researchHash, researchPath, researchPublish, researchRecord } from "./research-launch-files";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { assertHeldMimoPreparationFenceCurrent, assertHostedMimoProjectRouteOpen, captureHeldMimoPreparationFence, hostedMimoBridgeMetadataBytes,
  hostedMimoBridgeMetadataMaxBytes, parseHostedMimoProjectBinding, type HeldMimoPreparationFence, type HostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { observeHostedMimoProjectOperation, readPrivateHostedMimoOperationBytes } from "./hosted-mimo-project-bridge-operation";
import { assertPreparationGitMetadata, hostedMimoSealedSourcePort, preparationSafeGit } from "./hosted-mimo-project-source";
import { assertPreparationSandbox } from "./hosted-mimo-project-bridge-prepare";
import { workerLaunchAdmissionSchema } from "./application/project-control/worker-launch-spec";
import { loadProjectControlController } from "./codex-goal-mcp-project-control-deps";

const planDirectory = "/etc/subscription-runtime/mimo-advance";
// A loose temporary ref: running workers see packed-refs through a file bind, so no packing and no packed-ref deletion.
const incomingRef = "refs/mimo-advance/incoming";
const gitTimeoutMs = 300_000, fenceTimeoutMs = 60_000, fenceRetryMs = 2_000, receiptMaxBytes = 1048576;
const sha1 = /^[a-f0-9]{40}$/, sha256 = /^[a-f0-9]{64}$/, identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const acquireRefusals = ["controller_maintenance_fence_active", "controller_maintenance_activity_active"];
const refuse = (code: string): never => { throw new Error("mimo_project_bridge_advance_" + code); };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export enum MimoAdvanceStep { Fenced = "fenced", Fetched = "fetched", RefMoved = "ref-moved", CheckedOut = "checked-out", BindingReplaced = "binding-replaced" }
/** Timing and the step observer are a test seam; the CLI passes only `dryRun`. */
export type MimoAdvanceOptions = Readonly<{
  dryRun?: boolean; fenceTimeoutMs?: number; fenceRetryMs?: number; afterStep?: (step: MimoAdvanceStep) => void;
}>;

/** Reviewed operator data only; never reachable through the remote wire DTO. */
export function parseHostedMimoAdvancePlan(value: unknown) {
  const hasAdmission = !!value && typeof value === "object" && Object.hasOwn(value, "admission");
  const row = researchRecord(value, "schemaVersion,projectId,workstreamId,machineId,expectedBindingSha256,expectedSourceCommit,newSourceCommit,sourceSnapshotPath,acknowledgedJobIds" +
    (hasAdmission ? ",admission" : ""));
  const acknowledged = row.acknowledgedJobIds;
  if (row.schemaVersion !== 1 || typeof row.projectId !== "string" || typeof row.workstreamId !== "string" ||
      typeof row.machineId !== "string" || !/^[a-f0-9]{32}$/.test(row.machineId) ||
      typeof row.expectedBindingSha256 !== "string" || !sha256.test(row.expectedBindingSha256) ||
      typeof row.expectedSourceCommit !== "string" || !sha1.test(row.expectedSourceCommit) ||
      typeof row.newSourceCommit !== "string" || !sha1.test(row.newSourceCommit) ||
      !Array.isArray(acknowledged) || acknowledged.length > 256 || new Set(acknowledged).size !== acknowledged.length ||
      acknowledged.some(id => typeof id !== "string" || !identifier.test(id))) refuse("plan_invalid");
  return { projectId: row.projectId as string, workstreamId: row.workstreamId as string, machineId: row.machineId as string,
    expectedBindingSha256: row.expectedBindingSha256 as string, expectedSourceCommit: row.expectedSourceCommit as string,
    newSourceCommit: row.newSourceCommit as string, sourceSnapshotPath: researchPath(row.sourceSnapshotPath),
    acknowledgedJobIds: [...acknowledged as string[]].sort(), admission: hasAdmission ? row.admission : undefined };
}
type AdvancePlan = ReturnType<typeof parseHostedMimoAdvancePlan>;
const commitFields = ["canonicalSha", "baseSha", "phaseStartSha"] as const;

/** Idempotent in the current binding, so a replay after the binding step derives the same result. */
function resultingBinding(current: HostedMimoProjectBinding, plan: AdvancePlan, request: MimoProjectBridgeRequest) {
  let admission: unknown = plan.admission;
  if (plan.admission === undefined) {
    const raw = current.admission as { contract: Record<string, unknown> };
    const checks = workerLaunchAdmissionSchema.parse(current.admission).contract.requiredChecks;
    // Hand-pinned checks cannot be rewritten safely; the plan must then carry a reviewed template.
    if (checks.some(check => check.command.includes(plan.expectedSourceCommit) || /[a-f0-9]{64}/.test(check.command))) refuse("admission_pinned");
    const contract = { ...raw.contract };
    for (const field of commitFields) if (Object.hasOwn(contract, field)) contract[field] = plan.newSourceCommit;
    admission = { ...raw, contract };
  }
  const parsed = workerLaunchAdmissionSchema.parse(admission);
  if (commitFields.some(field => parsed.contract[field] !== undefined && parsed.contract[field] !== plan.newSourceCommit)) refuse("admission_source_mismatch");
  const value = parseHostedMimoProjectBinding({ ...current, sourceCommit: plan.newSourceCommit, admission }, request);
  const bytes = JSON.stringify(value) + "\n";
  // Every binding reader stops at this size, so a larger one would strand the workstream.
  if (Buffer.byteLength(bytes) > hostedMimoBridgeMetadataMaxBytes) refuse("binding_too_large");
  return { value, bytes };
}
/** `researchPublish` needs a root-private directory; find that out before any effect, not at the binding step. */
function assertBindingDirectory(bindingPath: string): void {
  try { researchCustody(dirname(bindingPath), true); } catch { refuse("binding_directory_invalid"); }
}
/** One retained record per advance; its size is known before the first effect, so it can never fail afterwards. */
function advanceReceipt(plan: AdvancePlan, planBytes: Buffer, newBindingSha256: string, observed: ReturnType<typeof observeBinding>) {
  const value = { schemaVersion: 1, planSha256: researchHash(planBytes), oldCommit: plan.expectedSourceCommit, newCommit: plan.newSourceCommit,
    oldBindingSha256: plan.expectedBindingSha256, newBindingSha256, launchedJobIds: observed.launchedJobIds, acknowledgedJobIds: plan.acknowledgedJobIds,
    staleJobIds: observed.staleJobIds, runtimeRelease: realpathSync(fileURLToPath(new URL("../../", import.meta.url))) };
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > receiptMaxBytes) refuse("receipt_too_large");
  return value;
}
const normalized = (binding: HostedMimoProjectBinding) => ({ ...binding, admission: workerLaunchAdmissionSchema.parse(binding.admission) });

/** Route open, or closed only by `.route-disabled` markers: the safest moment for an advance. */
function assertAdvanceRoute(binding: HostedMimoProjectBinding, heldFence?: HeldMimoPreparationFence): void {
  if (heldFence) assertHeldMimoPreparationFenceCurrent(binding, heldFence);
  if (existsSync(join(binding.stateRoot, ".controller-recovery.json"))) refuse("recovery_pending");
  if (!binding.routingEnabled) throw new Error("mimo_project_bridge_route_closed");
  const markers = [`/etc/subscription-runtime/projects/${binding.projectId}.route-disabled`,
    `/etc/subscription-runtime/projects/${binding.projectId}.d/${binding.workstreamId}.route-disabled`];
  if (markers.some(existsSync)) return;
  // Before the fence is held, a present fence is either live (acquisition waits) or dead (acquisition recovers it).
  if (heldFence || !existsSync(join(binding.stateRoot, ".controller-maintenance-fence.json"))) assertHostedMimoProjectRouteOpen(binding, heldFence);
}
async function assertControllerScope(binding: HostedMimoProjectBinding): Promise<void> {
  const { scope } = await loadProjectControlController({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId });
  if (scope.projectId !== binding.projectId || !isDeepStrictEqual(scope.allowedAccountIds, ["account-q"])) throw new Error("mimo_project_bridge_scope_denied");
}
const isAncestor = (git: (args: string[]) => string, ancestor: string, descendant: string): boolean => {
  try { git(["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
};
/** Same hygiene as preparation, plus identity, ancestry and the new admission's files at the new commit. */
function assertSnapshot(binding: HostedMimoProjectBinding, plan: AdvancePlan, next: HostedMimoProjectBinding): void {
  const snapshot = plan.sourceSnapshotPath;
  for (const root of [binding.scratchRoot, binding.stateRoot]) if (snapshot === root || snapshot.startsWith(root + "/")) refuse("snapshot_invalid");
  researchCustody(snapshot); researchCustody(binding.sourceWorkspacePath);
  assertPreparationGitMetadata(snapshot); assertPreparationGitMetadata(binding.sourceWorkspacePath);
  const git = (args: string[]) => preparationSafeGit(["-C", snapshot, ...args]);
  const sourceRef = "refs/remotes/" + binding.sourceRef;
  if (git(["ls-files", "--stage"]).split("\n").some(line => line.startsWith("160000 "))) throw new Error("mimo_project_bridge_snapshot_linked_git");
  if (git(["remote", "get-url", "origin"]) !== preparationSafeGit(["-C", binding.sourceWorkspacePath, "remote", "get-url", "origin"])) refuse("repository_mismatch");
  if (git(["rev-parse", "HEAD"]) !== plan.newSourceCommit || git(["status", "--porcelain"]) !== "") refuse("snapshot_invalid");
  if (!isAncestor(git, plan.expectedSourceCommit, plan.newSourceCommit)) refuse("not_forward");
  if (!isAncestor(git, plan.newSourceCommit, sourceRef)) refuse("not_on_branch");
  const contract = workerLaunchAdmissionSchema.parse(next.admission).contract;
  for (const path of [contract.controllerPacket, contract.lanePacket, ...contract.mandatoryDocs, ...contract.mandatoryScripts, ...contract.mandatoryFixtures]) {
    hostedMimoBridgeMetadataBytes(join(snapshot, path), 1048576);
    if (git(["ls-files", "--error-unmatch", "--", path]) !== path) throw new Error("mimo_project_bridge_packet_untracked");
  }
  for (const check of contract.requiredChecks) if (normalize(check.cwd) !== ".") assertPreparationSandbox(snapshot, normalize(check.cwd));
  assertPreparationSandbox(snapshot, relative(binding.sourceWorkspacePath, contract.executionPolicy.sandboxRoot));
}

type OperationObservation = { state: string; result?: { ok?: boolean; result?: { ok?: boolean } } };
type Blocker = Readonly<{ jobId: string; reason: "operation_running" | "create_unresolved" | "start_not_launched" | "repair_unresolved" }>;
/** Binding-dependent state, patterned on `assertHostedMimoRecoveryOperationsSettled`. Status and Stop never read the binding commit,
 * but a unit of either kind that is still running holds no activity lease yet and must not meet the fence. A job whose Create was
 * made at another commit than the current binding was already stranded by an earlier advance, so it is stale rather than a blocker. */
function observeBinding(binding: HostedMimoProjectBinding, acknowledged: readonly string[]) {
  const root = join(binding.stateRoot, "mimo-bridge-operations"), jobIds = new Set<string>();
  if (existsSync(root)) {
    researchCustody(root, true);
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".owner.json")) continue;
      const stem = name.slice(0, -".owner.json".length), dot = stem.lastIndexOf(".");
      if (dot < 1 || !identifier.test(stem.slice(0, dot)) || !Object.values(MimoProjectBridgeOperation).includes(stem.slice(dot + 1) as MimoProjectBridgeOperation))
        refuse("operations_unreadable");
      jobIds.add(stem.slice(0, dot));
    }
  }
  if (acknowledged.some(jobId => !jobIds.has(jobId))) refuse("acknowledgement_unknown");
  const observe = (jobId: string, operation: MimoProjectBridgeOperation) => observeHostedMimoProjectOperation({ kind: "MimoProject", schemaVersion: 1,
    machineId: binding.machineId, projectId: binding.projectId, workstreamId: binding.workstreamId, operation, jobId }) as OperationObservation;
  const createdCommit = (jobId: string): string | undefined => {
    const path = join(root, `${jobId}.${MimoProjectBridgeOperation.Create}.request.json`);
    if (!existsSync(path)) return undefined;
    try { return parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(path).toString())).sourceCommit; } catch { return refuse("operations_unreadable"); }
  };
  const blockers: Blocker[] = [], launchedJobIds: string[] = [], exempt = new Set<string>(), stale = new Set<string>();
  for (const jobId of [...jobIds].sort()) {
    const observed = Object.values(MimoProjectBridgeOperation).map(operation => [operation, observe(jobId, operation)] as const);
    if (observed.some(([, row]) => row.state === "running")) { blockers.push({ jobId, reason: "operation_running" }); continue; }
    const row = (operation: MimoProjectBridgeOperation) => observed.find(([name]) => name === operation)![1];
    const create = row(MimoProjectBridgeOperation.Create), start = row(MimoProjectBridgeOperation.Start),
      repair = row(MimoProjectBridgeOperation.RepairAdmission), finalize = row(MimoProjectBridgeOperation.FinalizeAdmissionRepair);
    const reasons: Blocker["reason"][] = [];
    if (create.state === "unresolved") reasons.push("create_unresolved");
    else if (create.state === "settled" && create.result?.ok === true && create.result.result?.ok === true) {
      // A created job whose Start never launched needs the binding commit for any rearm.
      if (start.state === "settled" && start.result?.ok === true && start.result.result?.ok !== false) launchedJobIds.push(jobId);
      else reasons.push("start_not_launched");
    }
    if (repair.state === "unresolved" || finalize.state === "unresolved") reasons.push("repair_unresolved");
    const commit = reasons.length ? createdCommit(jobId) : undefined;
    if (commit !== undefined && commit !== binding.sourceCommit) { stale.add(jobId); continue; }
    for (const reason of reasons) { if (acknowledged.includes(jobId)) exempt.add(jobId); else blockers.push({ jobId, reason }); }
  }
  return { blockers, launchedJobIds, acknowledgedJobIds: [...exempt].sort(), staleJobIds: [...stale].sort() };
}

/** The operations are observed again under the fence: a unit that started in between meets the held fence, and only a Create
 * that was persisted just before it is visible here. A unit that is still running releases the fence again and the wait goes on. */
async function acquireFence(binding: HostedMimoProjectBinding, plan: AdvancePlan, owner: string, wait: boolean, options: MimoAdvanceOptions) {
  const deadline = Date.now() + (options.fenceTimeoutMs ?? fenceTimeoutMs);
  for (;;) {
    // A failed attempt briefly publishes the fence file and can fail a Create that checks the route right then,
    // so attempt it only when no unit is running, and pace the attempts.
    const before = wait ? observeBinding(binding, plan.acknowledgedJobIds).blockers : [];
    if (before.some(blocker => blocker.reason !== "operation_running")) refuse("blocked");
    if (!before.length) {
      let fence: Awaited<ReturnType<typeof acquireLocalControllerMaintenanceFence>> | undefined;
      try { fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: binding.stateRoot, owner }); }
      catch (error) { if (!acquireRefusals.includes((error as Error).message)) throw error; }
      if (fence) {
        let observed: ReturnType<typeof observeBinding>;
        try { observed = observeBinding(binding, plan.acknowledgedJobIds); } catch (error) { await releaseLocalControllerMaintenanceFence(fence); throw error; }
        if (!wait || !observed.blockers.some(blocker => blocker.reason === "operation_running")) return { fence, observed };
        await releaseLocalControllerMaintenanceFence(fence);
      }
    }
    if (Date.now() >= deadline) refuse("busy");
    await sleep(options.fenceRetryMs ?? fenceRetryMs);
  }
}
/** The bridge fence does not own independent Git locks. Their producer may
 * have no checkout path in argv, so no process-name scan can authorize unlink. */
function sourceGitLocksPresent(binding: HostedMimoProjectBinding): boolean {
  const git = join(binding.sourceWorkspacePath, ".git");
  return ["index.lock", "HEAD.lock", "packed-refs.lock", join("refs/remotes", binding.sourceRef + ".lock"), incomingRef + ".lock"]
    .some(name => existsSync(join(git, name)));
}
/** True when HEAD or the remote-tracking ref has left the old commit; an unreadable position counts as moved so the fence stays. */
function sourceMoved(binding: HostedMimoProjectBinding, plan: AdvancePlan): boolean {
  try {
    const git = (args: string[]) => preparationSafeGit(["-C", binding.sourceWorkspacePath, ...args]);
    return git(["rev-parse", "HEAD"]) !== plan.expectedSourceCommit || git(["rev-parse", "--verify", "refs/remotes/" + binding.sourceRef + "^{commit}"]) !== plan.expectedSourceCommit;
  } catch { return true; }
}
/** Every step is additive or compare-and-swap, so the same plan resumes from any point.
 * `effectsStarted` runs before the first step that changes the checkout, so a refusal on inspection still releases the fence. */
function moveSource(binding: HostedMimoProjectBinding, plan: AdvancePlan, options: MimoAdvanceOptions, effectsStarted: () => void): void {
  const source = binding.sourceWorkspacePath, ref = "refs/remotes/" + binding.sourceRef, { expectedSourceCommit: old, newSourceCommit: next } = plan;
  const git = (args: string[], timeoutMs?: number) => preparationSafeGit(["-C", source, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], timeoutMs);
  const position = () => {
    if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") refuse("source_dirty");
    return { head: git(["rev-parse", "HEAD"]), tip: git(["rev-parse", "--verify", ref + "^{commit}"]) };
  };
  assertPreparationGitMetadata(source);
  let { head, tip } = position();
  if (!(head === old && tip === old || head === old && tip === next || head === next && tip === next)) refuse("source_diverged");
  if (tip === old) {
    effectsStarted();
    // By ref name, not SHA: the snapshot config bans uploadpack settings. One pack per advance keeps the entry bound away.
    git(["-c", "transfer.fsckObjects=true", "-c", "fetch.unpackLimit=1", "fetch", "--no-tags", "--", plan.sourceSnapshotPath, `+${ref}:${incomingRef}`], gitTimeoutMs);
    if (!isAncestor(git, old, next) || !isAncestor(git, next, incomingRef)) refuse("fetch_unexpected");
    options.afterStep?.(MimoAdvanceStep.Fetched);
    git(["update-ref", "-m", "mimo-advance", ref, next, old]);
    tip = next; options.afterStep?.(MimoAdvanceStep.RefMoved);
  }
  if (head === old) {
    effectsStarted();
    git(["checkout", "--detach", next], gitTimeoutMs);
    head = next; options.afterStep?.(MimoAdvanceStep.CheckedOut);
  }
  ({ head, tip } = position());
  if (head !== next || tip !== next) refuse("source_diverged");
}

/** Root operator CLI: move one existing binding forward on the same repository and branch, in place. */
export async function advanceHostedMimoProjectSource(planPath: string, options: MimoAdvanceOptions = {}): Promise<unknown> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  if (dirname(planPath) !== planDirectory) refuse("plan_invalid");
  researchCustody(planDirectory, true);
  const planBytes = readPrivateHostedMimoOperationBytes(planPath, 131072), plan = parseHostedMimoAdvancePlan(JSON.parse(planBytes.toString()));
  const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1, machineId: plan.machineId, projectId: plan.projectId,
    workstreamId: plan.workstreamId, operation: MimoProjectBridgeOperation.Status, jobId: "source-advance" });
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== plan.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${plan.projectId}/${plan.workstreamId}.json`;
  const bindingBytes = hostedMimoBridgeMetadataBytes(bindingPath), binding = parseHostedMimoProjectBinding(JSON.parse(bindingBytes.toString()), request);
  const next = resultingBinding(binding, plan, request), oldBindingSha256 = researchHash(bindingBytes), newBindingSha256 = researchHash(next.bytes);
  let state: "pending" | "complete";
  if (isDeepStrictEqual(normalized(binding), normalized(next.value))) {
    // Replay after the binding step, or an equal commit: the old digest only applies when nothing moved.
    if (binding.sourceCommit === plan.expectedSourceCommit && oldBindingSha256 !== plan.expectedBindingSha256) refuse("binding_mismatch");
    state = "complete";
  } else {
    if (oldBindingSha256 !== plan.expectedBindingSha256 || binding.sourceCommit !== plan.expectedSourceCommit) refuse("binding_mismatch");
    if (plan.expectedSourceCommit === plan.newSourceCommit) refuse("not_forward");
    state = "pending";
  }
  if (state === "pending") assertBindingDirectory(bindingPath);
  assertAdvanceRoute(binding);
  await assertControllerScope(binding);
  assertSnapshot(binding, plan, next.value);
  const fencePath = join(binding.stateRoot, ".controller-maintenance-fence.json");
  const receiptPath = join(binding.stateRoot, "source-advances", `${plan.expectedSourceCommit}..${plan.newSourceCommit}.json`);
  const receiptCurrent = (): boolean => {
    if (!existsSync(receiptPath)) return false;
    const receipt = JSON.parse(readPrivateHostedMimoOperationBytes(receiptPath, receiptMaxBytes).toString()) as Record<string, unknown>;
    if (receipt.planSha256 !== researchHash(planBytes) || receipt.oldCommit !== plan.expectedSourceCommit ||
        receipt.newCommit !== plan.newSourceCommit || receipt.newBindingSha256 !== newBindingSha256) refuse("receipt_mismatch");
    return true;
  };
  const assertCurrentSource = async (): Promise<void> => {
    const sandbox = relative(binding.sourceWorkspacePath, workerLaunchAdmissionSchema.parse(next.value.admission).contract.executionPolicy.sandboxRoot);
    await hostedMimoSealedSourcePort(next.value).resolveRevision({ sourceWorkspacePath: next.value.sourceWorkspacePath,
      sourceRef: next.value.sourceRef, expectedSourceCommit: next.value.sourceCommit });
    assertPreparationGitMetadata(binding.sourceWorkspacePath); assertPreparationSandbox(binding.sourceWorkspacePath, sandbox);
  };
  // A matching receipt is historical evidence, not proof that the checkout is still current.
  if (state === "complete") await assertCurrentSource();
  if (options.dryRun) {
    const observed = state === "pending" ? observeBinding(binding, plan.acknowledgedJobIds) : { blockers: [], launchedJobIds: [], acknowledgedJobIds: [], staleJobIds: [] };
    if (state === "pending") advanceReceipt(plan, planBytes, newBindingSha256, observed);
    return { ok: true, dryRun: true, projectId: binding.projectId, workstreamId: binding.workstreamId, state, oldCommit: plan.expectedSourceCommit,
      newCommit: plan.newSourceCommit, oldBindingSha256, newBindingSha256, fence: existsSync(fencePath) ? "present" : "absent",
      blockers: observed.blockers, acknowledgedJobIds: observed.acknowledgedJobIds, staleJobIds: observed.staleJobIds };
  }
  const result = { ok: true, projectId: binding.projectId, workstreamId: binding.workstreamId, oldCommit: plan.expectedSourceCommit,
    newCommit: plan.newSourceCommit, oldBindingSha256, newBindingSha256, receiptPath };
  // A dead fence from a crashed advance must still be recovered and released by the replay.
  if (state === "complete" && !existsSync(fencePath) && receiptCurrent()) return { ...result, alreadyAdvanced: true };
  const { fence, observed } = await acquireFence(binding, plan, "mimo-advance:" + researchHash(planBytes), state === "pending", options);
  // From the first source effect on, any failure leaves the fence exactly as a crash would: the replay of the same plan finishes the job.
  let effectsStarted = false, finished = false, sourceLocksUnresolved = false;
  try {
    const held = captureHeldMimoPreparationFence(binding, fence);
    // A replay finds the source already moved by an earlier run: any failure then must keep the fence, as the first run did.
    if (state === "pending" && sourceMoved(binding, plan)) effectsStarted = true;
    options.afterStep?.(MimoAdvanceStep.Fenced);
    if (!hostedMimoBridgeMetadataBytes(bindingPath).equals(bindingBytes)) refuse("binding_mismatch");
    assertAdvanceRoute(binding, held);
    if (state === "pending" && observed.blockers.length) refuse("blocked");
    const receipt = advanceReceipt(plan, planBytes, newBindingSha256, observed);
    if (state === "pending") {
      if (sourceGitLocksPresent(binding)) { sourceLocksUnresolved = true; refuse("source_locked"); }
      moveSource(binding, plan, options, () => { effectsStarted = true; });
    }
    await assertCurrentSource();
    if (state === "pending") {
      assertHeldMimoPreparationFenceCurrent(binding, held);
      if (!hostedMimoBridgeMetadataBytes(bindingPath).equals(bindingBytes)) refuse("binding_mismatch");
      researchPublish(bindingPath, next.value);
      const written = hostedMimoBridgeMetadataBytes(bindingPath);
      if (researchHash(written) !== newBindingSha256) refuse("binding_publish_uncertain");
      parseHostedMimoProjectBinding(JSON.parse(written.toString()), request);
      options.afterStep?.(MimoAdvanceStep.BindingReplaced);
    }
    const git = (args: string[]) => preparationSafeGit(["-C", binding.sourceWorkspacePath, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args]);
    if (git(["for-each-ref", "--format=%(refname)", incomingRef]) !== "") git(["update-ref", "-d", incomingRef]);
    if (!receiptCurrent()) {
      researchCustody(binding.stateRoot);
      const directory = dirname(receiptPath);
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      researchCustody(directory, true);
      researchPublish(receiptPath, receipt, true);
    }
    finished = true;
    return result;
  } finally { if (finished || !effectsStarted && !sourceLocksUnresolved) await releaseLocalControllerMaintenanceFence(fence); }
}
