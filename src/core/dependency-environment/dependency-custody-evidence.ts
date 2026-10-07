import type { DependencyTreeIdentity, DependencyWorkspaceIdentity } from "./dependency-workspace";
import { isDependencyCustodyObject, isDependencyCustodyCanonicalPath as canonical,
  isDependencyCustodyTreeIdentity as identity, isDependencyProtectedReference,
  type DependencyProtectedReference } from "./dependency-protected-reference";
import { DependencyGenerationContinuityKind } from "./dependency-generation-continuity";
import { parseDependencyGenerationContinuity, type DependencyGenerationBaseline } from "./dependency-generation-baseline";
export { isDependencyCustodyObject, isDependencyProtectedReference, sameDependencyProtectedReference,
  type DependencyProtectedReference } from "./dependency-protected-reference";

export enum DependencyConsumerLaunchKind {
  ManagedReadonlyLocalV1 = "managed_readonly_local_v1",
  OrdinaryReadonlySuccessorV1 = "ordinary_readonly_successor_v1",
}
export enum DependencyCustodyEvidenceKind {
  ReadonlyLocalAdoptionV1 = "readonly_local_adoption_v1",
  ReadonlyColdBaselineAdoptionV2 = "readonly_cold_baseline_adoption_v2",
  ReadonlyLocalSuccessorIntentV1 = "readonly_local_successor_intent_v1",
  ReadonlyLocalSuccessorOutputV1 = "readonly_local_successor_output_v1",
}
export type DependencyCustodyInstallation = {
  readonly installationId: string; readonly runtimeSha: string; readonly inventoryDigest: string;
};
export type DependencyReadonlyAdoptionEvidence = {
  readonly version: 1; readonly kind: DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1;
  readonly operationId: string; readonly workspace: DependencyWorkspaceIdentity;
  readonly candidate: { readonly jobId: string; readonly binding: DependencyProtectedReference;
    readonly comparison: DependencyProtectedReference; readonly sourceMapping: DependencyProtectedReference };
  readonly readonlyCustody: { readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string;
    readonly grant: DependencyProtectedReference; readonly policy: DependencyProtectedReference;
    readonly review: DependencyProtectedReference; readonly stage: DependencyProtectedReference; readonly lease: DependencyProtectedReference };
  readonly installation: DependencyCustodyInstallation;
};
/** Data-only transfer of an already published genuine cold baseline. The
 * closed C start can follow later HOT uses; it is not the baseline operation.
 * Only the fixed adapter authenticates completed-local provenance, discharged
 * source/idle closure and the new R custody. No comparison is asserted here. */
export type DependencyReadonlyColdBaselineAdoptionEvidence = {
  readonly version: 2; readonly kind: DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2;
  readonly operationId: string; readonly workspace: DependencyWorkspaceIdentity;
  readonly candidate: { readonly jobId: string; readonly binding: DependencyProtectedReference;
    readonly closedStartId: string; readonly generationBaseline: DependencyGenerationBaseline;
    readonly sourceClosed: DependencyProtectedReference; readonly idle: DependencyProtectedReference;
    readonly sourceMapping: DependencyProtectedReference };
  readonly readonlyCustody: DependencyReadonlyAdoptionEvidence["readonlyCustody"];
  readonly installation: DependencyCustodyInstallation;
};
/** Future names are addresses, never references to nonexistent future proof. */
export type DependencySuccessorAddresses = {
  readonly grant: string; readonly binding: string; readonly sourceBody: string; readonly transferOutput: string;
};
export type DependencyReadonlySuccessorIntent = {
  readonly version: 1; readonly kind: DependencyCustodyEvidenceKind.ReadonlyLocalSuccessorIntentV1;
  readonly operationId: string; readonly workspace: DependencyWorkspaceIdentity; readonly candidateJobId: string;
  readonly priorAssociation: DependencyProtectedReference; readonly priorReady: DependencyProtectedReference;
  readonly installation: DependencyCustodyInstallation; readonly addresses: DependencySuccessorAddresses;
};
/** Acyclic final evidence refers only to already published leaves. Its source
 * body has a separately tagged transfer codec, not CompletedLocal v2. */
export type DependencyReadonlySuccessorOutput = {
  readonly version: 1; readonly kind: DependencyCustodyEvidenceKind.ReadonlyLocalSuccessorOutputV1;
  readonly operationId: string; readonly workspace: DependencyWorkspaceIdentity; readonly tree: DependencyTreeIdentity;
  readonly installation: DependencyCustodyInstallation;
  readonly priorAssociation: DependencyProtectedReference; readonly priorReady: DependencyProtectedReference;
  readonly intent: DependencyProtectedReference; readonly grant: DependencyProtectedReference;
  readonly binding: DependencyProtectedReference; readonly sourceBody: DependencyProtectedReference;
  readonly manifest: DependencyProtectedReference; readonly toolProfile: DependencyProtectedReference;
  readonly terminalProof: DependencyProtectedReference;
  readonly installKey: string; readonly closureDigest: string; readonly manifestDigest: string;
  readonly generation: string; readonly coverageRevision: string;
};
export type DependencyCustodyEvidence = DependencyReadonlyAdoptionEvidence | DependencyReadonlyColdBaselineAdoptionEvidence |
  DependencyReadonlySuccessorIntent | DependencyReadonlySuccessorOutput;
export class DependencyCustodyEvidenceError extends Error {
  constructor() { super("dependency_custody_evidence:invalid_record"); }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const decimal = /^(?:0|[1-9][0-9]{0,19})$/;

function workspace(value: unknown): value is DependencyWorkspaceIdentity {
  return isDependencyCustodyObject(value, "canonicalPath,dev,ino") && canonical(value.canonicalPath) &&
    typeof value.dev === "string" && decimal.test(value.dev) && typeof value.ino === "string" && /^[1-9][0-9]{0,19}$/.test(value.ino);
}
function installation(value: unknown): value is DependencyCustodyInstallation {
  return isDependencyCustodyObject(value, "installationId,inventoryDigest,runtimeSha") && typeof value.installationId === "string" &&
    uuid.test(value.installationId) && typeof value.runtimeSha === "string" && /^[a-f0-9]{40}$/.test(value.runtimeSha) &&
    typeof value.inventoryDigest === "string" && digest.test(value.inventoryDigest);
}
function job(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !/sk-[A-Za-z0-9_-]{12,}/i.test(value);
}
function referenceFields(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every(name => isDependencyProtectedReference(value[name]));
}
function fail(): never { throw new DependencyCustodyEvidenceError(); }
function requireCustodyObject(value: unknown, keys: string): Record<string, unknown> {
  if (!isDependencyCustodyObject(value, keys)) fail();
  return value;
}
/** Syntax/data validation only. No filesystem read, authenticated origin,
 * grant, currentness, drain, Ready or release authority is minted here. The
 * fixed host adapter MUST select its protected namespaces before reading. */
export function parseDependencyCustodyEvidence(input: unknown): DependencyCustodyEvidence {
  if (typeof input !== "object" || input === null || !("kind" in input)) fail();
  const kindDescriptor = Object.getOwnPropertyDescriptor(input, "kind");
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, "value")) fail();
  const kind = kindDescriptor.value;
  const common = "installation,kind,operationId,version,workspace";
  const coldBaseline = kind === DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2;
  const keys = kind === DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1 || coldBaseline ? "candidate," + common + ",readonlyCustody" :
    kind === DependencyCustodyEvidenceKind.ReadonlyLocalSuccessorIntentV1 ? "addresses,candidateJobId," + common + ",priorAssociation,priorReady" :
    kind === DependencyCustodyEvidenceKind.ReadonlyLocalSuccessorOutputV1 ?
      "binding,closureDigest,coverageRevision,generation,grant,installKey,installation,intent,kind,manifest,manifestDigest,operationId,priorAssociation,priorReady,sourceBody,terminalProof,toolProfile,tree,version,workspace" : "";
  if (!keys) fail();
  const value = requireCustodyObject(input, keys.split(",").sort().join(","));
  if (value.version !== (coldBaseline ? 2 : 1) ||
      typeof value.operationId !== "string" || !uuid.test(value.operationId) || !workspace(value.workspace) || !installation(value.installation)) fail();
  if (kind === DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1) {
    const candidate = value.candidate, custody = value.readonlyCustody;
    if (!isDependencyCustodyObject(candidate, "binding,comparison,jobId,sourceMapping") || !job(candidate.jobId) ||
        !referenceFields(candidate, ["binding", "comparison", "sourceMapping"]) ||
        !isDependencyCustodyObject(custody, "grant,jobId,jobRootDir,lease,policy,review,stage,workspacePath") ||
        !job(custody.jobId) || custody.jobId === candidate.jobId || !canonical(custody.jobRootDir) ||
        custody.workspacePath !== value.workspace.canonicalPath || custody.workspacePath !== custody.jobRootDir + "/workspace" ||
        !referenceFields(custody, ["grant", "policy", "review", "stage", "lease"])) fail();
  } else if (coldBaseline) {
    const candidate = value.candidate, custody = value.readonlyCustody;
    if (!isDependencyCustodyObject(candidate, "binding,closedStartId,generationBaseline,idle,jobId,sourceClosed,sourceMapping") ||
        !job(candidate.jobId) || typeof candidate.closedStartId !== "string" || !uuid.test(candidate.closedStartId) ||
        !referenceFields(candidate, ["binding", "sourceClosed", "idle", "sourceMapping"]) ||
        !isDependencyCustodyObject(custody, "grant,jobId,jobRootDir,lease,policy,review,stage,workspacePath") ||
        !job(custody.jobId) || custody.jobId === candidate.jobId || !canonical(custody.jobRootDir) ||
        custody.workspacePath !== value.workspace.canonicalPath || custody.workspacePath !== custody.jobRootDir + "/workspace" ||
        !referenceFields(custody, ["grant", "policy", "review", "stage", "lease"])) fail();
    try {
      if (parseDependencyGenerationContinuity(candidate.generationBaseline).kind !== DependencyGenerationContinuityKind.BaselineAuthenticatedV1) fail();
    } catch { fail(); }
  } else if (kind === DependencyCustodyEvidenceKind.ReadonlyLocalSuccessorIntentV1) {
    const addresses = value.addresses;
    if (!job(value.candidateJobId) || !referenceFields(value, ["priorAssociation", "priorReady"]) ||
        !isDependencyCustodyObject(addresses, "binding,grant,sourceBody,transferOutput")) fail();
    const paths = Object.values(addresses);
    if (new Set(paths).size !== 4 ||
        !paths.every(path => canonical(path) && path.endsWith(`-${value.operationId}.json`))) fail();
  } else {
    if (!identity(value.tree) || !referenceFields(value, ["priorAssociation", "priorReady", "intent", "grant", "binding", "sourceBody", "manifest", "toolProfile", "terminalProof"]) ||
        ![value.installKey, value.closureDigest, value.manifestDigest].every(v => typeof v === "string" && digest.test(v)) ||
        !isDependencyProtectedReference(value.binding) || value.generation !== value.binding.sha256 || value.coverageRevision !== value.binding.sha256) fail();
  }
  const bytes = JSON.stringify(value);
  if (new TextEncoder().encode(bytes).length > 16384) fail();
  return JSON.parse(bytes) as DependencyCustodyEvidence;
}
