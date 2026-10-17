import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DependencyInstallProofKind, DependencyReceiptParseStatus, DependencyReceiptState,
  parseDependencyConsumerAttempt, sameDependencyAttempt,
  parseDependencyReceipt, sameDependencyWorkspace, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import type { DependencyCommittedReadyReceipt, DependencyCommittedUnverifiedReceipt, DependencyCommittedAbsentReceipt } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { LocalDependencySourceBindingStore, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import type { DependencyCompletedLocalReady, DependencySourceBindingRecord } from "../worker-core/dependency-environment/ports/dependency-source-binding";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { assertHostedDependencyLocalOutputProof } from "./hosted-dependency-output-proof";

import { assertHostedDependencyLegacyComparedReady, assertHostedDependencyLegacyComparisonTransition } from "./hosted-dependency-legacy-comparison-record";

import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
export { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
const legacyRoot = "/var/lib/subscription-runtime-host-policy/dependency-receipts";
export const hostedDependencySourceBindingRoot = "/var/lib/subscription-runtime-host-policy/dependency-source-bindings";
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function dependencyCoverageRevision(binding: HostedDependencyBinding): string { return hash(encode(binding)); }
export function ensureHostedDependencyDirectory(path: string): void {
  assertReadonlyHostOperator();
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o700) fail();
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function openStore(): LocalDependencyReceiptStore {
  ensureHostedDependencyDirectory(hostedDependencyReceiptHistoryRoot);
  return openExistingStore();
}
function openExistingStore(): LocalDependencyReceiptStore {
  return LocalDependencyReceiptStore.open({ rootPath: hostedDependencyReceiptHistoryRoot, maxRecordBytes: 16384, maxHistorySteps: 2048,
    localInstallVerifier: { assertCompletedLocalInstall(receipt) { sourceStore().assertCompletedLocalInstall(receipt); } },
    legacyComparisonVerifier: { assertLegacyComparison: assertHostedDependencyLegacyComparisonTransition } });
}
function sourceStore(): LocalDependencySourceBindingStore {
  assertReadonlyHostOperator();
  return new LocalDependencySourceBindingStore(hostedDependencySourceBindingRoot, { assertInstallerCompletion: assertLocalInstallerCompletion },
    { assertVerifiedOutput: assertHostedDependencyLocalOutputProof });
}
function assertLocalInstallerCompletion(record: DependencySourceBindingRecord): void {
  const mapping = readHostedPrivateBytes(`${hostedDependencyInstallerRoot}/attempt-${record.generation}.json`, 4096);
  if (!mapping) fail();
  const row = JSON.parse(mapping.toString("utf8")) as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "attempt,schemaVersion,startId,unit" || row.schemaVersion !== 1 ||
      typeof row.startId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.startId) ||
      row.unit !== `subscription-runtime-installer-${row.startId}.service`) fail();
  const attempt = parseDependencyConsumerAttempt(row.attempt);
  if (attempt.attemptId !== record.generation) fail();
  const directory = `${hostedDependencyInstallerRoot}/${row.startId}`, startBytes = readHostedPrivateBytes(`${directory}/start.json`, 65536);
  const completion = readHostedPrivateBytes(`${directory}/creator-completion.json`, 65536), creator = readHostedPrivateBytes(`${directory}/creator.json`, 4096);
  if (!startBytes || !completion || !creator || hash(completion) !== record.installerCompletionSha256) fail();
  const start = JSON.parse(startBytes.toString("utf8")) as Record<string, unknown>;
  if (Object.keys(start).sort().join(",") !== "attempt,closureDigest,inputSha256,installKey,profileSha256,recipe,schemaVersion,startId,unit,workspace" ||
      start.schemaVersion !== 2 || start.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1 ||
      start.startId !== row.startId || start.unit !== row.unit || !sameDependencyAttempt(start.attempt as typeof attempt, attempt) ||
      !sameDependencyWorkspace(start.workspace as typeof record.workspace, record.workspace) || start.installKey !== record.installKey || start.closureDigest !== record.closureDigest ||
      typeof start.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(start.inputSha256) || typeof start.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(start.profileSha256) ||
      !completion.equals(encode({ schemaVersion: 1, startId: row.startId, startSha256: hash(startBytes), creatorSha256: hash(creator), status: 0, creatorWaitReturned: true }))) fail();
  assertHostedDependencyInstallerAttemptDrained(attempt);
  if (!readHostedPrivateBytes(`${directory}/start.json`, 65536)?.equals(startBytes) ||
      !readHostedPrivateBytes(`${directory}/creator-completion.json`, 65536)?.equals(completion) ||
      !readHostedPrivateBytes(`${hostedDependencyInstallerRoot}/attempt-${record.generation}.json`, 4096)?.equals(mapping)) fail();
}
export function publishHostedDependencySourceBinding(record: DependencySourceBindingRecord) {
  ensureHostedDependencyDirectory(hostedDependencySourceBindingRoot);
  return sourceStore().publish(record);
}
export function openHostedDependencySourceLinks(receipt: DependencyCompletedLocalReady,
  target = { workspace: receipt.workspace, name: "node_modules" }): DependencySourceLinkSession {
  // The fixed host reader also checks protected ancestry/uid/mode before the
  // generic inode-pinned record adapter accepts its immutable reference.
  const bytes = readHostedPrivateBytes(receipt.provenance.sourceBinding.path, 262144);
  if (!bytes || hash(bytes) !== receipt.provenance.sourceBinding.sha256) fail();
  return sourceStore().open(receipt, target);
}
function parsed(bytes: Buffer): DependencyReceipt {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(); }
  const result = parseDependencyReceipt(value);
  if (result.status !== DependencyReceiptParseStatus.Valid) fail();
  return result.receipt;
}
function pin(path: string) {
  const before = lstatSync(path, { bigint: true }), bytes = readHostedPrivateBytes(path, 16384), after = lstatSync(path, { bigint: true });
  if (!bytes || !before.isFile() || before.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino ||
      before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail();
  return { bytes, reference: { path, identity: { dev: String(before.dev), ino: String(before.ino) }, sha256: hash(bytes) } };
}
function legacy(binding: HostedDependencyBinding) {
  const path = `${legacyRoot}/${binding.workspace.dev}-${binding.workspace.ino}`;
  try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const installing = pin(path + "/installing.json"), ready = pin(path + "/ready.json");
  const pending = parsed(installing.bytes), completed = parsed(ready.bytes);
  if (pending.state !== DependencyReceiptState.Installing || completed.state !== DependencyReceiptState.Ready ||
      pending.revision !== 1 || completed.revision !== 2 || pending.generation !== completed.generation ||
      !sameDependencyWorkspace(pending.workspace, binding.workspace) || !sameDependencyWorkspace(completed.workspace, binding.workspace) ||
      pending.coverageRevision !== dependencyCoverageRevision(binding) || completed.coverageRevision !== pending.coverageRevision ||
      pending.requestedKey !== completed.installKey || completed.provenance.kind !== DependencyInstallProofKind.CompletedInstall ||
      pending.operationId !== completed.provenance.operationId) fail();
  return { installing, ready, pending, completed };
}

/** Latest history is authoritative. A pending/corrupt history never falls back
 * to legacy Ready. Original pair is pinned, copied through legal transitions,
 * and retained untouched; it is never synthesized from the current tree. */
export function readHostedDependencyReceipt(binding: HostedDependencyBinding): DependencyReceipt | null {
  const store = openStore();
  try {
    const current = store.read(binding.workspace), original = legacy(binding);
    if (!original) { validateBinding(current, binding); return current; }
    const migration = { version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding),
      installing: original.installing.reference, ready: original.ready.reference };
    const mapPath = `${hostedDependencyReceiptHistoryRoot}/${binding.workspace.dev}-${binding.workspace.ino}.migration.json`;
    const existing = readHostedPrivateBytes(mapPath, 4096);
    if (existing && !existing.equals(encode(migration))) fail();
    if (!existing) {
      if (current) fail();
      createReadonlyPrivateRecord(mapPath, encode(migration));
    }
    if (!current) store.compareAndSwap(binding.workspace, null, original.pending);
    const imported = store.read(binding.workspace);
    if (!imported) fail();
    if (imported.state === DependencyReceiptState.Installing && imported.revision === original.pending.revision) {
      if (!encode(imported).equals(encode(original.pending))) fail();
      store.compareAndSwap(binding.workspace, imported.revision, original.completed);
    }
    const latest = store.read(binding.workspace);
    validateBinding(latest, binding);
    return latest;
  } finally { store.close(); }
}
/** Current worker-only established read. It cannot initialize/migrate history
 * and independently authenticates local output/completion through validateBinding.
 * Every temporary store/source/proof descriptor is closed before return. */
export function readHostedDependencyEstablishedReceipt(binding: HostedDependencyBinding): DependencyReceipt | null {
  assertReadonlyHostOperator();
  for (let path = hostedDependencyReceiptHistoryRoot;; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(path) !== path ||
        (path === hostedDependencyReceiptHistoryRoot && (stat.mode & 0o777) !== 0o700)) fail();
    if (path === "/") break;
  }
  const store = LocalDependencyReceiptStore.open({ rootPath: hostedDependencyReceiptHistoryRoot,
    maxRecordBytes: 16384, maxHistorySteps: 2048 });
  let receipt: DependencyReceipt | null;
  try { receipt = store.read(binding.workspace); } finally { store.close(); }
  validateBinding(receipt, binding);
  return receipt;
}
export function publishHostedDependencyReceipt(binding: HostedDependencyBinding, expectedRevision: number | null,
  next: DependencyReceipt): DependencyReceipt {
  validateBinding(next, binding);
  const store = openStore();
  try { return store.compareAndSwap(binding.workspace, expectedRevision, next); } finally { store.close(); }
}
export function readHostedDependencyCommittedAbsent(binding: HostedDependencyBinding, revision: number): DependencyCommittedAbsentReceipt {
  const store = openStore();
  try {
    const result = store.getCommittedAbsent(binding.workspace, revision);
    validateBinding(result.receipt, binding);
    return result;
  } finally { store.close(); }
}
/** Fixed current eviction history read. No missing history is created. */
export function readHostedDependencyExistingCommittedEvicting(fence:HostedActivationFence,binding:HostedDependencyBinding,revision:number) {
  assertHostedActivationFence(fence);assertReadonlyHostOperator();
  const before=readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot),store=openExistingStore();
  let result:ReturnType<LocalDependencyReceiptStore["getCommittedEvicting"]>;
  try{result=store.getCommittedEvicting(binding.workspace,revision);}
  finally{store.close();}
  validateBinding(result.receipt,binding);assertHostedActivationFence(fence);
  if(JSON.stringify(readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot))!==JSON.stringify(before))fail();return result;
}
/** Reference producer seals the actual store-captured committed output. */
export function readHostedDependencyCommittedReady(binding: HostedDependencyBinding, revision: number): DependencyCommittedReadyReceipt {
  const store = openStore();
  try {
    const result = store.getCommittedReady(binding.workspace, revision);
    validateBinding(result.receipt, binding);
    return result;
  } finally { store.close(); }
}
/** Fixed recovery read only. An absent/unsafe history root is refused without
 * mkdir, fsync, migration or publication; the SAME existing configured proof
 * validators still authenticate committed Ready after every retained FD closes.
 */
export function readHostedDependencyExistingCommittedReady(fence:HostedActivationFence,
  binding:HostedDependencyBinding,revision:number):DependencyCommittedReadyReceipt {
  assertHostedActivationFence(fence); assertReadonlyHostOperator();
  const before=readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot),stat=lstatSync(hostedDependencyReceiptHistoryRoot);
  if (stat.uid!==0 || stat.gid!==0 || (stat.mode & 0o7777)!==0o700) fail();
  const store=openExistingStore(); let result:DependencyCommittedReadyReceipt;
  try {result=store.getCommittedReady(binding.workspace,revision);} finally {store.close();}
  assertHostedActivationFence(fence);
  if (JSON.stringify(readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot))!==JSON.stringify(before)) fail();
  validateBinding(result.receipt,binding); assertHostedActivationFence(fence);
  if (JSON.stringify(readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot))!==JSON.stringify(before)) fail();
  return result;
}
/** Historical Unverified read only. It proves the original committed record,
 * never current bytes, execution permission or eviction eligibility. Existing
 * ancestry/physical pin and held-fence checks mirror the Ready recovery reader.
 */
export function readHostedDependencyExistingCommittedUnverified(fence:HostedActivationFence,
  binding:HostedDependencyBinding,revision:number):DependencyCommittedUnverifiedReceipt {
  assertHostedActivationFence(fence); assertReadonlyHostOperator();
  const before=readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot),stat=lstatSync(hostedDependencyReceiptHistoryRoot);
  if (stat.uid!==0 || stat.gid!==0 || (stat.mode & 0o7777)!==0o700) fail();
  const store=openExistingStore(); let result:DependencyCommittedUnverifiedReceipt;
  try {result=store.getCommittedUnverified(binding.workspace,revision);} finally {store.close();}
  assertHostedActivationFence(fence);
  if (JSON.stringify(readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot))!==JSON.stringify(before)) fail();
  validateBinding(result.receipt,binding); assertHostedActivationFence(fence);
  if (JSON.stringify(readHostedDependencyRootDirectoryPin(hostedDependencyReceiptHistoryRoot))!==JSON.stringify(before)) fail();
  return result;
}
/** Issuer receives immutable facts only; CAS captures its own predecessor again. */
export function readHostedDependencyCommittedUnverified(binding: HostedDependencyBinding, revision: number): DependencyCommittedUnverifiedReceipt {
  const store = openStore();
  try {
    const result = store.getCommittedUnverified(binding.workspace, revision);
    validateBinding(result.receipt, binding);
    return result;
  } finally { store.close(); }
}
function validateBinding(receipt: DependencyReceipt | null, binding: HostedDependencyBinding): void {
  if (receipt && (!sameDependencyWorkspace(receipt.workspace, binding.workspace) ||
      receipt.coverageRevision !== dependencyCoverageRevision(binding))) fail();
  if (receipt?.state === DependencyReceiptState.Ready && receipt.provenance.kind === DependencyInstallProofKind.LegacyCompared) {
    assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance });
  }
  if (receipt?.state === DependencyReceiptState.Ready && receipt.provenance.kind === DependencyInstallProofKind.CompletedLocalInstallV1) {
    sourceStore().assertCompletedLocalInstall({ ...receipt, provenance: receipt.provenance });
  }
}
function fail(): never { throw new Error("dependency_receipt_history_unresolved"); }
