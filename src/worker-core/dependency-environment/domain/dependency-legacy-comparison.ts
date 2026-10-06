import { DependencyInstallProfile } from "./dependency-install-key";
import { DependencyReceiptState, sameDependencyWorkspace, type DependencyTreeIdentity,
  type DependencyWorkspaceIdentity } from "./dependency-receipt";
import { DependencyReceiptParseStatus, parseDependencyReceipt } from "./parse-dependency-receipt";
import type { DependencyCommittedReceiptReference } from "../ports/dependency-receipt-store";
import type { DependencyUnverifiedReceipt } from "../ports/dependency-legacy-comparison";

export enum DependencyLegacyComparisonRecipe { NpmRegistryNoScriptsV1 = "npm_registry_no_scripts_v1" }
/** Fixed registry-only observation. References name immutable protected facts,
 * not caller authority. A trusted reader must authenticate every chain leaf. */
export type DependencyLegacyComparisonRecord = {
  readonly version: 1;
  readonly recipe: DependencyLegacyComparisonRecipe.NpmRegistryNoScriptsV1;
  readonly profile: DependencyInstallProfile.TestNpmQualification;
  readonly operationId: string;
  readonly comparisonEvidenceId: string;
  readonly referenceInstallationId: string;
  readonly original: { readonly receipt: DependencyUnverifiedReceipt; readonly reference: DependencyCommittedReceiptReference };
  readonly reference: {
    readonly workspace: DependencyWorkspaceIdentity; readonly generation: string; readonly coverageRevision: string;
    readonly tree: DependencyTreeIdentity; readonly manifestVersion: 1; readonly manifestDigest: string;
    readonly installationId: string;
    // output pins the actual immutable CompletedInstall Ready receipt.
    readonly output: DependencyCommittedReceiptReference;
    readonly mapping: DependencyCommittedReceiptReference; readonly start: DependencyCommittedReceiptReference;
    readonly creator: DependencyCommittedReceiptReference; readonly completion: DependencyCommittedReceiptReference;
    readonly terminal: DependencyCommittedReceiptReference;
  };
  readonly installKey: string; readonly inputSha256: string; readonly profileSha256: string;
  readonly originalManifestDigest: string; readonly referenceManifestDigest: string;
  readonly relation: DependencyCommittedReceiptReference; readonly referenceStart: DependencyCommittedReceiptReference;
  readonly referenceEntry: DependencyCommittedReceiptReference; readonly referenceResult: DependencyCommittedReceiptReference;
  readonly referenceRelease: DependencyCommittedReceiptReference;
};

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: RecordValue, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function decimal(value: unknown): boolean { return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 40; }
function path(value: unknown): boolean { return id(value) && value.startsWith("/") && value.slice(1).split("/").every(p => p !== "" && p !== "." && p !== ".."); }
function tree(value: unknown): boolean { return object(value) && exact(value, ["dev", "ino"]) && decimal(value.dev) && decimal(value.ino); }
function workspace(value: unknown): value is DependencyWorkspaceIdentity { return object(value) && exact(value, ["canonicalPath", "dev", "ino"]) &&
  path(value.canonicalPath) && decimal(value.dev) && decimal(value.ino); }
function reference(value: unknown): boolean { return object(value) && exact(value, ["path", "identity", "sha256"]) && path(value.path) && tree(value.identity) && digest(value.sha256); }
function invalid(): never { throw new Error("dependency_legacy_comparison:invalid_record"); }

/** Exact shape validation only; this function never grants Ready authority. */
export function parseDependencyLegacyComparisonRecord(value: unknown): DependencyLegacyComparisonRecord {
  if (!object(value) || !exact(value, ["version", "recipe", "profile", "operationId", "comparisonEvidenceId", "referenceInstallationId",
    "original", "reference", "installKey", "inputSha256", "profileSha256", "originalManifestDigest", "referenceManifestDigest",
    "relation", "referenceStart", "referenceEntry", "referenceResult", "referenceRelease"]) || value.version !== 1 ||
    value.recipe !== DependencyLegacyComparisonRecipe.NpmRegistryNoScriptsV1 || value.profile !== DependencyInstallProfile.TestNpmQualification ||
    typeof value.operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.operationId) ||
    !id(value.comparisonEvidenceId) || !id(value.referenceInstallationId) ||
    ![value.installKey, value.inputSha256, value.profileSha256, value.originalManifestDigest, value.referenceManifestDigest].every(digest) ||
    value.originalManifestDigest !== value.referenceManifestDigest ||
    ![value.relation, value.referenceStart, value.referenceEntry, value.referenceResult, value.referenceRelease].every(reference)) return invalid();
  if (!object(value.original) || !exact(value.original, ["receipt", "reference"]) || !reference(value.original.reference)) return invalid();
  const original = parseDependencyReceipt(value.original.receipt);
  if (original.status !== DependencyReceiptParseStatus.Valid || original.receipt.state !== DependencyReceiptState.Unverified) return invalid();
  const ref = value.reference;
  if (!object(ref) || !exact(ref, ["workspace", "generation", "coverageRevision", "tree", "manifestVersion", "manifestDigest", "installationId",
    "output", "mapping", "start", "creator", "completion", "terminal"]) || !workspace(ref.workspace) || !tree(ref.tree) ||
    sameDependencyWorkspace(original.receipt.workspace, ref.workspace) || original.receipt.workspace.canonicalPath === ref.workspace.canonicalPath ||
    !id(ref.generation) || !id(ref.coverageRevision) || !id(ref.installationId) || ref.installationId !== value.referenceInstallationId ||
    ref.manifestVersion !== 1 || ref.manifestDigest !== value.referenceManifestDigest ||
    ![ref.output, ref.mapping, ref.start, ref.creator, ref.completion, ref.terminal].every(reference)) return invalid();
  return value as unknown as DependencyLegacyComparisonRecord;
}
