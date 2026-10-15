import { gzipSync } from "node:zlib";
import { openDependencyTreePreservation, DependencyPreservationLocation } from "../worker-local/dependency-environment/dependency-tree-effects";
import { hostedDependencyPreservationRoot, hostedDependencyQuarantineRoot, hostedDependencyPreservationPath,
  readHostedDependencyPreparedPreservation, hostedDependencyPreservationCommit, readHostedDependencyCommittedPreservation,
  type HostedDependencyPreparedPreservation } from "./hosted-dependency-preservation";
import { readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { removeCurrentHostedDependencyCommittedTrash, recoverCurrentHostedDependencyCommittedTrash } from "./hosted-current-dependency-origin";
import { readHostedDependencyEvictionEnabled as enabled } from "./hosted-dependency-eviction-enabled-policy";
import { readCurrentHostedDependencyMaintenanceAuthority, claimCurrentHostedDependencyMaintenance,
  assertCurrentHostedDependencyMaintenance, retireCurrentHostedDependencyEviction, releaseCurrentHostedDependencyMaintenance,
  renameCurrentHostedDependencyMaintenanceTree } from "./hosted-current-dependency-origin";
import { assertLegacyDependencyWriterWorkspace } from "./hosted-dependency-legacy-writer-boundary";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyReceiptState as State, DependencyTreeObservationStatus as Observed,
  assertDependencyMaintenance, claimDependencyMaintenance, releaseDependencyMaintenance, parseDependencyOwner, isDependencyConsumerOwner,
  parseDependencyReceipt, parseHostedOrdinaryStart, DependencyReceiptParseStatus, sameDependencyMaintenanceAttempt, sameDependencyProtectedReference, sameDependencyTree, sameDependencyAttempt,
  type DependencyMaintenanceAttempt, type DependencyReceipt, type DependencyTrashIntent, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
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
import { DependencyInstallProofKind } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { closeDependencySourceLinkSession, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { hostedDependencyObservationLimits as limits, readHostedDependencyKeyInputs,
  assertHostedDependencyKeyInputsCurrent, sameHostedDependencyKeyInputs } from "./hosted-dependency-materialization";
import { ensureHostedDependencyDirectory, readHostedDependencyReceipt, publishHostedDependencyReceipt,
  readHostedDependencyCommittedAbsent, readHostedDependencyCommittedUnverified } from "./hosted-dependency-receipts";
import { assertHostedDependencyReferenceVeto, DependencyReferenceEffect } from "./hosted-dependency-reference-veto";

import { openHostedDependencyReadySourceLinks, assertHostedDependencyReadySourceHistory } from "./hosted-dependency-ready-source-links";

import { assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";

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
type Authority = ReturnType<typeof readCurrentHostedDependencyMaintenanceAuthority>;
/** Concrete N5 reuse of the existing actual operator/controller exclusion.
 * These methods reread protected authority; no supplied owner predicate grants
 * mutation rights. Caller owns this exact durable Maintenance across awaits. */
export function claimHostedDependencyComparisonMaintenance(jobId: string, operationId: string): DependencyMaintenanceAttempt {
  if (!uuid.test(operationId)) fail();
  return withHostedActivationFence(fence => {
    return claimCurrentHostedDependencyMaintenance(fence,jobId,operationId);
  });
}
export function assertHostedDependencyComparisonMaintenanceUnderFence(fence: import("../provider-codex/app-server/adapters/hosted-process-activation").HostedActivationFence,
  jobId: string, attempt: DependencyMaintenanceAttempt): Authority { return maintenanceUnderFence(fence, jobId, attempt); }
export function assertHostedDependencyComparisonQuiescent(jobId: string, attempt: DependencyMaintenanceAttempt): Authority {
  const a = guard(jobId, attempt), groups = covered(a);
  assertHostedDependencyReferenceVeto(a.binding.workspace, `${operations}/${attempt.operationId}.reference.json`, groups, DependencyReferenceEffect.Eviction);
  return guard(jobId, attempt);
}
function authority(jobId: string): Authority {
  // The old async remover has no authenticated physical lifetime. It cannot
  // run beside Active/pending/retiring roots through a nominal trash cwd.
  assertLegacyDependencyWriterWorkspace(trashRoot);
  return withHostedActivationFence(fence => new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence,jobId));
}
function host(a: Authority): DependencyMaintenanceAttempt["host"] {
  return { installationId: a.installation.installationId, bootId: a.session.bootId, supervisorId: a.session.supervisorId,
    runtimeSha: a.installation.runtimeSha, inventoryDigest: a.installation.inventorySha256, grantDigest: a.binding.grantDigest };
}
function guard(jobId: string, attempt: DependencyMaintenanceAttempt, requireEnabled = false): Authority {
  return withHostedActivationFence(fence => maintenanceUnderFence(fence, jobId, attempt, requireEnabled));
}
function maintenanceUnderFence(fence: import("../provider-codex/app-server/adapters/hosted-process-activation").HostedActivationFence,
  jobId: string, attempt: DependencyMaintenanceAttempt, requireEnabled = false): Authority {
    const a = readCurrentHostedDependencyMaintenanceAuthority(fence,jobId);
    if (!sameDependencyMaintenanceAttempt(attempt, { ...attempt, host: host(a) }) || (requireEnabled && !enabled()) ||
        readHostedPrivateBytes(`${operations}/${attempt.operationId}.close-unresolved.json`, 4096)) fail();
    assertCurrentHostedDependencyMaintenance(fence,jobId,attempt);
    return a;
}
function release(jobId:string,attempt:DependencyMaintenanceAttempt):void {
  withHostedActivationFence(fence=>releaseCurrentHostedDependencyMaintenance(fence,jobId,attempt));
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
      workspace: { canonicalPath: string; dev: string; ino: string }; recipe: unknown; inputSha256: unknown; profileSha256: unknown;
      installKey?: unknown; closureDigest?: unknown };
    const registry = retained?.schemaVersion === 1 && retained.recipe === HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1 &&
      Object.keys(retained).sort().join(",") === "attempt,inputSha256,profileSha256,recipe,schemaVersion,startId,unit,workspace";
    const local = retained?.schemaVersion === 2 && retained.recipe === HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1 &&
      Object.keys(retained).sort().join(",") === "attempt,closureDigest,inputSha256,installKey,profileSha256,recipe,schemaVersion,startId,unit,workspace" &&
      typeof retained.installKey === "string" && /^[a-f0-9]{64}$/.test(retained.installKey) &&
      typeof retained.closureDigest === "string" && /^[a-f0-9]{64}$/.test(retained.closureDigest);
    if (!retained || (!registry && !local) ||
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
async function baseline(ready: Pick<Ready, "manifestDigest">) {
  const placement = await openHostedDependencyManifestPlacement();
  try { return { bytes: await placement.get(ready.manifestDigest), placement }; } finally { await placement.close(); }
}
function sourceLinks(header: Header, detached = false): DependencySourceLinkSession | undefined {
  authenticateHistoricalReady(header.ready);
  if (header.ready.provenance.kind === DependencyInstallProofKind.CompletedInstall) return undefined;
  if (header.ready.provenance.kind === DependencyInstallProofKind.LegacyCompared &&
      assertHostedDependencyLegacyComparedReady({ ...header.ready, provenance: header.ready.provenance }).version === 1) return undefined;
  if (!detached) return openHostedDependencyReadySourceLinks(header.ready);
  // A target DTO cannot grant subset traversal. Bind the actual protected
  // operation header before the source adapter authenticates detached custody.
  const path = headerPath(header.attempt), before = lstatSync(path, { bigint: true }), bytes = readHostedPrivateBytes(path, 32768), after = lstatSync(path, { bigint: true });
  if (!bytes || !bytes.equals(encode(header)) || !before.isFile() || before.uid !== 0n || before.nlink !== 1n ||
      (before.mode & 0o7777n) !== 0o600n || before.dev !== after.dev || before.ino !== after.ino ||
      before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail();
  return openHostedDependencyReadySourceLinks(header.ready, { workspace: header.trash.destinationParent, name: header.trash.destinationName,
    reference: { path, identity: { dev: String(before.dev), ino: String(before.ino) }, sha256: hash(bytes) } });
}
function input(binding: HostedDependencyBinding, header: Header, bytes: Uint8Array, sourceLinkSession?: DependencySourceLinkSession): DependencyTreeEffectInput {
  return { workspace: binding.workspace, trash: header.trash, manifestCanonicalBytes: bytes, manifestDigest: header.ready.manifestDigest, limits,
    ...(sourceLinkSession ? { sourceLinkSession } : {}) };
}
function renamedEvidence(header: Header): Buffer {
  const body = { version: 1, operationId: header.attempt.operationId, workspace: header.ready.workspace,
    epoch: header.attempt.epoch, tree: header.ready.tree, trash: header.trash, manifestDigest: header.ready.manifestDigest };
  // Registry v1 bytes remain exact. A local commit also binds the original
  // protected Ready/header, independently of future Ready or Absent revisions.
  if (header.ready.provenance.kind === DependencyInstallProofKind.CompletedLocalInstallV1)
    return encode({ ...body, version: 2, headerSha256: hash(encode(header)), sourceBinding: header.ready.provenance.sourceBinding });
  if (header.ready.provenance.kind === DependencyInstallProofKind.LegacyCompared) {
    const comparison = assertHostedDependencyLegacyComparedReady({ ...header.ready, provenance: header.ready.provenance });
    if (comparison.version === 2) return encode({ ...body, version: 3, headerSha256: hash(encode(header)),
      comparisonEvidenceId: header.ready.provenance.comparisonEvidenceId, sourceBinding: comparison.candidateSourceBinding });
  }
  return encode(body);
}
function historicalHeader(receipt: Extract<DependencyReceipt, { state: State.Absent }>): Header {
  const proof = receipt.evictionCommit, bytes = readHostedPrivateBytes(`${operations}/${proof.operationId}.json`, 32768);
  if (!bytes) fail();
  const header = decodeHostedActivationBytes(bytes) as Header, parsed = parseDependencyReceipt(header?.ready);
  if (!header || Object.keys(header).sort().join(",") !== "attempt,ready,trash,version" || header.version !== 1 ||
      parsed.status !== DependencyReceiptParseStatus.Valid || parsed.receipt.state !== State.Ready || !encode(header).equals(bytes)) fail();
  const owner = parseDependencyOwner({ version: 2, workspace: receipt.workspace, revision: 1, epoch: header.attempt?.epoch,
    owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt: header.attempt } });
  if (owner.owner?.kind !== DependencyOwnerKind.Maintenance || header.attempt.operationId !== proof.operationId ||
      !encode(header.trash).equals(encode(proof.trash)) || header.ready.revision + 2 !== receipt.revision ||
      header.ready.generation !== receipt.generation || header.ready.coverageRevision !== receipt.coverageRevision ||
      !encode(header.ready.workspace).equals(encode(receipt.workspace)) || header.ready.installKey !== receipt.installKey ||
      !sameDependencyTree(header.ready.tree, proof.tree) || header.ready.manifestDigest !== proof.manifestDigest) fail();
  validateTrash(header.trash, proof.operationId);
  const evidence = readHostedPrivateBytes(`${operations}/${proof.operationId}.renamed.json`, 16384);
  if (!evidence || !evidence.equals(renamedEvidence(header)) || hash(evidence) !== proof.commitEvidenceId) fail();
  authenticateHistoricalReady(header.ready);
  return header;
}
export function readOriginalHostedDependencyRemovalHeader(receipt:Extract<DependencyReceipt,{state:State.Absent}>,access:symbol):Header {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);return historicalHeader(receipt);
}
/** Internal factual capture of original committed eviction custody. Neither
 * a supplied receipt nor a parser result can replace this protected history. */
export function readOriginalHostedDependencyRemovalCommittedHistory(jobId: string, revision: number, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  return withHostedActivationFence(fence => readOriginalHostedDependencyRemovalCommittedHistoryWithFence(fence, jobId, revision, access));
}
export function readOriginalHostedDependencyRemovalCommittedHistoryWithFence(fence: import("../provider-codex/app-server/adapters/hosted-process-activation").HostedActivationFence,
  jobId: string, revision: number, access: symbol) {
    assertOriginalHostedDependencyPhysicalRecordAccess(access);
    const actual = readCurrentHostedDependencyMaintenanceAuthority(fence, jobId), committed = readHostedDependencyCommittedAbsent(actual.binding, revision),
      header = historicalHeader(committed.receipt), pin = pinReferenceFile(headerPath(header.attempt), 32768);
    if (!pin.bytes.equals(encode(header))) fail();
    return { actual, committed, header, headerReference: pin.reference };
}
/** Historical authentication never requires the old tree/stage/current inputs. */
function authenticateHistoricalReady(ready: Ready): void {
  assertHostedDependencyReadySourceHistory(ready);
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
  const { bytes, placement } = await baseline(header.ready), destination = header.trash.destinationParent.canonicalPath + "/" + header.trash.destinationName;
  let originalLinks: DependencySourceLinkSession | undefined, detachedLinks: DependencySourceLinkSession | undefined;
  try {
  originalLinks = sourceLinks(header); detachedLinks = sourceLinks(header, true);
  if (!receipt) fail();
  if (receipt.state === State.Absent && receipt.operationId === header.attempt.operationId) {
    const proof = receipt.evictionCommit, evidence = readHostedPrivateBytes(`${operations}/${header.attempt.operationId}.renamed.json`, 16384);
    if (receipt.generation !== header.ready.generation || receipt.revision !== header.ready.revision + 2 ||
        receipt.installKey !== header.ready.installKey || proof.manifestDigest !== header.ready.manifestDigest ||
        !sameDependencyTree(proof.tree, header.ready.tree) || !encode(proof.trash).equals(encode(header.trash)) ||
        !evidence || !evidence.equals(renamedEvidence(header)) || hash(evidence) !== proof.commitEvidenceId) fail();
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
  const keyInputs = await readHostedDependencyKeyInputs(a.binding);
  a = guard(jobId, header.attempt);
  if (keyInputs.key.installKey !== header.ready.installKey) fail();
  if (!sourceAbsent) {
    a = guard(jobId, header.attempt, true);
    const observed = await observeDependencyTree({ workspacePath: a.binding.workspace.canonicalPath, treeName: "node_modules",
      expectedWorkspace: a.binding.workspace, expectedTree: header.ready.tree, limits,
      ...(originalLinks ? { sourceLinkSession: originalLinks } : {}) });
    if (observed.status !== Observed.Complete || observed.digest !== header.ready.manifestDigest ||
        !sameHostedDependencyKeyInputs(keyInputs, await readHostedDependencyKeyInputs(a.binding))) fail();
    a = guard(jobId, header.attempt, true);
    if (receipt.state === State.Ready) {
        a = guard(jobId, header.attempt, true);
        const evicting: DependencyReceipt = { version: 1, revision: receipt.revision + 1, generation: receipt.generation,
          workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, state: State.Evicting,
          operationId: header.attempt.operationId, installKey: receipt.installKey, tree: receipt.tree,
          manifestDigest: receipt.manifestDigest, trash: header.trash };
        withHostedActivationFence(fence => {
          assertHostedDependencyKeyInputsCurrent(a.binding, keyInputs);
          placement.assertCurrent(fence);
          assertCurrentHostedDependencyMaintenance(fence,jobId,header.attempt);
          publishHostedDependencyReceipt(a.binding, evicting.revision - 1, evicting);
          retireCurrentHostedDependencyEviction(fence,jobId,header.attempt);
        });
        receipt = evicting;
      }
    withHostedActivationFence(fence=>retireCurrentHostedDependencyEviction(fence,jobId,header.attempt));
    const fixedMoved=await renameCurrentHostedDependencyMaintenanceTree(jobId,header.attempt);
    if(fixedMoved) {
      if(!sameDependencyTree(fixedMoved.tree,header.ready.tree) || fixedMoved.manifestDigest!==header.ready.manifestDigest)fail();
    }else {
    const operation = await openDependencyTreeRename(input(a.binding, header, bytes, originalLinks));
    let closeFailures = 0;
    try {
      const prepared=await operation.prepareSynchronousRename();
      const moved=withHostedActivationFence(fence=>{
        a=maintenanceUnderFence(fence,jobId,header.attempt,true);
        assertHostedDependencyKeyInputsCurrent(a.binding,keyInputs);
        assertHostedDependencyReferenceVeto(a.binding.workspace,destination,covered(a),DependencyReferenceEffect.Eviction,
          {session:prepared.referenceSession,operationId:header.attempt.operationId});
        return prepared.commit(); // Synchronous effect, no thenable crosses the host fence.
      });
      if (!sameDependencyTree(moved.tree, header.ready.tree) || moved.manifestDigest !== header.ready.manifestDigest) fail();
    } finally {
      closeFailures = (await operation.close()).closeFailures;
      if (closeFailures) {
        process.stderr.write("dependency_effect_close_unresolved\n");
        createReadonlyPrivateRecord(`${operations}/${header.attempt.operationId}.close-unresolved.json`, encode({ version: 1, operationId: header.attempt.operationId }));
      }
    }
    if (closeFailures) fail();
    }
  } else {
    if (receipt.state !== State.Evicting) fail();
    const observed = await observeDependencyDirectoryRoot({ parentPath: header.trash.destinationParent.canonicalPath,
      name: header.trash.destinationName, expectedTree: header.ready.tree, limits,
      ...(detachedLinks ? { sourceLinkSession: detachedLinks } : {}) });
    if (observed.status !== Observed.Complete || observed.digest !== header.ready.manifestDigest) fail();
    a = guard(jobId, header.attempt);
    assertHostedDependencyReferenceVeto(a.binding.workspace, destination, covered(a), DependencyReferenceEffect.Eviction);
  }
  if (receipt.state !== State.Evicting || !absent(a.binding.workspace.canonicalPath + "/node_modules") ||
      !sameHostedDependencyKeyInputs(keyInputs, await readHostedDependencyKeyInputs(a.binding))) fail();
  a = guard(jobId, header.attempt);
  const evidence = renamedEvidence(header);
  const evidencePath = `${operations}/${header.attempt.operationId}.renamed.json`, retainedEvidence = readHostedPrivateBytes(evidencePath, 16384);
  if (retainedEvidence) { if (!retainedEvidence.equals(evidence)) fail(); }
  else createReadonlyPrivateRecord(evidencePath, evidence);
  const committed: DependencyReceipt = { version: 1, revision: receipt.revision + 1, generation: receipt.generation,
    workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, state: State.Absent,
    operationId: header.attempt.operationId, installKey: receipt.installKey,
    evictionCommit: { generation: receipt.generation, workspace: receipt.workspace, coverageRevision: receipt.coverageRevision,
      installKey: receipt.installKey, tree: receipt.tree, manifestDigest: receipt.manifestDigest,
      operationId: header.attempt.operationId, trash: receipt.trash, commitEvidenceId: hash(evidence) } };
  withHostedActivationFence(fence => {
    assertHostedDependencyKeyInputsCurrent(a.binding, keyInputs);
    placement.assertCurrent(fence);
    publishHostedDependencyReceipt(a.binding, committed.revision - 1, committed);
  });
  readHostedDependencyCommittedAbsent(a.binding, committed.revision);
  release(jobId, header.attempt);
  return { outcome: HostedDependencyTransactionOutcome.Evicted, revision: committed.revision };
  } finally { if (originalLinks) closeDependencySourceLinkSession(originalLinks); if (detachedLinks) closeDependencySourceLinkSession(detachedLinks); }
}

export async function evictHostedDependencyCandidate(candidate: HostedDependencyEvictionCandidate) {
  const selected = withHostedActivationFence(fence => {
    const a = readCurrentHostedDependencyMaintenanceAuthority(fence,candidate.jobId);
    if (!enabled()) return null;
    const receipt = readHostedDependencyReceipt(a.binding);
    if (receipt?.state !== State.Ready || receipt.revision !== candidate.revision || receipt.generation !== candidate.generation ||
        receipt.installKey !== candidate.installKey) fail();
    ensureHostedDependencyDirectory(operations); ensureHostedDependencyDirectory(trashRoot);
    const parent = lstatSync(trashRoot, { bigint: true });
    if (String(parent.dev) !== a.binding.workspace.dev) fail();
    {
      const attempt = claimCurrentHostedDependencyMaintenance(fence,candidate.jobId,randomUUID());
      const header: Header = { version: 1, attempt, ready: receipt, trash: { operationId: attempt.operationId,
        originalTree: receipt.tree, destinationParent: { canonicalPath: trashRoot, dev: String(parent.dev), ino: String(parent.ino) },
        destinationName: "dependency-" + attempt.operationId } };
      createReadonlyPrivateRecord(headerPath(attempt), encode(header));
      return header;
    }
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
  const a = withHostedActivationFence(fence=>readCurrentHostedDependencyMaintenanceAuthority(fence,jobId)), store = owns();
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
  authenticateHistoricalReady(header.ready);
  return finish(jobId, header);
}
export async function removeHostedDependencyCommittedTrash(jobId: string, revision: number) {
  const binding=readHostedDependencyBinding(jobId);
  return binding?.version===1 ? removeLegacyHostedDependencyCommittedTrash(jobId,revision) : removeCurrentHostedDependencyCommittedTrash(jobId,revision);
}
export function recoverHostedDependencyCommittedTrash(jobId:string,revision:number) {return recoverCurrentHostedDependencyCommittedTrash(jobId,revision);}
async function removeLegacyHostedDependencyCommittedTrash(jobId: string, revision: number) {
  const a = authority(jobId);
  if (!enabled()) return { outcome: HostedDependencyTransactionOutcome.Skipped };
  const committed = readHostedDependencyCommittedAbsent(a.binding, revision), proof = committed.receipt.evictionCommit;
  validateTrash(proof.trash, proof.operationId);
  const header = historicalHeader(committed.receipt);
  const { bytes, placement } = await baseline(proof);
  const parent = openSync(operations, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), parentIdentity = fstatSync(parent, { bigint: true });
  if (parentIdentity.uid !== 0n || (parentIdentity.mode & 0o7777n) !== 0o700n) { closeSync(parent); fail(); }
  const lockPath = `/proc/self/fd/${parent}/${proof.operationId}.remove.lock`;
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { closeSync(parent); throw error; }
  const identity = fstatSync(lock, { bigint: true });
  let releasable = false;
  let detachedLinks: DependencySourceLinkSession | undefined;
  try {
    writeFileSync(lock, encode({ version: 1, operationId: proof.operationId, commitSha256: committed.reference.sha256,
      bootId: a.session.bootId, supervisorId: a.session.supervisorId })); fsyncSync(lock); fsyncSync(parent);
    const current = authority(jobId); if (!enabled()) fail();
    withHostedActivationFence(fence => placement.assertCurrent(fence));
    const destination = proof.trash.destinationParent.canonicalPath + "/" + proof.trash.destinationName;
    assertHostedDependencyReferenceVeto(current.binding.workspace, destination, covered(current, DependencyReferenceEffect.TrashRemoval), DependencyReferenceEffect.TrashRemoval);
    detachedLinks = sourceLinks(header, true);
    const operation = await openCommittedDependencyTrashRemoval({ ...input(a.binding, header, bytes, detachedLinks),
      commit: committed.reference, maxRemovals: 10000 });
    try {
      if (!enabled()) fail();
      const removed = await operation.remove(); releasable = true;
      return { outcome: HostedDependencyTransactionOutcome.TrashRemoved, ...removed };
    } catch (error) {
      if (error instanceof DependencyTreeEffectError && error.reason === DependencyTreeEffectFailure.Bounds) releasable = true;
      throw error;
    } finally { const closed = await operation.close(); if (closed.closeFailures) { releasable = false; process.stderr.write("dependency_effect_close_unresolved\n"); } }
  } finally {
    if (detachedLinks) closeDependencySourceLinkSession(detachedLinks);
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


/** Explicit original operator request. Ordinary continuation never calls this.
 * First bounded slice: no-Active Unverified only. Active retirement requires its
 * own original source-custody transition, not a forged Ready/Evicting manifest.
 * There is deliberately no quarantine removal or automatic GC API. */
export async function preserveHostedDependencyForExplicitReinstallation(jobId: string) {
  const selected = withHostedActivationFence(fence => {
    const a = readCurrentHostedDependencyMaintenanceAuthority(fence, jobId), receipt = readHostedDependencyReceipt(a.binding);
    if (receipt?.state !== State.Unverified || a.binding.version !== 2) fail();
    const owners = owns();
    try { const prior = owners.read(a.binding.workspace); if (prior?.owner || prior?.version !== 2 || prior.generationContinuity) fail(); }
    finally { owners.close(); }
    ensureHostedDependencyDirectory(operations);
    ensureHostedDependencyDirectory(hostedDependencyPreservationRoot); ensureHostedDependencyDirectory(hostedDependencyQuarantineRoot);
    const prefix = hostedDependencyPreservationPath(a.binding, receipt.revision);
    // An existing intent belongs to recovery; never replace its owner or path.
    if (readHostedPrivateBytes(prefix + ".prepared.json", 32768) || readHostedPrivateBytes(prefix + ".committed.json", 4096)) fail();
    const parent = lstatSync(hostedDependencyQuarantineRoot, { bigint: true });
    if (String(parent.dev) !== a.binding.workspace.dev) fail();
    const attempt = claimCurrentHostedDependencyMaintenance(fence, jobId, randomUUID());
    return { binding: a.binding, attempt, previous: readHostedDependencyCommittedUnverified(a.binding, receipt.revision),
      trash: { operationId: attempt.operationId, originalTree: receipt.tree,
        destinationParent: { canonicalPath: hostedDependencyQuarantineRoot, dev: String(parent.dev), ino: String(parent.ino) },
        destinationName: `dependency-${attempt.operationId}` } };
  });
  return finishExplicitPreservation(jobId, selected);
}
/** Original persisted Maintenance identity must still authenticate. Ambiguous
 * pre/post-rename or partial mappings stay held; recovery never creates a new
 * operation, deletes a tree, restores through conflicting names or starts npm. */
export async function recoverHostedDependencyExplicitPreservation(jobId: string) {
  const selected = withHostedActivationFence(fence => {
    const a = readCurrentHostedDependencyMaintenanceAuthority(fence, jobId), owners = owns(); let attempt: DependencyMaintenanceAttempt;
    try { const owner = owners.read(a.binding.workspace); if (owner?.version !== 2 || owner.generationContinuity || owner.owner?.kind !== DependencyOwnerKind.Maintenance) fail(); attempt = owner.owner.attempt; }
    finally { owners.close(); }
    maintenanceUnderFence(fence, jobId, attempt);
    const receipt = readHostedDependencyReceipt(a.binding); if (receipt?.state !== State.Unverified) fail();
    const prefix = hostedDependencyPreservationPath(a.binding, receipt.revision);
    if (readHostedPrivateBytes(prefix + ".prepared.json", 32768)) {
      const prepared = readHostedDependencyPreparedPreservation(a.binding, receipt);
      if (!sameDependencyMaintenanceAttempt(prepared.header.attempt, attempt)) fail();
      return { binding: a.binding, attempt, previous: prepared.header.previous, trash: prepared.header.trash, prepared };
    }
    if (readHostedPrivateBytes(prefix + ".committed.json", 4096)) fail();
    // Crash before prepared publication cannot have renamed: the fixed source
    // must still exist, destination must be absent, and the same owner resumes.
    const parent = lstatSync(hostedDependencyQuarantineRoot, { bigint: true });
    if (!parent.isDirectory() || parent.uid !== 0n || (parent.mode & 0o7777n) !== 0o700n || String(parent.dev) !== a.binding.workspace.dev) fail();
    return { binding: a.binding, attempt, previous: readHostedDependencyCommittedUnverified(a.binding, receipt.revision),
      trash: { operationId: attempt.operationId, originalTree: receipt.tree,
        destinationParent: { canonicalPath: hostedDependencyQuarantineRoot, dev: String(parent.dev), ino: String(parent.ino) },
        destinationName: `dependency-${attempt.operationId}` } };
  });
  return finishExplicitPreservation(jobId, selected);
}
type ExplicitPreservationSelection = Pick<HostedDependencyPreparedPreservation, "attempt" | "previous" | "trash"> & {
  binding: HostedDependencyBinding; prepared?: ReturnType<typeof readHostedDependencyPreparedPreservation>;
};
async function finishExplicitPreservation(jobId: string, selected: ExplicitPreservationSelection) {
  const { binding, attempt, previous, trash } = selected, destination = `${hostedDependencyQuarantineRoot}/${trash.destinationName}`;
  const assertCurrent = (fence?: import("../provider-codex/app-server/adapters/hosted-process-activation").HostedActivationFence) => {
    const a = fence ? maintenanceUnderFence(fence, jobId, attempt) : guard(jobId, attempt), owners = owns();
    try { const owner = owners.read(binding.workspace); if (owner?.version !== 2 || owner.generationContinuity) fail(); }
    finally { owners.close(); }
    if (!encode(a.binding).equals(encode(binding)) || !encode(readHostedDependencyReceipt(binding)).equals(encode(previous.receipt))) fail();
    return a;
  };
  // Uses the genuine installed creator/installer mappings and exact drain path.
  const a = assertCurrent(); covered(a);
  const sourceAbsent = absent(binding.workspace.canonicalPath + "/node_modules"), targetAbsent = absent(destination);
  if (sourceAbsent === targetAbsent || sourceAbsent && !selected.prepared) fail();
  const operation = await openDependencyTreePreservation({ workspace: binding.workspace, trash, limits },
    sourceAbsent ? DependencyPreservationLocation.Preserved : DependencyPreservationLocation.Original);
  let closed = false;
  try {
    let prepared = selected.prepared;
    if (!prepared) {
      withHostedActivationFence(fence => {
        maintenanceUnderFence(fence, jobId, attempt); assertCurrent(fence);
        const inventoryPath = `${hostedDependencyQuarantineRoot}/${attempt.operationId}.inventory.json.gz`, compressed = gzipSync(operation.inventory.canonicalBytes);
        publishPreservationInventory(inventoryPath, compressed);
        const inventory = pinReferenceFile(inventoryPath, 4 * 1024 * 1024);
        if (!inventory.bytes.equals(compressed)) fail();
        const header: HostedDependencyPreparedPreservation = { version: 1, binding, attempt, previous, trash,
          inventory: { reference: inventory.reference, digest: operation.inventory.digest, logicalBytes: operation.inventory.logicalBytes, entries: operation.inventory.entries } };
        createReadonlyPrivateRecord(hostedDependencyPreservationPath(binding, previous.receipt.revision) + ".prepared.json", encode(header));
        prepared = readHostedDependencyPreparedPreservation(binding, previous.receipt);
        if (!encode(prepared.header).equals(encode(header))) fail();
      });
    }
    if (!prepared || prepared.header.inventory.digest !== operation.inventory.digest ||
        !sameDependencyMaintenanceAttempt(prepared.header.attempt, attempt)) fail();
    const committed = withHostedActivationFence(fence => {
      maintenanceUnderFence(fence, jobId, attempt); const a = assertCurrent(fence);
      const current = readHostedDependencyPreparedPreservation(binding, previous.receipt);
      if (!sameDependencyProtectedReference(current.reference, prepared!.reference)) fail();
      assertHostedDependencyReferenceVeto(binding.workspace, destination, covered(a), DependencyReferenceEffect.Eviction,
        { session: operation.referenceSession, operationId: attempt.operationId });
      operation.commit(current.header.inventory.digest);
      // Mapping publication follows both parent syncs, then independently reads
      // the protected inode/content association before owner release or npm.
      const evidence = encode(hostedDependencyPreservationCommit(current));
      createReadonlyPrivateRecord(current.prefix + ".committed.json", evidence);
      if (!pinReferenceFile(current.prefix + ".committed.json", 4096).bytes.equals(evidence)) fail();
      return current;
    });
    const result = await operation.close(); closed = true;
    if (result.closeFailures) {
      createReadonlyPrivateRecord(`${operations}/${attempt.operationId}.close-unresolved.json`, encode({ version: 1, operationId: attempt.operationId })); fail();
    }
    assertCurrent();
    if (!readHostedDependencyCommittedPreservation(binding, previous.receipt, attempt.operationId)) fail();
    release(jobId, attempt);
    return { outcome: HostedDependencyExplicitPreservationOutcome.Preserved, operationId: attempt.operationId,
      mappingDigest: hash(encode(committed.header)), destination, preservedBytes: committed.header.inventory.logicalBytes, entries: committed.header.inventory.entries };
  } finally {
    if (!closed && (await operation.close()).closeFailures)
      createReadonlyPrivateRecord(`${operations}/${attempt.operationId}.close-unresolved.json`, encode({ version: 1, operationId: attempt.operationId }));
    // Every error keeps the persisted owner/intent. No inferred rollback.
  }
}
export enum HostedDependencyExplicitPreservationOutcome { Preserved = "preserved" }

/** Unlike the small-record writer, this bounded full inventory can exceed 64KiB.
 * Replay re-syncs the exact existing inode; conflicting/partial bytes remain held. */
function publishPreservationInventory(path: string, bytes: Buffer): void {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) fail();
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!pinReferenceFile(path, 4 * 1024 * 1024).bytes.equals(bytes)) fail();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(hostedDependencyQuarantineRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== 0n || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n) fail();
    writeFileSync(fd, bytes); fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(hostedDependencyQuarantineRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  if (!pinReferenceFile(path, 4 * 1024 * 1024).bytes.equals(bytes)) fail();
}
