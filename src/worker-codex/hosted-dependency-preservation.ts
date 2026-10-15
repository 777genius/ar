import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyPreservationKind, DependencyReceiptState,
  parseDependencyOwner, sameDependencyTree, sameDependencyMaintenanceAttempt, sameDependencyProtectedReference,
  type DependencyMaintenanceAttempt, type DependencyPreservationProof, type DependencyReceipt,
  type DependencyTrashIntent } from "@vioxen/subscription-runtime/worker-core";
import type { HostedDependencyBinding } from "./hosted-dependency-workspace";
import { dependencyCoverageRevision, readHostedDependencyCommittedUnverified } from "./hosted-dependency-receipts";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

export const hostedDependencyPreservationRoot = "/var/lib/subscription-runtime-host-policy/dependency-preservation";
export const hostedDependencyQuarantineRoot = "/var/lib/subscription-runtime-host-policy/dependency-quarantine";
type Unverified = Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>;
type Pin = ReturnType<typeof pinReferenceFile>["reference"];
export type HostedDependencyPreparedPreservation = Readonly<{
  version: 1; binding: HostedDependencyBinding; attempt: DependencyMaintenanceAttempt;
  previous: { receipt: Unverified; reference: Pin }; trash: DependencyTrashIntent;
  inventory: { reference: Pin; digest: string; logicalBytes: string; entries: number };
}>;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function held(): never { throw new Error("hosted_dependency_preservation_held"); }
export function hostedDependencyPreservationPath(binding: HostedDependencyBinding, revision: number): string {
  if (![binding.workspace.dev, binding.workspace.ino].every(v => /^(0|[1-9][0-9]{0,39})$/.test(v)) ||
      !Number.isSafeInteger(revision) || revision < 1) held();
  return `${hostedDependencyPreservationRoot}/${binding.workspace.dev}-${binding.workspace.ino}-${revision}`;
}
function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields) held();
}
/** Original protected history is re-read; neither a supplied proof nor an
 * existence check on a destination can grant Installing. Broken prepared or
 * committed history never becomes factual absence. */
export function readHostedDependencyPreparedPreservation(binding: HostedDependencyBinding, previous: Unverified) {
  const prefix = hostedDependencyPreservationPath(binding, previous.revision);
  const pin = pinReferenceFile(prefix + ".prepared.json", 32768), value: unknown = JSON.parse(pin.bytes.toString("utf8"));
  exact(value, "attempt,binding,inventory,previous,trash,version");
  exact(value.previous, "receipt,reference"); exact(value.trash, "destinationName,destinationParent,operationId,originalTree");
  exact(value.trash.destinationParent, "canonicalPath,dev,ino"); exact(value.inventory, "digest,entries,logicalBytes,reference");
  const row = value as unknown as HostedDependencyPreparedPreservation;
  const current = readHostedDependencyCommittedUnverified(binding, previous.revision);
  const owner = parseDependencyOwner({ version: 2, workspace: binding.workspace, revision: 1, epoch: row.attempt?.epoch,
    owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt: row.attempt } });
  if (row.version !== 1 || !encode(row).equals(pin.bytes) || !encode(row.binding).equals(encode(binding)) ||
      !encode(row.previous.receipt).equals(encode(previous)) || !encode(current.receipt).equals(encode(previous)) ||
      !sameDependencyProtectedReference(current.reference, row.previous.reference) || owner.owner?.kind !== DependencyOwnerKind.Maintenance ||
      !sameDependencyMaintenanceAttempt(owner.owner.attempt, row.attempt) ||
      row.attempt.host.installationId !== binding.installationId || row.attempt.host.runtimeSha !== binding.runtimeSha || row.attempt.host.grantDigest !== binding.grantDigest ||
      !sameDependencyTree(row.trash.originalTree, previous.tree) || row.trash.operationId !== row.attempt.operationId ||
      row.trash.destinationName !== `dependency-${row.attempt.operationId}` || row.trash.destinationParent.canonicalPath !== hostedDependencyQuarantineRoot ||
      row.trash.destinationParent.dev !== binding.workspace.dev || !/^[1-9][0-9]{0,39}$/.test(row.trash.destinationParent.ino) ||
      row.inventory.reference.path !== `${hostedDependencyQuarantineRoot}/${row.attempt.operationId}.inventory.json.gz` ||
      !/^[a-f0-9]{64}$/.test(row.inventory.digest) || !/^(0|[1-9][0-9]{0,39})$/.test(row.inventory.logicalBytes) ||
      !Number.isSafeInteger(row.inventory.entries) || row.inventory.entries < 1) held();
  const inventory = pinReferenceFile(row.inventory.reference.path, 4 * 1024 * 1024);
  if (!sameDependencyProtectedReference(inventory.reference, row.inventory.reference) ||
      hash(gunzipSync(inventory.bytes, { maxOutputLength: 32 * 1024 * 1024 })) !== row.inventory.digest) held();
  return { header: row, reference: pin.reference, prefix };
}
export function hostedDependencyPreservationCommit(prepared: ReturnType<typeof readHostedDependencyPreparedPreservation>) {
  return { version: 1, prepared: prepared.reference, tree: prepared.header.trash.originalTree,
    inventoryDigest: prepared.header.inventory.digest, logicalBytes: prepared.header.inventory.logicalBytes, entries: prepared.header.inventory.entries };
}
/** Undefined is only a factually absent prepared intent. A partial/forged intent
 * fails closed. The new attempt's generation is bound by the real installer. */
export function readHostedDependencyCommittedPreservation(binding: HostedDependencyBinding, previous: Unverified,
  generation: string): DependencyPreservationProof | undefined {
  const mapping = readHostedDependencyPreservationMapping(binding, previous);
  if (!mapping) return undefined;
  const { prepared, committed } = mapping, trash = prepared.header.trash;
  try { lstatSync(binding.workspace.canonicalPath + "/node_modules"); held(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { kind: DependencyPreservationKind.CommittedPreservation, generation, workspace: binding.workspace,
    coverageRevision: dependencyCoverageRevision(binding), operationId: generation, originalTree: trash.originalTree,
    preservedTree: trash.originalTree, destinationParent: trash.destinationParent, destinationName: trash.destinationName,
    mappingDigest: hash(encode(prepared.header)), commitEvidenceId: committed.reference.sha256 };
}
/** Historical mapping facts only. A later Installing/Ready history reader
 * authenticates its exact adjacent records independently; this cannot grant
 * a new install or infer absence of the original workspace tree. */
export function readHostedDependencyPreservationMapping(binding: HostedDependencyBinding, previous: Unverified) {
  const prefix = hostedDependencyPreservationPath(binding, previous.revision);
  if (!readHostedPrivateBytes(prefix + ".prepared.json", 32768)) {
    if (readHostedPrivateBytes(prefix + ".committed.json", 4096)) held();
    return undefined;
  }
  const prepared = readHostedDependencyPreparedPreservation(binding, previous), committed = pinReferenceFile(prefix + ".committed.json", 4096);
  if (!committed.bytes.equals(encode(hostedDependencyPreservationCommit(prepared)))) held();
  const trash = prepared.header.trash, parent = lstatSync(hostedDependencyQuarantineRoot, { bigint: true }),
    tree = lstatSync(`${hostedDependencyQuarantineRoot}/${trash.destinationName}`, { bigint: true });
  if (!parent.isDirectory() || parent.uid !== 0n || (parent.mode & 0o7777n) !== 0o700n ||
      !sameDependencyTree({ dev: String(parent.dev), ino: String(parent.ino) }, trash.destinationParent) ||
      !tree.isDirectory() || !sameDependencyTree({ dev: String(tree.dev), ino: String(tree.ino) }, trash.originalTree)) held();
  return { prepared, committed };
}
