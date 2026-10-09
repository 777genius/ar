import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyReceiptState, DependencyReceiptParseStatus,
  parseDependencyOwner, parseDependencyReceipt, isDependencyConsumerOwner, type DependencyAttempt,
  HostedCustodyReservationState, type DependencyMaintenanceAttempt, type HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallProfile, DependencyNpmLockName } from "../worker-core/dependency-environment/domain/dependency-install-key";
import type { DependencyCommittedReceiptReference as Ref, DependencyCommittedUnverifiedReceipt } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
import { DependencyLegacyComparisonRecipe, type DependencyLegacyComparisonRecord } from "../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import { HostedDependencyReferenceKind, parseHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";

export const legacyComparisonRoot = "/var/lib/subscription-runtime-host-policy/dependency-transactions";
export const referenceRecordLimit = 65536;
export const encodeReference = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
export const referenceHash = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
export function referenceFailure(): never { throw new Error("dependency_legacy_reference_unresolved"); }
export function referencePath(operationId: string, suffix: "reference" | "reference-start" | "reference-entry" | "reference-result" | "reference-release" | "comparison"): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) referenceFailure();
  return `${legacyComparisonRoot}/${operationId}.${suffix}.json`;
}
type ReferenceRelationFields = { readonly operationId: string;
  readonly candidate: { readonly binding: HostedDependencyBinding; readonly maintenance: DependencyMaintenanceAttempt;
    readonly original: DependencyCommittedUnverifiedReceipt };
  readonly reference: { readonly binding: Extract<HostedDependencyBinding, { version: 3 }>; readonly staging: DependencyMaintenanceAttempt };
  readonly inputs: { readonly lockName: DependencyNpmLockName; readonly installKey: string; readonly inputSha256: string;
    readonly profileSha256: string; readonly closureDigest: string; readonly packageSha256: string; readonly lockSha256: string };
};
export type ReferenceRelation = ReferenceRelationFields & ({readonly version:1} | {readonly version:2;readonly recipe:DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1;readonly profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1});
export type ReferenceStart = { readonly version: 1; readonly operationId: string; readonly relation: Ref;
  readonly startId: string; readonly start: Ref; readonly reservation: HostedOrdinaryReservation };
export type ReferenceEntry = { readonly version: 1; readonly operationId: string; readonly relation: Ref;
  readonly referenceStart: Ref; readonly attempt: DependencyAttempt };
type ReferenceResultFields = { readonly operationId: string; readonly relation: Ref;
  readonly referenceStart: Ref; readonly referenceEntry: Ref;
  readonly installKey: string; readonly inputSha256: string; readonly profileSha256: string };
export type ReferenceResult = ReferenceResultFields & ({readonly version:1;readonly reference:Extract<DependencyLegacyComparisonRecord,{version:1}>["reference"]} | {readonly version:2;readonly recipe:DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1;readonly profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1;readonly closureDigest:string;readonly reference:Extract<DependencyLegacyComparisonRecord,{version:2}>["reference"]});
export type ReferenceRelease = { readonly version: 1; readonly operationId: string; readonly referenceResult: Ref;
  readonly attempt: DependencyAttempt; readonly startId: string; readonly ordinaryStart: Ref; readonly ordinaryCompletion: Ref;
  readonly attemptFence: Ref; readonly ownerRevision: number };

function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function exact(v: unknown, fields: string): asserts v is Record<string, unknown> {
  if (!object(v) || Object.keys(v).sort().join(",") !== fields.split(",").sort().join(",")) referenceFailure();
}
function uuid(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v); }
function sha(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v); }
function ref(v: unknown): asserts v is Ref {
  exact(v, "path,identity,sha256"); exact(v.identity, "dev,ino");
  if (typeof v.path !== "string" || v.path.length > 1024 || !/^\/(?:[^\x00-\x20/]+\/)*[^\x00-\x20/]+$/.test(v.path) ||
    v.path.split("/").some(p => p === "." || p === "..") || !sha(v.sha256) ||
    ![v.identity.dev, v.identity.ino].every(n => typeof n === "string" && /^(0|[1-9][0-9]{0,39})$/.test(n))) referenceFailure();
}
function maintenance(v: unknown, binding: HostedDependencyBinding): asserts v is DependencyMaintenanceAttempt {
  const parsed = parseDependencyOwner({ version: 2, workspace: binding.workspace, revision: 1,
    epoch: object(v) ? v.epoch : undefined, owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt: v } });
  if (parsed.owner?.kind !== DependencyOwnerKind.Maintenance || parsed.owner.attempt.host.installationId !== binding.installationId ||
      parsed.owner.attempt.host.runtimeSha !== binding.runtimeSha || parsed.owner.attempt.host.grantDigest !== binding.grantDigest) referenceFailure();
}
function attempt(v: unknown, workspace: HostedDependencyBinding["workspace"]): asserts v is DependencyAttempt {
  const parsed = parseDependencyOwner({ version: 2, workspace, revision: 1, epoch: object(v) ? v.epoch : undefined,
    owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.ExclusiveMutation, attempt: v } });
  if (!isDependencyConsumerOwner(parsed.owner)) referenceFailure();
}
export function parseReferenceRelation(v: unknown): ReferenceRelation {
  if (!object(v)) referenceFailure();
  exact(v, v.version===2?"version,operationId,candidate,reference,inputs,recipe,profile":"version,operationId,candidate,reference,inputs");
  if ((v.version !== 1 && v.version!==2) || !uuid(v.operationId)) referenceFailure();
  referencePath(v.operationId, "reference"); exact(v.candidate, "binding,maintenance,original"); exact(v.reference, "binding,staging");
  const candidate = parseHostedDependencyBinding(v.candidate.binding), reference = parseHostedDependencyBinding(v.reference.binding);
  if (candidate.version === 3 || reference.version !== 3 || reference.reference.operationId !== v.operationId ||
      candidate.workspace.canonicalPath === reference.workspace.canonicalPath ||
      candidate.workspace.dev === reference.workspace.dev && candidate.workspace.ino === reference.workspace.ino ||
      candidate.installationId !== reference.installationId || candidate.runtimeSha !== reference.runtimeSha) referenceFailure();
  if (v.version===2 ? v.recipe!==DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1 || v.profile!==DependencyInstallProfile.TestNpmLocalNoLifecycleV1 || reference.reference.kind!==HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1 : reference.reference.kind!==HostedDependencyReferenceKind.LegacyRegistryV1) referenceFailure();
  maintenance(v.candidate.maintenance, candidate); maintenance(v.reference.staging, reference);
  if (v.candidate.maintenance.operationId !== v.operationId || v.reference.staging.operationId !== v.operationId) referenceFailure();
  exact(v.candidate.original, "receipt,reference"); ref(v.candidate.original.reference);
  const previous = parseDependencyReceipt(v.candidate.original.receipt);
  if (previous.status !== DependencyReceiptParseStatus.Valid || previous.receipt.state !== DependencyReceiptState.Unverified ||
      encodeReference(previous.receipt.workspace).compare(encodeReference(candidate.workspace)) !== 0) referenceFailure();
  exact(v.inputs, "lockName,installKey,inputSha256,profileSha256,closureDigest,packageSha256,lockSha256");
  if (v.inputs.lockName !== DependencyNpmLockName.PackageLock && v.inputs.lockName !== DependencyNpmLockName.Shrinkwrap ||
      ![v.inputs.installKey,v.inputs.inputSha256,v.inputs.profileSha256,v.inputs.closureDigest,v.inputs.packageSha256,v.inputs.lockSha256].every(sha)) referenceFailure();
  if (v.version===2 && v.inputs.inputSha256!==v.inputs.closureDigest) referenceFailure();
  return v as unknown as ReferenceRelation;
}
export function parseReferenceStart(v: unknown): ReferenceStart {
  exact(v,"version,operationId,relation,startId,start,reservation");
  if (v.version !== 1 || !uuid(v.operationId) || !uuid(v.startId)) referenceFailure(); ref(v.relation); ref(v.start);
  exact(v.reservation,"startId,unit,creatorId,originSha256,generation,state");
  if (v.reservation.startId !== v.startId || v.reservation.unit !== `subscription-runtime-ordinary-${v.startId}.service` ||
      typeof v.reservation.creatorId !== "string" || !sha(v.reservation.originSha256) ||
      !Number.isSafeInteger(v.reservation.generation) || Number(v.reservation.generation) < 1 || v.reservation.state !== HostedCustodyReservationState.Reserved) referenceFailure();
  return v as unknown as ReferenceStart;
}
export function parseReferenceEntry(v: unknown, workspace: HostedDependencyBinding["workspace"]): ReferenceEntry {
  exact(v,"version,operationId,relation,referenceStart,attempt");
  if (v.version !== 1 || !uuid(v.operationId)) referenceFailure(); ref(v.relation); ref(v.referenceStart); attempt(v.attempt,workspace);
  return v as unknown as ReferenceEntry;
}
export function parseReferenceResult(v: unknown): ReferenceResult {
  if (!object(v)) referenceFailure();
  exact(v,v.version===2?"version,operationId,relation,referenceStart,referenceEntry,reference,installKey,inputSha256,profileSha256,recipe,profile,closureDigest":"version,operationId,relation,referenceStart,referenceEntry,reference,installKey,inputSha256,profileSha256");
  if ((v.version !== 1 && v.version!==2) || !uuid(v.operationId) || ![v.installKey,v.inputSha256,v.profileSha256].every(sha)) referenceFailure();
  ref(v.relation); ref(v.referenceStart); ref(v.referenceEntry);
  exact(v.reference,v.version===2?"workspace,generation,coverageRevision,tree,manifestVersion,manifestDigest,installationId,output,mapping,start,creator,completion,terminal,sourceBinding":"workspace,generation,coverageRevision,tree,manifestVersion,manifestDigest,installationId,output,mapping,start,creator,completion,terminal");
  if (v.version===2) {ref(v.reference.sourceBinding);if (v.recipe!==DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1 || v.profile!==DependencyInstallProfile.TestNpmLocalNoLifecycleV1 || !sha(v.closureDigest) || v.inputSha256!==v.closureDigest) referenceFailure();}
  for (const name of ["output","mapping","start","creator","completion","terminal"]) ref(v.reference[name]);
  if (v.version===2) {
    exact(v.reference.workspace,"canonicalPath,dev,ino");exact(v.reference.tree,"dev,ino");
    if (typeof v.reference.workspace.canonicalPath!=="string" || !/^\/(?:[^\x00-\x20/]+\/)*[^\x00-\x20/]+$/.test(v.reference.workspace.canonicalPath) ||
        v.reference.workspace.canonicalPath.split("/").some(part=>part==="." || part==="..") ||
        ![v.reference.workspace.dev,v.reference.workspace.ino,v.reference.tree.dev,v.reference.tree.ino].every(n=>typeof n==="string" && /^(0|[1-9][0-9]{0,39})$/.test(n))) referenceFailure();
  }
  if (v.reference.manifestVersion !== (v.version===2?2:1) || !sha(v.reference.manifestDigest) || !uuid(v.reference.generation) ||
      !uuid(v.reference.installationId) || !sha(v.reference.coverageRevision)) referenceFailure();
  return v as unknown as ReferenceResult;
}
export function parseReferenceRelease(v: unknown, workspace: HostedDependencyBinding["workspace"]): ReferenceRelease {
  exact(v,"version,operationId,referenceResult,attempt,startId,ordinaryStart,ordinaryCompletion,attemptFence,ownerRevision");
  if (v.version !== 1 || !uuid(v.operationId) || !uuid(v.startId) || !Number.isSafeInteger(v.ownerRevision) || Number(v.ownerRevision) < 1) referenceFailure();
  ref(v.referenceResult); ref(v.ordinaryStart); ref(v.ordinaryCompletion); ref(v.attemptFence); attempt(v.attempt,workspace);
  return v as unknown as ReferenceRelease;
}
/** Bounded retained descriptor + named-entry equality, no raw content logging.
 * All caller-selected paths are forbidden by the fixed higher-level readers. */
export function pinReferenceFile(path: string, maxBytes = referenceRecordLimit): { bytes: Buffer; reference: Ref } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd,{bigint:true}), entry = lstatSync(path,{bigint:true});
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n ||
        before.size < 1n || before.size > BigInt(maxBytes)) referenceFailure();
    const bytes = readFileSync(fd), privateBytes = readHostedPrivateBytes(path,maxBytes), after = fstatSync(fd,{bigint:true}), current = lstatSync(path,{bigint:true});
    if (!privateBytes?.equals(bytes) ||
        before.size !== BigInt(bytes.length) || before.dev !== entry.dev || before.ino !== entry.ino ||
        before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size ||
        before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== current.ctimeNs || before.mtimeNs !== current.mtimeNs) referenceFailure();
    return { bytes, reference: {path,identity:{dev:String(before.dev),ino:String(before.ino)},sha256:referenceHash(bytes)} };
  } finally { closeSync(fd); }
}
export function readFixedReference<T>(expected: Ref, path: string, parse: (v:unknown)=>T): T {
  ref(expected); if (expected.path !== path) referenceFailure();
  const pinned = pinReferenceFile(path);
  if (!encodeReference(pinned.reference).equals(encodeReference(expected))) referenceFailure();
  const value: unknown = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(pinned.bytes)), parsed = parse(value);
  if (!encodeReference(parsed).equals(pinned.bytes)) referenceFailure(); return parsed;
}
export function readReferenceRelation(operationId: string) {
  const pinned = pinReferenceFile(referencePath(operationId,"reference"));
  const value = parseReferenceRelation(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(pinned.bytes)));
  if (value.operationId !== operationId || !encodeReference(value).equals(pinned.bytes)) referenceFailure();
  return {...pinned,value};
}
export function writeReferenceOnce(path: string, value: unknown): Ref {
  const bytes = encodeReference(value); if (bytes.length > referenceRecordLimit) referenceFailure();
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let created:{dev:string;ino:string};
  try {const stat=fstatSync(fd,{bigint:true});if (!stat.isFile() || stat.uid!==0n || stat.nlink!==1n || (stat.mode & 0o7777n)!==0o600n) referenceFailure();
    created={dev:String(stat.dev),ino:String(stat.ino)};writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
  createReadonlyPrivateRecord(path,bytes);
  const parent = openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {fsyncSync(parent);} finally {closeSync(parent);}
  const pinned = pinReferenceFile(path); if (!pinned.bytes.equals(bytes) || !encodeReference(pinned.reference.identity).equals(encodeReference(created))) referenceFailure(); return pinned.reference;
}
