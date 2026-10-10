import { isDependencyProtectedReference, type DependencyProtectedReference } from "./dependency-custody-evidence";
import { parseDependencyToolProfile, DependencyToolOperation, type DependencyToolProfile, type DependencyToolQualification, type DependencyToolGuestConfig, dependencyToolGuestConfig, parseDependencyToolQualification } from "./dependency-tool-profile";
import { sameDependencyTree, sameDependencyWorkspace, type DependencyTreeIdentity, type DependencyWorkspaceIdentity } from "./dependency-workspace";
import { DependencyToolReadyProvenanceKind, type DependencyToolSourceRoot, type DependencyToolReadyFacts } from "./dependency-tool-ready-reader";

/** Execution basis reports current admission facts. It never creates a permit,
 * generated provenance, immutable bytes, or eligibility for eviction. */
export enum DependencyToolExecutionBasis {
  BaselineAuthenticated = "baseline_authenticated",
  UsableUnverified = "usable_unverified",
}
export type DependencyToolExecutionCommon = Readonly<{
  version: 2; workspace: DependencyWorkspaceIdentity; tree: DependencyTreeIdentity;
  installationId: string; runtimeSha: string; grantDigest: string; bindingSha256: string;
  startId: string; attemptId: string; epoch: number;
  receipt: DependencyProtectedReference; receiptRevision: number;
  currentInstallKey: string; inputClosureDigest: string;
  profile: DependencyToolProfile; capabilities: readonly DependencyToolOperation[];
  sourceRoots: readonly DependencyToolSourceRoot[];
  sourceLookupAncestors: readonly DependencyToolSourceRoot[];
}>;
export type DependencyToolExecutionFacts = DependencyToolExecutionCommon & (
  | Readonly<{ basis: DependencyToolExecutionBasis.BaselineAuthenticated;
      baseline: Readonly<{ ready: DependencyToolReadyFacts; readyReference: DependencyProtectedReference;
        continuity: DependencyProtectedReference;
        measurement: Readonly<{entries: number; bytes: string; durationMs: number}> }> }>
  | Readonly<{ basis: DependencyToolExecutionBasis.UsableUnverified }>
);

export enum DependencyToolQualificationKind { UsableUnverifiedV2 = "usable_unverified_tool_closure_v2", BaselineAuthenticatedV3 = "baseline_authenticated_tool_closure_v3" }
export type DependencyToolUsableExecution = Extract<DependencyToolExecutionFacts,{basis:DependencyToolExecutionBasis.UsableUnverified}>;
export type DependencyToolUsableQualification = Readonly<{
  version:2; kind:DependencyToolQualificationKind.UsableUnverifiedV2; execution:DependencyToolUsableExecution;
}>;
export type DependencyToolBaselineExecution = Extract<DependencyToolExecutionFacts,{basis:DependencyToolExecutionBasis.BaselineAuthenticated}>;
export type DependencyToolBaselineQualification = Readonly<{version:3;kind:DependencyToolQualificationKind.BaselineAuthenticatedV3;execution:DependencyToolBaselineExecution}>;
export type DependencyToolAdmissionQualification = DependencyToolQualification | DependencyToolUsableQualification | DependencyToolBaselineQualification;
/** Schema decoding/equality never supplies the protected original-map admission. */
export function parseDependencyToolAdmissionQualification(value:unknown):DependencyToolAdmissionQualification {
  if (!value || typeof value!=="object" || Array.isArray(value)) invalid();
  const descriptor=Object.getOwnPropertyDescriptor(value,"version");
  if (!descriptor || !("value" in descriptor)) invalid();
  if (descriptor.value===1) return parseDependencyToolQualification(value);
  const v=data(value,["version","kind","execution"]);
  if(v.version===3 && v.kind===DependencyToolQualificationKind.BaselineAuthenticatedV3) return Object.freeze({version:3,kind:DependencyToolQualificationKind.BaselineAuthenticatedV3,execution:parseDependencyToolBaselineExecution(v.execution)});
  if(v.version!==2 || v.kind!==DependencyToolQualificationKind.UsableUnverifiedV2) invalid();
  return Object.freeze({version:2,kind:DependencyToolQualificationKind.UsableUnverifiedV2,
    execution:parseDependencyToolUsableExecution(v.execution)});
}
export function dependencyToolAdmittedGuestConfig(value:DependencyToolAdmissionQualification):DependencyToolGuestConfig {
  if(value.version===1) return dependencyToolGuestConfig(value);
  const e=value.execution;
  return Object.freeze({version:1,workspace:e.workspace,tree:e.tree,profile:e.profile});
}

/** Pure equality; neither equality nor a caller-shaped record authenticates the
 * current origin, owner, input closure, continuity or actual provider namespace. */
export function matchesDependencyToolExecution(expected: DependencyToolExecutionFacts, current: DependencyToolExecutionFacts): boolean {
  return expected.basis === current.basis && sameDependencyWorkspace(expected.workspace,current.workspace) &&
    sameDependencyTree(expected.tree,current.tree) && expected.installationId === current.installationId &&
    expected.runtimeSha === current.runtimeSha && expected.grantDigest === current.grantDigest &&
    expected.bindingSha256 === current.bindingSha256 && expected.startId === current.startId &&
    expected.attemptId === current.attemptId && expected.epoch === current.epoch &&
    expected.receiptRevision === current.receiptRevision && sameReference(expected.receipt,current.receipt) &&
    expected.currentInstallKey === current.currentInstallKey && expected.inputClosureDigest === current.inputClosureDigest &&
    JSON.stringify(expected.profile) === JSON.stringify(current.profile) &&
    JSON.stringify(expected.capabilities) === JSON.stringify(current.capabilities) &&
    JSON.stringify(expected.sourceRoots) === JSON.stringify(current.sourceRoots) &&
    JSON.stringify(expected.sourceLookupAncestors) === JSON.stringify(current.sourceLookupAncestors) &&
    (expected.basis !== DependencyToolExecutionBasis.BaselineAuthenticated ||
      current.basis === DependencyToolExecutionBasis.BaselineAuthenticated &&
      JSON.stringify(expected.baseline) === JSON.stringify(current.baseline));
}

/** Usable's closed schema has no fields that can launder historical Ready bytes
 * into generated provenance. Baseline is parsed separately by its fixed trusted
 * reader, which authenticates Ready history and current continuity before use. */
export function parseDependencyToolUsableExecution(value: unknown): Extract<DependencyToolExecutionFacts,{basis:DependencyToolExecutionBasis.UsableUnverified}> {
  const v = data(value,["version","basis","workspace","tree","installationId","runtimeSha","grantDigest","bindingSha256",
    "startId","attemptId","epoch","receipt","receiptRevision","currentInstallKey","inputClosureDigest","profile",
    "capabilities","sourceRoots","sourceLookupAncestors"]);
  if (v.version !== 2 || v.basis !== DependencyToolExecutionBasis.UsableUnverified || !uuid(v.installationId) ||
      !uuid(v.startId) || !uuid(v.attemptId) || !hex(v.runtimeSha,40) || !hex(v.grantDigest,64) || !hex(v.bindingSha256,64) ||
      !hex(v.currentInstallKey,64) || !hex(v.inputClosureDigest,64) || !positive(v.epoch) || !positive(v.receiptRevision)) invalid();
  const receipt = reference(v.receipt), workspace = directory(v.workspace);
  const profile = profileFacts(v.profile);
  const capabilities = array(v.capabilities,2);
  if (capabilities.length !== 2 || capabilities[0] !== DependencyToolOperation.Optimize || capabilities[1] !== DependencyToolOperation.Test) invalid();
  return Object.freeze({version:2,basis:DependencyToolExecutionBasis.UsableUnverified,workspace,tree:tree(v.tree),
    installationId:v.installationId,runtimeSha:v.runtimeSha,grantDigest:v.grantDigest,bindingSha256:v.bindingSha256,
    startId:v.startId,attemptId:v.attemptId,epoch:v.epoch,receipt,receiptRevision:v.receiptRevision,
    currentInstallKey:v.currentInstallKey,inputClosureDigest:v.inputClosureDigest,profile,
    capabilities:Object.freeze([DependencyToolOperation.Optimize,DependencyToolOperation.Test]),
    sourceRoots:roots(v.sourceRoots,128),sourceLookupAncestors:lookupAncestors(v.sourceLookupAncestors,workspace)});
}
/** Historical baseline metadata remains separate from fresh Usable facts.
 * Decoding validates a closed shape only; it cannot authenticate continuity. */
export function parseDependencyToolBaselineExecution(value:unknown):DependencyToolBaselineExecution {
  const v=data(value,["version","basis","workspace","tree","installationId","runtimeSha","grantDigest","bindingSha256",
    "startId","attemptId","epoch","receipt","receiptRevision","currentInstallKey","inputClosureDigest","profile",
    "capabilities","sourceRoots","sourceLookupAncestors","baseline"]);
  if(v.basis!==DependencyToolExecutionBasis.BaselineAuthenticated)invalid();
  const {baseline,...common}=v;
  const parsed=parseDependencyToolUsableExecution({...common,basis:DependencyToolExecutionBasis.UsableUnverified});
  const b=data(baseline,["ready","readyReference","continuity","measurement"]),m=data(b.measurement,["entries","bytes","durationMs"]);
  if(typeof m.entries!=="number" || !Number.isSafeInteger(m.entries) || m.entries<0 || !decimal(m.bytes,false) ||
      typeof m.durationMs!=="number" || !Number.isFinite(m.durationMs) || m.durationMs<0)invalid();
  const ready=readyFacts(b.ready),readyReference=reference(b.readyReference);
  if(!sameDependencyWorkspace(parsed.workspace,ready.workspace) || !sameDependencyTree(parsed.tree,ready.tree) ||
      parsed.receiptRevision!==ready.revision || parsed.currentInstallKey!==ready.installKey || !sameReference(parsed.receipt,readyReference))invalid();
  return Object.freeze({...parsed,basis:DependencyToolExecutionBasis.BaselineAuthenticated,baseline:Object.freeze({ready,
    readyReference,continuity:reference(b.continuity),measurement:Object.freeze({entries:m.entries,bytes:m.bytes,durationMs:m.durationMs})})});
}
function readyFacts(value:unknown):DependencyToolReadyFacts {
  const r=data(value,["workspace","coverageRevision","revision","installKey","tree","manifestDigest","provenance"]);
  if(!identifier(r.coverageRevision) || !positive(r.revision) || !hex(r.installKey,64) || !hex(r.manifestDigest,64))invalid();
  const identity={workspace:directory(r.workspace),coverageRevision:r.coverageRevision,revision:r.revision,installKey:r.installKey,tree:tree(r.tree),manifestDigest:r.manifestDigest};
  if(!r.provenance || typeof r.provenance!=="object")invalid();
  const kind=Object.getOwnPropertyDescriptor(r.provenance,"kind");if(!kind || !("value" in kind))invalid();
  if(kind.value===DependencyToolReadyProvenanceKind.RegistryCompleted) {
    data(r.provenance,["kind"]);return Object.freeze({...identity,provenance:Object.freeze({kind:DependencyToolReadyProvenanceKind.RegistryCompleted})});
  }
  if(kind.value===DependencyToolReadyProvenanceKind.LocalCompleted) {
    const p=data(r.provenance,["kind","sourceBinding","readonlySources"]);
    return Object.freeze({...identity,provenance:Object.freeze({kind:DependencyToolReadyProvenanceKind.LocalCompleted,
      sourceBinding:reference(p.sourceBinding),readonlySources:roots(p.readonlySources,128)})});
  }
  if(kind.value===DependencyToolReadyProvenanceKind.LocalCompared) {
    const p=data(r.provenance,["kind","comparisonEvidenceId","sourceBinding","readonlySources"]);
    if(!identifier(p.comparisonEvidenceId))invalid();
    return Object.freeze({...identity,provenance:Object.freeze({kind:DependencyToolReadyProvenanceKind.LocalCompared,
      comparisonEvidenceId:p.comparisonEvidenceId,sourceBinding:reference(p.sourceBinding),readonlySources:roots(p.readonlySources,128)})});
  }
  invalid();
}

/** Snapshot the fixed profile schema before its legacy parser reads it. No
 * caller file/path/array accessor or iterator reaches that parser. */
function profileFacts(value:unknown):DependencyToolProfile {
  const p=data(value,["version","profileId","pins","cache","node","helper","readonlyFiles","testFiles","optimizerDependencies","transformCache"]);
  const pins=data(p.pins,["vite","vitest"]);
  const file=(value:unknown) => {const f=data(value,["path","sha256"]);return {path:f.path,sha256:f.sha256};};
  return parseDependencyToolProfile({version:p.version,profileId:p.profileId,pins:{vite:pins.vite,vitest:pins.vitest},
    cache:directory(p.cache),node:file(p.node),helper:file(p.helper),readonlyFiles:array(p.readonlyFiles,7).map(file),
    testFiles:array(p.testFiles,32),optimizerDependencies:array(p.optimizerDependencies,32),transformCache:p.transformCache});
}
function data(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![null,Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length ||
      Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",")) invalid();
  const captured:Record<string,unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    captured[key] = descriptor.value;
  }
  return captured;
}
function tree(value:unknown):DependencyTreeIdentity {
  const v=data(value,["dev","ino"]); if (!decimal(v.dev,false) || !decimal(v.ino,true)) invalid();
  return Object.freeze({dev:v.dev,ino:v.ino});
}
function directory(value:unknown):DependencyWorkspaceIdentity {
  const v=data(value,["canonicalPath","dev","ino"]); if (!absolute(v.canonicalPath)) invalid();
  return Object.freeze({canonicalPath:v.canonicalPath,...tree({dev:v.dev,ino:v.ino})});
}
function roots(value:unknown,maximum:number):readonly DependencyToolSourceRoot[] {
  const result=array(value,maximum).map(entry=>{ const v=data(entry,["canonicalPath","identity"]); if (!absolute(v.canonicalPath)) invalid();
    return Object.freeze({canonicalPath:v.canonicalPath,identity:tree(v.identity)}); });
  if (new Set(result.map(entry=>entry.canonicalPath)).size !== result.length) invalid(); return Object.freeze(result);
}
/** Captured lookup ancestry is data only. The filesystem root is valid here,
 * never as a workspace, source root, cache or caller-selected descriptor. */
function lookupAncestors(value:unknown,workspace:DependencyWorkspaceIdentity):readonly DependencyToolSourceRoot[] {
  const result=array(value,128).map(entry=>{const v=data(entry,["canonicalPath","identity"]);
    if(v.canonicalPath!=="/" && !absolute(v.canonicalPath))invalid();
    return Object.freeze({canonicalPath:v.canonicalPath,identity:tree(v.identity)});});
  if(result.length===1 && result[0]?.canonicalPath===workspace.canonicalPath) {
    if(!sameDependencyTree(result[0].identity,workspace))invalid();
  } else {
    const paths:string[]=[];
    for(let path=workspace.canonicalPath;path!=="/";) {
      const slash=path.lastIndexOf("/");path=slash===0?"/":path.slice(0,slash);
      if(paths.length>=128)invalid();paths.unshift(path);
    }
    if(result.length!==paths.length || result.some((pin,index)=>pin.canonicalPath!==paths[index]))invalid();
  }
  return Object.freeze(result);
}
function array(value:unknown,maximum:number):readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) invalid();
  const descriptors=Object.getOwnPropertyDescriptors<object>(value),length=descriptors.length;
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value<0 || length.value>maximum ||
      Reflect.ownKeys(descriptors).length!==length.value+1) invalid();
  const result:unknown[]=[];
  for (let i=0;i<length.value;i++) { const descriptor=descriptors[String(i)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(); result.push(descriptor.value); }
  return result;
}
function reference(value:unknown):DependencyProtectedReference {
  const v=data(value,["path","identity","sha256"]);
  const captured={path:v.path,identity:tree(v.identity),sha256:v.sha256};
  if (!isDependencyProtectedReference(captured)) invalid(); return Object.freeze(captured);
}
function sameReference(a:DependencyProtectedReference,b:DependencyProtectedReference):boolean {
  return a.path===b.path && a.sha256===b.sha256 && sameDependencyTree(a.identity,b.identity);
}
function absolute(value:unknown):value is string {
  return typeof value==="string" && value.length<=4096 && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.exec(value)?.[0]===value &&
    !value.split("/").some(part=>part==="."||part==="..");
}
function identifier(value:unknown):value is string { return typeof value==="string" && value.length>0 && value.length<=1024 && value.trim()===value && !/[\x00-\x1f\x7f]/.test(value); }
function uuid(value:unknown):value is string { return typeof value==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(value)?.[0]===value; }
function hex(value:unknown,length:number):value is string { return typeof value==="string" && value.length===length && /^[a-f0-9]+$/.exec(value)?.[0]===value; }
function decimal(value:unknown,positiveOnly:boolean):value is string { return typeof value==="string" && (positiveOnly ? /^[1-9][0-9]{0,19}$/ : /^(?:0|[1-9][0-9]{0,19})$/).exec(value)?.[0]===value; }
function positive(value:unknown):value is number { return typeof value==="number" && Number.isSafeInteger(value) && value>0; }
function invalid():never { throw new Error("dependency_tool_execution_invalid"); }
