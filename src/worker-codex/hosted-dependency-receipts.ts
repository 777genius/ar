import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DependencyInstallProofKind, DependencyReceiptParseStatus, DependencyReceiptState,
  parseDependencyReceipt, sameDependencyWorkspace, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import type { DependencyCommittedAbsentReceipt } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";

export const hostedDependencyReceiptHistoryRoot = "/var/lib/subscription-runtime-host-policy/dependency-receipt-history";
const legacyRoot = "/var/lib/subscription-runtime-host-policy/dependency-receipts";
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
  return LocalDependencyReceiptStore.open({ rootPath: hostedDependencyReceiptHistoryRoot, maxRecordBytes: 16384, maxHistorySteps: 2048 });
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
function validateBinding(receipt: DependencyReceipt | null, binding: HostedDependencyBinding): void {
  if (receipt && (!sameDependencyWorkspace(receipt.workspace, binding.workspace) ||
      receipt.coverageRevision !== dependencyCoverageRevision(binding))) fail();
}
function fail(): never { throw new Error("dependency_receipt_history_unresolved"); }
