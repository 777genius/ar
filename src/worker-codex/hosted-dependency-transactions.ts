import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyReceiptState as State, DependencyTreeObservationStatus as Observed,
  assertDependencyMaintenance, claimDependencyMaintenance, releaseDependencyMaintenance, parseDependencyOwner, isDependencyConsumerOwner,
  parseDependencyReceipt, parseHostedOrdinaryStart, DependencyReceiptParseStatus, sameDependencyMaintenanceAttempt, sameDependencyTree, sameDependencyAttempt,
  type DependencyMaintenanceAttempt, type DependencyReceipt, type DependencyTrashIntent, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyManifestBlobStore } from "../store-local-file/dependency-environment/local-dependency-manifest-blob-store";
import { hostedDependencyOwnerRoot, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { openDependencyTreeRename, openCommittedDependencyTrashRemoval, DependencyTreeEffectError, DependencyTreeEffectFailure,
  type DependencyTreeEffectInput } from "../worker-local/dependency-environment/dependency-tree-effects";
import { observeDependencyTree, observeDependencyDirectoryRoot } from "../worker-local/dependency-environment/observe-dependency-tree";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { hostedDependencyObservationLimits as limits, readHostedDependencyKeyInputs } from "./hosted-dependency-materialization";
import { ensureHostedDependencyDirectory, readHostedDependencyReceipt, publishHostedDependencyReceipt,
  readHostedDependencyCommittedAbsent } from "./hosted-dependency-receipts";
import { assertHostedDependencyReferenceVeto, DependencyReferenceEffect } from "./hosted-dependency-reference-veto";

export type HostedDependencyEvictionCandidate = { readonly jobId: string; readonly revision: number;
  readonly generation: string; readonly installKey: string };
export enum HostedDependencyTransactionOutcome { Evicted = "evicted", Skipped = "skipped", TrashRemoved = "trash_removed" }
type Ready = Extract<DependencyReceipt, { state: State.Ready }>;
type Header = { version: 1; attempt: DependencyMaintenanceAttempt; ready: Ready; trash: DependencyTrashIntent };
const root = "/var/lib/subscription-runtime-host-policy", operations = root + "/dependency-transactions", trashRoot = root + "/dependency-trash";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
const hash = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
const owns = () => LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
type Authority = ReturnType<HostedInstallationActivationStore["dependencyMaintenanceAuthority"]>;
function authority(jobId: string): Authority {
  return withHostedActivationFence(fence => new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence, jobId));
}
function enabled(): boolean {
  const bytes = readHostedPrivateBytes(root + "/dependency-retention-policy.json", 4096);
  if (!bytes) return false;
  const value = decodeHostedActivationBytes(bytes) as Record<string, unknown>;
  if (!value || Object.keys(value).sort().join(",") !== "evictionEnabled,managedReadyRequired,version" ||
      value.version !== 1 || value.managedReadyRequired !== true || typeof value.evictionEnabled !== "boolean") fail();
  return value.evictionEnabled;
}
function host(a: Authority): DependencyMaintenanceAttempt["host"] {
  return { installationId: a.installation.installationId, bootId: a.session.bootId, supervisorId: a.session.supervisorId,
    runtimeSha: a.installation.runtimeSha, inventoryDigest: a.installation.inventorySha256, grantDigest: a.binding.grantDigest };
}
function guard(jobId: string, attempt: DependencyMaintenanceAttempt, requireEnabled = false): Authority {
  return withHostedActivationFence(fence => {
    const a = new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence, jobId);
    if (!sameDependencyMaintenanceAttempt(attempt, { ...attempt, host: host(a) }) || (requireEnabled && !enabled()) ||
        readHostedPrivateBytes(`${operations}/${attempt.operationId}.close-unresolved.json`, 4096)) fail();
    const store = owns();
    try { assertDependencyMaintenance(store, a.binding.workspace, attempt); } finally { store.close(); }
    return a;
  });
}
function release(jobId: string, attempt: DependencyMaintenanceAttempt): void {
  withHostedActivationFence(fence => {
    const a = new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence, jobId);
    if (!sameDependencyMaintenanceAttempt(attempt, { ...attempt, host: host(a) })) fail();
    const store = owns();
    try { releaseDependencyMaintenance(store, a.binding.workspace, attempt); } finally { store.close(); }
  });
}

/** Exact selected old starts are fenced and drained. Other live workspaces are
 * observed for references/namespaces, never stopped or globally frozen. */
function covered(a: Authority, effect = DependencyReferenceEffect.Eviction): string[] {
  const kernel = new HostedReadonlyHostKernel(), groups = new Set(readHostedReadonlyHostInventory().units.map(row => row.controlGroup));
  for (const row of a.activation.ordinaryStarts) {
    const bytes = readHostedActivationBytes(`ordinary-starts/${row.startId}.json`);
    if (!bytes) fail();
    const start = parseHostedOrdinaryStart(decodeHostedActivationBytes(bytes));
    const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`;
    if (start.unit !== row.unit || start.controlGroup !== group || start.installationId !== a.installation.installationId ||
        start.activationGeneration !== row.generation || start.creatorId !== row.creatorId || start.originSha256 !== row.originSha256 ||
        start.bootId !== a.activation.bootId || start.supervisorId !== a.activation.supervisorId) fail();
    groups.add(group);
    if (start.workspacePath !== a.binding.workspace.canonicalPath) continue;
    if (effect === DependencyReferenceEffect.TrashRemoval && !readHostedActivationBytes(`dependency-attempt-fences/${row.startId}.json`)) continue;
    if (!readHostedActivationBytes(`dependency-attempt-fences/${row.startId}.json`)) {
      createReadonlyPrivateRecord(`${root}/dependency-attempt-fences/${row.startId}.json`,
        encode({ version: 2, startId: row.startId, reason: "maintenance" }));
    }
    kernel.fenceOrdinaryCreator(row, start.bootId, hash(bytes));
    kernel.drainOrdinaryQueue(row); kernel.confirmOrdinaryDescendants(row);
  }
  const mappings = readdirSync(hostedDependencyInstallerRoot).filter(name => /^attempt-[a-f0-9-]{36}\.json$/.test(name));
  if (mappings.length > 2048) fail();
  for (const name of mappings) {
    const bytes = readHostedPrivateBytes(hostedDependencyInstallerRoot + "/" + name, 4096);
    if (!bytes) fail();
    const value = decodeHostedActivationBytes(bytes) as { schemaVersion: number; startId: string; unit: string; attempt: DependencyAttempt };
    if (!value || Object.keys(value).sort().join(",") !== "attempt,schemaVersion,startId,unit" || value.schemaVersion !== 1 ||
        !uuid.test(value.startId) || value.unit !== `subscription-runtime-installer-${value.startId}.service`) fail();
    const parsed = parseDependencyOwner({ version: 2, workspace: a.binding.workspace, revision: 1, epoch: value.attempt?.epoch,
      owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.Fenced, attempt: value.attempt } });
    if (!isDependencyConsumerOwner(parsed.owner)) fail();
    if (name !== `attempt-${parsed.owner.attempt.attemptId}.json`) fail();
    groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${value.unit}`);
    const start = readHostedPrivateBytes(`${hostedDependencyInstallerRoot}/${value.startId}/start.json`, 65536);
    if (!start) fail();
    const retained = decodeHostedActivationBytes(start) as { schemaVersion: number; startId: string; unit: string; attempt: DependencyAttempt;
      workspace: { canonicalPath: string; dev: string; ino: string }; recipe: unknown; inputSha256: unknown; profileSha256: unknown };
    if (!retained || Object.keys(retained).sort().join(",") !== "attempt,inputSha256,profileSha256,recipe,schemaVersion,startId,unit,workspace" ||
        retained.schemaVersion !== 1 || retained.recipe !== HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1 ||
        retained.startId !== value.startId || retained.unit !== value.unit ||
        !retained.workspace || typeof retained.workspace.canonicalPath !== "string" ||
        typeof retained.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(retained.inputSha256) ||
        typeof retained.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(retained.profileSha256)) fail();
    const retainedOwner = parseDependencyOwner({ version: 2, workspace: retained.workspace, revision: 1, epoch: retained.attempt?.epoch,
      owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.Fenced, attempt: retained.attempt } });
    if (!isDependencyConsumerOwner(retainedOwner.owner) || !sameDependencyAttempt(retainedOwner.owner.attempt, parsed.owner.attempt)) fail();
    if (retained.workspace?.canonicalPath === a.binding.workspace.canonicalPath) {
      if (!sameDependencyTree(retained.workspace, a.binding.workspace)) fail();
      if (effect === DependencyReferenceEffect.Eviction || readHostedActivationBytes(`dependency-attempt-fences/${parsed.owner.attempt.launch.startId}.json`)) {
        assertHostedDependencyInstallerAttemptDrained(parsed.owner.attempt);
      }
    }
  }
  return [...groups];
}
async function baseline(binding: HostedDependencyBinding, ready: Pick<Ready, "manifestDigest">): Promise<Uint8Array> {
  const store = await LocalDependencyManifestBlobStore.open({ rootPath: root + "/dependency-manifests",
    maxManifestBytes: limits.maxManifestBytes, maxStoredBytes: 512 * 1024 * 1024, maxBlobs: 2048 });
  try { return await store.get(ready.manifestDigest); } finally { await store.close(); }
}
function input(binding: HostedDependencyBinding, header: Header, bytes: Uint8Array): DependencyTreeEffectInput {
  return { workspace: binding.workspace, trash: header.trash, manifestCanonicalBytes: bytes, manifestDigest: header.ready.manifestDigest, limits };
}
function headerPath(attempt: DependencyMaintenanceAttempt): string { return `${operations}/${attempt.operationId}.json`; }
function validateTrash(trash: DependencyTrashIntent, operationId: string): void {
  // This adapter owns a single fixed namespace. Generic receipt identifiers
  // never become path components or authority for another protected directory.
  if (!uuid.test(operationId) || trash.operationId !== operationId ||
      trash.destinationParent.canonicalPath !== trashRoot || trash.destinationName !== `dependency-${operationId}`) fail();
}
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; }
}
async function finish(jobId: string, header: Header): Promise<{ outcome: HostedDependencyTransactionOutcome; revision: number }> {
  validateTrash(header.trash, header.attempt.operationId);
  let a = guard(jobId, header.attempt), receipt = readHostedDependencyReceipt(a.binding);
  const bytes = await baseline(a.binding, header.ready), destination = header.trash.destinationParent.canonicalPath + "/" + header.trash.destinationName;
  if (!receipt) fail();
  if (receipt.state === State.Absent && receipt.operationId === header.attempt.operationId) {
    const proof = receipt.evictionCommit, evidence = readHostedPrivateBytes(`${operations}/${header.attempt.operationId}.renamed.json`, 16384);
    if (receipt.generation !== header.ready.generation || receipt.revision !== header.ready.revision + 2 ||
        receipt.installKey !== header.ready.installKey || proof.manifestDigest !== header.ready.manifestDigest ||
        !sameDependencyTree(proof.tree, header.ready.tree) || !encode(proof.trash).equals(encode(header.trash)) ||
        !evidence || hash(evidence) !== proof.commitEvidenceId) fail();
    readHostedDependencyCommittedAbsent(a.binding, receipt.revision); release(jobId, header.attempt);
    return { outcome: HostedDependencyTransactionOutcome.Evicted, revision: receipt.revision };
  }
  if (receipt.state !== State.Ready && receipt.state !== State.Evicting) fail();
  if (receipt.state === State.Ready && !encode(receipt).equals(encode(header.ready))) fail();
  if (receipt.state === State.Evicting && (receipt.operationId !== header.attempt.operationId ||
      receipt.generation !== header.ready.generation || receipt.revision !== header.ready.revision + 1 ||
      receipt.installKey !== header.ready.installKey || !sameDependencyTree(receipt.tree, header.ready.tree) ||
      !encode(receipt.trash).equals(encode(header.trash)) || receipt.manifestDigest !== header.ready.manifestDigest)) fail();
  const sourceAbsent = absent(a.binding.workspace.canonicalPath + "/node_modules"), targetAbsent = absent(destination);
  if (sourceAbsent === targetAbsent) fail();
  if (readHostedDependencyKeyInputs(a.binding).key.installKey !== header.ready.installKey) fail();
  if (!sourceAbsent) {
    a = guard(jobId, header.attempt, true);
    const observed = await observeDependencyTree({ workspacePath: a.binding.workspace.canonicalPath, treeName: "node_modules",
      expectedWorkspace: a.binding.workspace, expectedTree: header.ready.tree, limits });
    if (observed.status !== Observed.Complete || observed.digest !== header.ready.manifestDigest ||
        readHostedDependencyKeyInputs(a.binding).key.installKey !== header.ready.installKey) fail();
    const operation = await openDependencyTreeRename(input(a.binding, header, bytes));
    let closeFailures = 0;
    try {
      a = guard(jobId, header.attempt, true);
      assertHostedDependencyReferenceVeto(a.binding.workspace, destination, covered(a), DependencyReferenceEffect.Eviction,
        { session: operation.referenceSession, operationId: header.attempt.operationId });
      if (receipt.state === State.Ready) {
        a = guard(jobId, header.attempt, true);
        const evicting: DependencyReceipt = { version: 1, revision: receipt.revision + 1, generation: receipt.generation,
          workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, state: State.Evicting,
          operationId: header.attempt.operationId, installKey: receipt.installKey, tree: receipt.tree,
          manifestDigest: receipt.manifestDigest, trash: header.trash };
        publishHostedDependencyReceipt(a.binding, receipt.revision, evicting); receipt = evicting;
      }
      a = guard(jobId, header.attempt, true);
      assertHostedDependencyReferenceVeto(a.binding.workspace, destination, covered(a), DependencyReferenceEffect.Eviction,
        { session: operation.referenceSession, operationId: header.attempt.operationId });
      const moved = await operation.rename();
      if (!sameDependencyTree(moved.tree, header.ready.tree) || moved.manifestDigest !== header.ready.manifestDigest) fail();
    } finally {
      closeFailures = (await operation.close()).closeFailures;
      if (closeFailures) {
        process.stderr.write("dependency_effect_close_unresolved\n");
        createReadonlyPrivateRecord(`${operations}/${header.attempt.operationId}.close-unresolved.json`, encode({ version: 1, operationId: header.attempt.operationId }));
      }
    }
    if (closeFailures) fail();
  } else {
    if (receipt.state !== State.Evicting) fail();
    const observed = await observeDependencyDirectoryRoot({ parentPath: header.trash.destinationParent.canonicalPath,
      name: header.trash.destinationName, expectedTree: header.ready.tree, limits });
    if (observed.status !== Observed.Complete || observed.digest !== header.ready.manifestDigest) fail();
    a = guard(jobId, header.attempt);
    assertHostedDependencyReferenceVeto(a.binding.workspace, destination, covered(a), DependencyReferenceEffect.Eviction);
  }
  if (receipt.state !== State.Evicting || !absent(a.binding.workspace.canonicalPath + "/node_modules") ||
      readHostedDependencyKeyInputs(a.binding).key.installKey !== header.ready.installKey) fail();
  a = guard(jobId, header.attempt);
  const evidence = encode({ version: 1, operationId: header.attempt.operationId, workspace: a.binding.workspace,
    epoch: header.attempt.epoch, tree: header.ready.tree, trash: header.trash, manifestDigest: header.ready.manifestDigest });
  const evidencePath = `${operations}/${header.attempt.operationId}.renamed.json`, retainedEvidence = readHostedPrivateBytes(evidencePath, 16384);
  if (retainedEvidence) { if (!retainedEvidence.equals(evidence)) fail(); }
  else createReadonlyPrivateRecord(evidencePath, evidence);
  const committed: DependencyReceipt = { version: 1, revision: receipt.revision + 1, generation: receipt.generation,
    workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, state: State.Absent,
    operationId: header.attempt.operationId, installKey: receipt.installKey,
    evictionCommit: { generation: receipt.generation, workspace: receipt.workspace, coverageRevision: receipt.coverageRevision,
      installKey: receipt.installKey, tree: receipt.tree, manifestDigest: receipt.manifestDigest,
      operationId: header.attempt.operationId, trash: receipt.trash, commitEvidenceId: hash(evidence) } };
  publishHostedDependencyReceipt(a.binding, receipt.revision, committed);
  readHostedDependencyCommittedAbsent(a.binding, committed.revision);
  release(jobId, header.attempt);
  return { outcome: HostedDependencyTransactionOutcome.Evicted, revision: committed.revision };
}

export async function evictHostedDependencyCandidate(candidate: HostedDependencyEvictionCandidate) {
  const selected = withHostedActivationFence(fence => {
    const a = new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence, candidate.jobId);
    if (!enabled()) return null;
    const receipt = readHostedDependencyReceipt(a.binding);
    if (receipt?.state !== State.Ready || receipt.revision !== candidate.revision || receipt.generation !== candidate.generation ||
        receipt.installKey !== candidate.installKey) fail();
    ensureHostedDependencyDirectory(operations); ensureHostedDependencyDirectory(trashRoot);
    const parent = lstatSync(trashRoot, { bigint: true });
    if (String(parent.dev) !== a.binding.workspace.dev) fail();
    const store = owns();
    try {
      const attempt = claimDependencyMaintenance(store, a.binding.workspace, host(a), randomUUID());
      const header: Header = { version: 1, attempt, ready: receipt, trash: { operationId: attempt.operationId,
        originalTree: receipt.tree, destinationParent: { canonicalPath: trashRoot, dev: String(parent.dev), ino: String(parent.ino) },
        destinationName: "dependency-" + attempt.operationId } };
      createReadonlyPrivateRecord(headerPath(attempt), encode(header));
      return header;
    } finally { store.close(); }
  });
  if (!selected) return { outcome: HostedDependencyTransactionOutcome.Skipped };
  try { covered(guard(candidate.jobId, selected.attempt)); return await finish(candidate.jobId, selected); }
  catch (error) {
    // Before durable invalidation no tree effect can have run. Release only
    // this exact maintenance owner after coherent Ready readback; failed store
    // publication/changed authority remains held instead of guessed cleanup.
    const current = guard(candidate.jobId, selected.attempt);
    const receipt = readHostedDependencyReceipt(current.binding);
    if (receipt?.state === State.Ready && encode(receipt).equals(encode(selected.ready))) {
      release(candidate.jobId, selected.attempt);
      return { outcome: HostedDependencyTransactionOutcome.Skipped };
    }
    throw error;
  }
}
export async function recoverHostedDependencyEviction(jobId: string) {
  const a = authority(jobId), store = owns();
  let attempt: DependencyMaintenanceAttempt;
  try {
    const owner = store.read(a.binding.workspace);
    if (owner?.owner?.kind !== DependencyOwnerKind.Maintenance) fail();
    attempt = owner.owner.attempt;
  } finally { store.close(); }
  guard(jobId, attempt);
  const bytes = readHostedPrivateBytes(headerPath(attempt), 32768);
  if (!bytes) fail();
  const header = decodeHostedActivationBytes(bytes) as Header, parsed = parseDependencyReceipt(header?.ready);
  if (!header || Object.keys(header).sort().join(",") !== "attempt,ready,trash,version" || header.version !== 1 ||
      !encode(header.attempt).equals(encode(attempt)) || parsed.status !== DependencyReceiptParseStatus.Valid || parsed.receipt.state !== State.Ready) fail();
  const intent = parseDependencyReceipt({ version: 1, state: State.Evicting, revision: parsed.receipt.revision + 1,
    generation: parsed.receipt.generation, workspace: parsed.receipt.workspace, coverageRevision: parsed.receipt.coverageRevision,
    operationId: attempt.operationId, installKey: parsed.receipt.installKey, tree: parsed.receipt.tree,
    manifestDigest: parsed.receipt.manifestDigest, trash: header.trash });
  if (intent.status !== DependencyReceiptParseStatus.Valid) fail();
  return finish(jobId, header);
}
export async function removeHostedDependencyCommittedTrash(jobId: string, revision: number) {
  const a = authority(jobId);
  if (!enabled()) return { outcome: HostedDependencyTransactionOutcome.Skipped };
  const committed = readHostedDependencyCommittedAbsent(a.binding, revision), proof = committed.receipt.evictionCommit;
  validateTrash(proof.trash, proof.operationId);
  const bytes = await baseline(a.binding, proof);
  const parent = openSync(operations, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), parentIdentity = fstatSync(parent, { bigint: true });
  if (parentIdentity.uid !== 0n || (parentIdentity.mode & 0o7777n) !== 0o700n) { closeSync(parent); fail(); }
  const lockPath = `/proc/self/fd/${parent}/${proof.operationId}.remove.lock`;
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { closeSync(parent); throw error; }
  const identity = fstatSync(lock, { bigint: true });
  let releasable = false;
  try {
    writeFileSync(lock, encode({ version: 1, operationId: proof.operationId, commitSha256: committed.reference.sha256,
      bootId: a.session.bootId, supervisorId: a.session.supervisorId })); fsyncSync(lock); fsyncSync(parent);
    const current = authority(jobId); if (!enabled()) fail();
    const destination = proof.trash.destinationParent.canonicalPath + "/" + proof.trash.destinationName;
    assertHostedDependencyReferenceVeto(current.binding.workspace, destination, covered(current, DependencyReferenceEffect.TrashRemoval), DependencyReferenceEffect.TrashRemoval);
    const operation = await openCommittedDependencyTrashRemoval({ workspace: a.binding.workspace, trash: proof.trash,
      manifestCanonicalBytes: bytes, manifestDigest: proof.manifestDigest, limits, commit: committed.reference, maxRemovals: 10000 });
    try {
      if (!enabled()) fail();
      const removed = await operation.remove(); releasable = true;
      return { outcome: HostedDependencyTransactionOutcome.TrashRemoved, ...removed };
    } catch (error) {
      if (error instanceof DependencyTreeEffectError && error.reason === DependencyTreeEffectFailure.Bounds) releasable = true;
      throw error;
    } finally { const closed = await operation.close(); if (closed.closeFailures) { releasable = false; process.stderr.write("dependency_effect_close_unresolved\n"); } }
  } finally {
    closeSync(lock);
    try { if (releasable) {
      const directory = lstatSync(operations, { bigint: true });
      if (directory.dev !== parentIdentity.dev || directory.ino !== parentIdentity.ino) fail();
      const observed = lstatSync(lockPath, { bigint: true });
      if (observed.dev !== identity.dev || observed.ino !== identity.ino) fail();
      unlinkSync(lockPath);
      fsyncSync(parent);
    } } finally { closeSync(parent); }
  }
}
function fail(): never { throw new Error("dependency_transaction_unresolved"); }
