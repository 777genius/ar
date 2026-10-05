import {
  DependencyInstallProofKind, DependencyPreservationKind, DependencyReceiptState,
  DependencyUnverifiedReason, sameDependencyTree, sameDependencyWorkspace,
  type DependencyReceipt, type DependencyTreeIdentity, type DependencyWorkspaceIdentity,
} from "./dependency-receipt";
import { DependencyTreeMeasurementParseStatus, parseDependencyTreeMeasurement } from "./parse-dependency-tree-measurement";

export enum DependencyReceiptParseStatus { Valid = "valid", Invalid = "invalid" }
export type DependencyReceiptParseResult =
  | { readonly status: DependencyReceiptParseStatus.Valid; readonly receipt: DependencyReceipt }
  | { readonly status: DependencyReceiptParseStatus.Invalid };

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: RecordValue, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 40;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function path(value: unknown): value is string {
  return id(value) && value.startsWith("/") && (value === "/" ||
    value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== ".."));
}
function name(value: unknown): value is string {
  return id(value) && value !== "." && value !== ".." && !value.includes("/");
}
function tree(value: unknown): value is DependencyTreeIdentity {
  return record(value) && exact(value, ["dev", "ino"]) && decimal(value.dev) && decimal(value.ino);
}
function workspace(value: unknown): value is DependencyWorkspaceIdentity {
  return record(value) && exact(value, ["canonicalPath", "dev", "ino"])
    && path(value.canonicalPath) && decimal(value.dev) && decimal(value.ino);
}

const baseFields = ["version", "revision", "generation", "workspace", "coverageRevision", "state"];
const bindingFields = ["generation", "workspace", "coverageRevision", "installKey", "tree", "manifestDigest"];
function binding(value: RecordValue): boolean {
  return id(value.generation) && workspace(value.workspace) && id(value.coverageRevision)
    && digest(value.installKey) && tree(value.tree) && digest(value.manifestDigest);
}
function sameBase(proof: RecordValue, receipt: RecordValue): boolean {
  return proof.generation === receipt.generation && proof.coverageRevision === receipt.coverageRevision
    && workspace(proof.workspace) && workspace(receipt.workspace)
    && sameDependencyWorkspace(proof.workspace, receipt.workspace);
}
function sameReady(proof: RecordValue, receipt: RecordValue): boolean {
  return sameBase(proof, receipt) && proof.installKey === receipt.installKey
    && proof.manifestDigest === receipt.manifestDigest && tree(proof.tree) && tree(receipt.tree)
    && sameDependencyTree(proof.tree, receipt.tree);
}
function protectedDestination(parent: DependencyWorkspaceIdentity, source: unknown): boolean {
  return workspace(source) && source.canonicalPath !== "/" && !sameDependencyTree(parent, source)
    && parent.canonicalPath !== source.canonicalPath
    && !parent.canonicalPath.startsWith(`${source.canonicalPath}/`);
}
function trash(value: unknown, operationId: unknown, original: unknown, source: unknown): boolean {
  return record(value) && exact(value, ["operationId", "originalTree", "destinationParent", "destinationName"])
    && id(value.operationId) && value.operationId === operationId && tree(value.originalTree)
    && tree(original) && sameDependencyTree(value.originalTree, original)
    && workspace(value.destinationParent) && name(value.destinationName)
    && value.destinationParent.dev === value.originalTree.dev && !sameDependencyTree(value.destinationParent, value.originalTree)
    && protectedDestination(value.destinationParent, source);
}
function preservation(value: unknown, receipt: RecordValue): boolean {
  if (!record(value) || !sameBase(value, receipt) || value.operationId !== receipt.operationId) return false;
  const fields = ["kind", "generation", "workspace", "coverageRevision", "operationId"];
  switch (value.kind) {
    case DependencyPreservationKind.KnownFreshAbsence:
      return exact(value, [...fields, "absenceEvidenceId"]) && id(value.absenceEvidenceId);
    case DependencyPreservationKind.CommittedPreservation:
      return exact(value, [...fields, "originalTree", "preservedTree", "destinationParent", "destinationName",
        "mappingDigest", "commitEvidenceId"])
        && tree(value.originalTree) && tree(value.preservedTree)
        && sameDependencyTree(value.originalTree, value.preservedTree)
        && workspace(value.destinationParent) && value.destinationParent.dev === value.originalTree.dev
        && !sameDependencyTree(value.destinationParent, value.originalTree)
        && protectedDestination(value.destinationParent, receipt.workspace)
        && name(value.destinationName) && digest(value.mappingDigest) && id(value.commitEvidenceId);
    case DependencyPreservationKind.CommittedAbsence: {
      const prior = value.prior;
      if (!exact(value, [...fields, "prior"]) || !record(prior) ||
          !exact(prior, ["generation", "revision", "operationId", "installKey", "tree", "manifestDigest", "commitEvidenceId", "receipt"]) ||
          !id(prior.generation) || prior.generation === value.generation || !id(prior.operationId) || prior.operationId === value.operationId ||
          typeof prior.revision !== "number" || !Number.isSafeInteger(prior.revision) || prior.revision < 1 ||
          prior.revision + 1 !== receipt.revision || !digest(prior.installKey) || !tree(prior.tree) ||
          !digest(prior.manifestDigest) || !id(prior.commitEvidenceId) || !record(prior.receipt)) return false;
      return exact(prior.receipt, ["path", "identity", "sha256"]) && path(prior.receipt.path) && workspace(receipt.workspace) &&
        prior.receipt.path !== receipt.workspace.canonicalPath && !prior.receipt.path.startsWith(`${receipt.workspace.canonicalPath}/`) &&
        tree(prior.receipt.identity) && digest(prior.receipt.sha256);
    }
    default: return false;
  }
}
function installProof(value: unknown, receipt: RecordValue): boolean {
  if (!record(value) || !binding(value) || !sameReady(value, receipt)) return false;
  switch (value.kind) {
    case DependencyInstallProofKind.CompletedInstall:
      return exact(value, [...bindingFields, "kind", "operationId", "verificationEvidenceId", "installerDrainEvidenceId"])
        && id(value.operationId) && id(value.verificationEvidenceId) && id(value.installerDrainEvidenceId);
    case DependencyInstallProofKind.CompletedLocalInstallV1: {
      const reference = value.sourceBinding;
      return exact(value, [...bindingFields, "kind", "operationId", "verificationEvidenceId", "installerDrainEvidenceId", "sourceBinding"])
        && value.operationId === value.generation && typeof value.generation === "string"
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.generation)
        && value.verificationEvidenceId === value.manifestDigest && digest(value.installerDrainEvidenceId)
        && record(reference) && exact(reference, ["path", "identity", "sha256"])
        && path(reference.path) && tree(reference.identity) && digest(reference.sha256)
        && workspace(value.workspace) && !reference.path.startsWith(value.workspace.canonicalPath + "/")
        && reference.path.endsWith(`/dependency-source-bindings/${value.workspace.dev}-${value.workspace.ino}/${value.generation}.json`);
    }
    case DependencyInstallProofKind.LegacyCompared:
      return exact(value, [...bindingFields, "kind", "referenceInstallationId", "comparisonEvidenceId"])
        && id(value.referenceInstallationId) && id(value.comparisonEvidenceId);
    default: return false;
  }
}
function valid(value: unknown): value is DependencyReceipt {
  if (!record(value) || value.version !== 1 || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)
    || value.revision < 0 || !id(value.generation) || !workspace(value.workspace)
    || !id(value.coverageRevision)) return false;
  switch (value.state) {
    case DependencyReceiptState.Unverified:
      return exact(value, [...baseFields, "tree", "reason"]) && tree(value.tree)
        && Object.values(DependencyUnverifiedReason).some((reason) => reason === value.reason);
    case DependencyReceiptState.Installing:
      return exact(value, [...baseFields, "operationId", "requestedKey", "preservation"])
        && id(value.operationId) && digest(value.requestedKey) && preservation(value.preservation, value);
    case DependencyReceiptState.Ready:
      return exact(value, [...baseFields, "installKey", "tree", "manifestDigest", "provenance",
        ...(Object.hasOwn(value, "treeMeasurement") ? ["treeMeasurement"] : [])])
        && (!("treeMeasurement" in value) || Object.hasOwn(value, "treeMeasurement"))
        && (!Object.hasOwn(value, "treeMeasurement") ||
          parseDependencyTreeMeasurement(value.treeMeasurement).status === DependencyTreeMeasurementParseStatus.Valid)
        && digest(value.installKey) && tree(value.tree) && digest(value.manifestDigest) && installProof(value.provenance, value);
    case DependencyReceiptState.Evicting:
      return exact(value, [...baseFields, "operationId", "installKey", "tree", "manifestDigest", "trash"])
        && id(value.operationId) && digest(value.installKey) && tree(value.tree) && digest(value.manifestDigest)
        && trash(value.trash, value.operationId, value.tree, value.workspace);
    case DependencyReceiptState.Absent: {
      const proof = value.evictionCommit;
      return exact(value, [...baseFields, "operationId", "installKey", "evictionCommit"])
        && id(value.operationId) && digest(value.installKey) && record(proof)
        && exact(proof, [...bindingFields, "operationId", "trash", "commitEvidenceId"])
        && binding(proof) && sameBase(proof, value) && proof.installKey === value.installKey
        && proof.operationId === value.operationId && id(proof.commitEvidenceId)
        && trash(proof.trash, value.operationId, proof.tree, value.workspace);
    }
    default: return false;
  }
}

// Shape validation is not authentication. Only the protected store supplies trusted receipts/evidence.
// Never echo rejected payloads: they may contain credentials or unrelated caller data.
export function parseDependencyReceipt(value: unknown): DependencyReceiptParseResult {
  if (!valid(value)) return { status: DependencyReceiptParseStatus.Invalid };
  if (value.state === DependencyReceiptState.Ready && Object.hasOwn(value, "treeMeasurement")) {
    const measurement = parseDependencyTreeMeasurement(value.treeMeasurement);
    if (measurement.status !== DependencyTreeMeasurementParseStatus.Valid) return { status: DependencyReceiptParseStatus.Invalid };
    return { status: DependencyReceiptParseStatus.Valid, receipt: { ...value, treeMeasurement: measurement.measurement } };
  }
  return { status: DependencyReceiptParseStatus.Valid, receipt: value };
}
