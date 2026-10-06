import { isDependencyProtectedReference } from "./dependency-environment/dependency-custody-evidence";
import { createHash } from "node:crypto";

export enum ScopedTerminationKind { Runtime = "runtime", Provider = "provider" }
export enum ScopedTerminationReason { Requested = "requested", Deadline = "deadline", Budget = "budget", Completion = "completion" }
export enum ScopedTerminationOutcome { Unresolved = "termination_unresolved", ReceiptBacked = "receipt_backed" }
export enum ScopedTerminationCause { Ownership = "ownership", Correlation = "correlation", Identity = "identity", Creator = "creator", Queue = "queue", Descendants = "descendants", Collection = "collection", Budget = "budget", Durability = "durability", Publication = "publication" }
export enum ScopedSignal { Term = "SIGTERM", Kill = "SIGKILL" }
export interface RetainedScopeIdentity {
  readonly scopeDigest: string; readonly installationId: string; readonly hostId: string; readonly bootId: string;
  readonly supervisorId: string; readonly supervisorUnit: string; readonly supervisorControlGroup: string; readonly accountId: string; readonly grantDigest: string; readonly inventoryDigest: string;
  readonly sourceSha: string; readonly artifactSha: string; readonly deadlineEpochMs: number;
  readonly authorityDigest: string; readonly slotId: string; readonly parentStartId: string;
  readonly dispatchIntentGeneration: number;
}
/** Published before enqueue. Invocation is a separate, immutable observed record;
 * its absence never allows a collector to bind a later replacement. */
export interface ScopedStartCorrelation {
  readonly schemaVersion: 1; readonly kind: ScopedTerminationKind; readonly identity: RetainedScopeIdentity;
  readonly startId: string; readonly startDigest: string; readonly parentStartDigest: string;
  readonly reservationGeneration: number; readonly unit: string; readonly controlGroup: string;
  readonly creatorPidBirth: string; readonly creatorControlGroup: string;
}
export interface ScopedInvocation { readonly schemaVersion: 1; readonly correlationDigest: string; readonly invocationId: string }
export interface ScopedTerminationMember extends ScopedStartCorrelation { readonly invocationId: string; readonly submitterDigest: string }
export interface ScopedTerminationOperation {
  readonly schemaVersion: 1; readonly identity: RetainedScopeIdentity; readonly operationGeneration: number;
  readonly members: readonly ScopedTerminationMember[];
}
export interface ScopedTerminationObservation {
  readonly startId: string; readonly identityUnchanged: boolean; readonly creatorFenced: boolean;
  readonly queueEmpty: boolean; readonly recursiveEmpty: boolean; readonly digest: string; readonly evidence: ScopedCollectedEvidence;
}
export interface ScopedTerminationReceipt {
  readonly schemaVersion: 1; readonly outcome: ScopedTerminationOutcome.ReceiptBacked;
  readonly operation: ScopedTerminationOperation; readonly publicationGeneration: number;
  readonly observations: readonly ScopedTerminationObservation[];
}
export const scopedDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fields(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) throw new Error("scoped_record_invalid");
  return value as Record<string, unknown>;
}
function match(value: unknown, pattern: RegExp): void { if (typeof value !== "string" || !pattern.test(value)) throw new Error("scoped_record_invalid"); }
function positive(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("scoped_record_invalid"); }
const hash = /^[a-f0-9]{64}$/, id = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/, birth = /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/;
export function parseRetainedScopeIdentity(value: unknown): RetainedScopeIdentity {
  const v = fields(value, "scopeDigest,installationId,hostId,bootId,supervisorId,supervisorUnit,supervisorControlGroup,accountId,grantDigest,inventoryDigest,sourceSha,artifactSha,deadlineEpochMs,authorityDigest,slotId,parentStartId,dispatchIntentGeneration");
  for (const key of ["scopeDigest", "grantDigest", "inventoryDigest", "authorityDigest"]) match(v[key], hash);
  for (const key of ["installationId", "hostId", "bootId", "supervisorUnit", "accountId", "slotId", "parentStartId"]) match(v[key], id);
  match(v.supervisorId, birth); match(v.supervisorControlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if ((v.supervisorControlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_record_invalid"); match(v.sourceSha, /^[a-f0-9]{40}$/); match(v.artifactSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  positive(v.deadlineEpochMs); positive(v.dispatchIntentGeneration);
  return Object.freeze({ ...v }) as unknown as RetainedScopeIdentity;
}
export function parseScopedStartCorrelation(value: unknown): ScopedStartCorrelation {
  const v = fields(value, "schemaVersion,kind,identity,startId,startDigest,parentStartDigest,reservationGeneration,unit,controlGroup,creatorPidBirth,creatorControlGroup");
  if (v.schemaVersion !== 1 || !Object.values(ScopedTerminationKind).includes(v.kind as ScopedTerminationKind)) throw new Error("scoped_record_invalid");
  const identity = parseRetainedScopeIdentity(v.identity);
  match(v.startId, /^[a-f0-9-]{36}$/); match(v.startDigest, hash); match(v.parentStartDigest, hash); positive(v.reservationGeneration);
  match(v.unit, /^subscription-runtime-(?:ordinary|hosted)-[a-f0-9-]{36}\.service$/);
  if (v.unit !== `subscription-runtime-${v.kind === ScopedTerminationKind.Runtime ? "ordinary" : "hosted"}-${v.startId}.service` ||
      v.controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${v.unit}` ||
      (v.kind === ScopedTerminationKind.Runtime && (v.startId !== identity.parentStartId || v.startDigest !== v.parentStartDigest))) throw new Error("scoped_record_invalid");
  match(v.creatorPidBirth, birth);
  match(v.creatorControlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if ((v.creatorControlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_record_invalid");
  return Object.freeze({ ...v, identity }) as unknown as ScopedStartCorrelation;
}
export function parseScopedInvocation(value: unknown): ScopedInvocation {
  const v = fields(value, "schemaVersion,correlationDigest,invocationId");
  if (v.schemaVersion !== 1) throw new Error("scoped_record_invalid");
  match(v.correlationDigest, hash); match(v.invocationId, /^[a-f0-9]{32}$/);
  return Object.freeze({ ...v }) as unknown as ScopedInvocation;
}
export function parseScopedOperation(value: unknown): ScopedTerminationOperation {
  const v = fields(value, "schemaVersion,identity,operationGeneration,members"), identity = parseRetainedScopeIdentity(v.identity);
  if (v.schemaVersion !== 1 || !Array.isArray(v.members) || !v.members.length || v.members.length > 256) throw new Error("scoped_record_invalid");
  positive(v.operationGeneration);
  const members = v.members.map(raw => {
    const m = fields(raw, "schemaVersion,kind,identity,startId,startDigest,parentStartDigest,reservationGeneration,unit,controlGroup,creatorPidBirth,creatorControlGroup,invocationId,submitterDigest");
    const { invocationId, submitterDigest, ...correlation } = m;
    const c = parseScopedStartCorrelation(correlation); match(invocationId, /^[a-f0-9]{32}$/); match(submitterDigest, hash);
    if (scopedDigest(c.identity) !== scopedDigest(identity)) throw new Error("scoped_record_invalid");
    return Object.freeze({ ...c, invocationId, submitterDigest }) as ScopedTerminationMember;
  });
  if (new Set(members.map(m => m.startId)).size !== members.length || members.filter(m => m.kind === ScopedTerminationKind.Runtime).length !== 1 ||
      members.some(m => m.parentStartDigest !== members[0]!.parentStartDigest)) throw new Error("scoped_record_invalid");
  return Object.freeze({ schemaVersion: 1, identity, operationGeneration: v.operationGeneration as number, members: Object.freeze(members) });
}
export function parseScopedReceipt(value: unknown): ScopedTerminationReceipt {
  const v = fields(value, "schemaVersion,outcome,operation,publicationGeneration,observations"), operation = parseScopedOperation(v.operation);
  positive(v.publicationGeneration);
  if (v.schemaVersion !== 1 || v.outcome !== ScopedTerminationOutcome.ReceiptBacked ||
      (v.publicationGeneration as number) < operation.operationGeneration || !Array.isArray(v.observations) || v.observations.length !== operation.members.length) throw new Error("scoped_record_invalid");
  const observations = v.observations.map((raw, i) => {
    const o = fields(raw, "startId,identityUnchanged,creatorFenced,queueEmpty,recursiveEmpty,digest,evidence");
    match(o.digest, hash);
    validateScopedCollectedEvidence(o.evidence as ScopedCollectedEvidence, operation.members[i]!);
    if (o.digest !== scopedDigest(o.evidence)) throw new Error("scoped_evidence_digest_invalid");
    if (o.startId !== operation.members[i]!.startId || [o.identityUnchanged, o.creatorFenced, o.queueEmpty, o.recursiveEmpty].some(flag => flag !== true)) throw new Error("scoped_record_invalid");
    return Object.freeze({ ...o }) as unknown as ScopedTerminationObservation;
  });
  return Object.freeze({ schemaVersion: 1, outcome: ScopedTerminationOutcome.ReceiptBacked, operation,
    publicationGeneration: v.publicationGeneration as number, observations: Object.freeze(observations) });
}

export interface ScopedSubmitter { readonly schemaVersion: 1; readonly correlationDigest: string; readonly pidBirth: string; readonly controlGroup: string }
export function parseScopedSubmitter(value: unknown): ScopedSubmitter {
  const v = fields(value, "schemaVersion,correlationDigest,pidBirth,controlGroup");
  if (v.schemaVersion !== 1) throw new Error("scoped_record_invalid");
  match(v.correlationDigest, hash); match(v.pidBirth, birth); match(v.controlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if ((v.controlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_record_invalid");
  return Object.freeze({ ...v }) as unknown as ScopedSubmitter;
}

export enum ScopedEnqueueActorRole { Creator = "creator", Wrapper = "wrapper", ManagerSubmitter = "manager_submitter" }
export enum ScopedActorDischargeMethod { PidfdExit = "pidfd_exit", ScopedAdmissionFence = "scoped_admission_fence" }
export interface ScopedEnqueueActor { readonly role: ScopedEnqueueActorRole; readonly pidBirth: string; readonly controlGroup: string; readonly parentPidBirth: string | null }
/** Authenticated producer closes its exact scoped spawn graph before enqueue.
 * The first noncreator is the actual retained submitter: either a direct manager
 * child or a wrapper with manager descendants. Roles discriminate those two
 * topologies; every actual noncreator requires its own positive discharge. */
export interface ScopedActorChain { readonly schemaVersion: 1; readonly correlationDigest: string; readonly submitterDigest: string; readonly actors: readonly ScopedEnqueueActor[] }
export interface ScopedActorDischarge { readonly schemaVersion: 2; readonly chainDigest: string; readonly fenceDigest: string; readonly actors: readonly (ScopedEnqueueActor & { readonly method: ScopedActorDischargeMethod })[] }
export function parseScopedActorChain(value: unknown): ScopedActorChain {
  const v = fields(value, "schemaVersion,correlationDigest,submitterDigest,actors");
  if (v.schemaVersion !== 1 || !Array.isArray(v.actors) || v.actors.length < 2 || v.actors.length > 64) throw new Error("scoped_actor_chain_incomplete");
  match(v.correlationDigest, hash); match(v.submitterDigest, hash);
  const actors = v.actors.map(raw => {
    const a = fields(raw, "role,pidBirth,controlGroup,parentPidBirth");
    if (!Object.values(ScopedEnqueueActorRole).includes(a.role as ScopedEnqueueActorRole)) throw new Error("scoped_actor_chain_invalid");
    match(a.pidBirth, birth); if (a.parentPidBirth !== null) match(a.parentPidBirth, birth);
    match(a.controlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
    if ((a.controlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_actor_chain_invalid");
    return Object.freeze({ ...a }) as unknown as ScopedEnqueueActor;
  });
  if (new Set(actors.map(a => a.pidBirth.split(":")[0])).size !== actors.length || actors[0]!.role !== ScopedEnqueueActorRole.Creator || actors[0]!.parentPidBirth !== null ||
      (actors[1]!.role !== ScopedEnqueueActorRole.Wrapper && actors[1]!.role !== ScopedEnqueueActorRole.ManagerSubmitter) ||
      (actors[1]!.role === ScopedEnqueueActorRole.Wrapper && actors.length < 3) || actors[1]!.parentPidBirth !== actors[0]!.pidBirth ||
      actors.slice(2).some((a, i) => a.role !== ScopedEnqueueActorRole.ManagerSubmitter || !actors.slice(1, i + 2).some(p => p.pidBirth === a.parentPidBirth))) throw new Error("scoped_actor_chain_invalid");
  return Object.freeze({ schemaVersion: 1, correlationDigest: v.correlationDigest as string, submitterDigest: v.submitterDigest as string, actors: Object.freeze(actors) });
}
export function bindScopedActorChain(chain: ScopedActorChain, member: ScopedTerminationMember, submitter: ScopedSubmitter): void {
  const { invocationId: _i, submitterDigest: _s, ...correlation } = member;
  const actualSubmitter = chain.actors.find(a => a.pidBirth === submitter.pidBirth);
  if (chain.correlationDigest !== scopedDigest(correlation) || chain.submitterDigest !== member.submitterDigest ||
      submitter.correlationDigest !== chain.correlationDigest || chain.actors[0]!.pidBirth !== member.creatorPidBirth || chain.actors[0]!.controlGroup !== member.creatorControlGroup ||
      actualSubmitter?.parentPidBirth !== member.creatorPidBirth || actualSubmitter.controlGroup !== submitter.controlGroup ||
      ![ScopedEnqueueActorRole.Wrapper, ScopedEnqueueActorRole.ManagerSubmitter].includes(actualSubmitter.role)) throw new Error("scoped_actor_chain_binding_invalid");
}
export function parseScopedActorDischarge(value: unknown, chain: ScopedActorChain): ScopedActorDischarge {
  const v = fields(value, "schemaVersion,chainDigest,fenceDigest,actors");
  if (v.schemaVersion !== 2 || v.chainDigest !== scopedDigest(chain) || !Array.isArray(v.actors) || v.actors.length !== chain.actors.length) throw new Error("scoped_actor_discharge_incomplete");
  match(v.fenceDigest, hash);
  const actors = v.actors.map((raw, i) => {
    const a = fields(raw, "role,pidBirth,controlGroup,parentPidBirth,method"), { method, ...actor } = a;
    if (method !== (i === 0 ? ScopedActorDischargeMethod.ScopedAdmissionFence : ScopedActorDischargeMethod.PidfdExit) || scopedDigest(actor) !== scopedDigest(chain.actors[i])) throw new Error("scoped_actor_discharge_invalid");
    return Object.freeze({ ...a }) as unknown as ScopedActorDischarge["actors"][number];
  });
  return Object.freeze({ schemaVersion: 2, chainDigest: v.chainDigest as string, fenceDigest: v.fenceDigest as string, actors: Object.freeze(actors) });
}
export interface ScopedIdentityEvidence { readonly hostId: string; readonly bootId: string; readonly supervisorBirth: string; readonly supervisorGroup: string; readonly invocationId: string; readonly invocationAnchor: { readonly invocationId: string; readonly device: number; readonly inode: number }; readonly unitGroup: string; readonly creatorBirth: string | null; readonly creatorGroup: string | null }
export interface ScopedCgroupNode { readonly path: string; readonly device: number; readonly inode: number; readonly events: string; readonly processes: string; readonly children: readonly string[] }
export interface ScopedCollectedEvidence {
  readonly schemaVersion: 1; readonly memberDigest: string; readonly chain: ScopedActorChain; readonly discharge: ScopedActorDischarge;
  readonly identityBefore: ScopedIdentityEvidence; readonly identityAfter: ScopedIdentityEvidence;
  readonly queueBefore: string; readonly queueAfter: string; readonly cgroups: readonly ScopedCgroupNode[];
}
/** Semantic validation is independent of the collector's summary flags. The
 * adapter also checks exact durable creator records and complete queue grammar. */
export function validateScopedCollectedEvidence(value: ScopedCollectedEvidence, member: ScopedTerminationMember): void {
  const e = fields(value, "schemaVersion,memberDigest,chain,discharge,identityBefore,identityAfter,queueBefore,queueAfter,cgroups");
  if (e.schemaVersion !== 1 || e.memberDigest !== scopedDigest(member)) throw new Error("scoped_evidence_invalid");
  const chain = parseScopedActorChain(e.chain); parseScopedActorDischarge(e.discharge, chain);
  const { invocationId: _i, submitterDigest: _s, ...correlation } = member;
  if (chain.correlationDigest !== scopedDigest(correlation) || chain.submitterDigest !== member.submitterDigest ||
      chain.actors[0]!.pidBirth !== member.creatorPidBirth || chain.actors[0]!.controlGroup !== member.creatorControlGroup) throw new Error("scoped_evidence_invalid");
  for (const raw of [e.identityBefore, e.identityAfter]) {
    const i = fields(raw, "hostId,bootId,supervisorBirth,supervisorGroup,invocationId,invocationAnchor,unitGroup,creatorBirth,creatorGroup"), expected = member.identity;
    const anchor = fields(i.invocationAnchor, "invocationId,device,inode");
    if (anchor.invocationId !== member.invocationId || !Number.isSafeInteger(anchor.device) || (anchor.device as number) < 0 || !Number.isSafeInteger(anchor.inode) || (anchor.inode as number) < 1) throw new Error("scoped_invocation_anchor_invalid");
    if (i.hostId !== expected.hostId || i.bootId !== expected.bootId || i.supervisorBirth !== expected.supervisorId || i.supervisorGroup !== expected.supervisorControlGroup ||
        i.invocationId !== member.invocationId || i.unitGroup !== member.controlGroup ||
        !((i.creatorBirth === member.creatorPidBirth && i.creatorGroup === member.creatorControlGroup) || (i.creatorBirth === null && i.creatorGroup === null))) throw new Error("scoped_identity_evidence_invalid");
  }
  if (scopedDigest(e.identityBefore) !== scopedDigest(e.identityAfter) || typeof e.queueBefore !== "string" || e.queueBefore.length > 262144 || e.queueBefore !== e.queueAfter ||
      !Array.isArray(e.cgroups) || !e.cgroups.length || e.cgroups.length > 256) throw new Error("scoped_evidence_invalid");
  const paths = new Set<string>();
  for (const raw of e.cgroups) {
    const node = fields(raw, "path,device,inode,events,processes,children");
    if (typeof node.path !== "string" || paths.has(node.path) || !(node.path === member.controlGroup || node.path.startsWith(member.controlGroup + "/")) ||
        node.path.split("/").some(p => p === "." || p === "..") || !Number.isSafeInteger(node.device) || (node.device as number) < 0 || !Number.isSafeInteger(node.inode) || (node.inode as number) < 1 ||
        node.processes !== "" || typeof node.events !== "string" || !Array.isArray(node.children) || node.children.length > 256 ||
        node.children.some(c => typeof c !== "string" || !/^[A-Za-z0-9_.@+-]+$/.test(c) || c === "." || c === "..") || new Set(node.children).size !== node.children.length) throw new Error("scoped_cgroup_evidence_invalid");
    const rows = node.events.trimEnd().split("\n"), entries = new Map(rows.map(r => r.split(" ")) as [string, string][]);
    if (entries.size !== rows.length || entries.get("populated") !== "0" || rows.some(r => !/^(?:populated|frozen) [01]$/.test(r))) throw new Error("scoped_cgroup_evidence_invalid");
    paths.add(node.path);
  }
  if (!paths.has(member.controlGroup)) throw new Error("scoped_cgroup_evidence_incomplete");
  for (const n of value.cgroups) {
    if (n.path !== member.controlGroup && !paths.has(n.path.slice(0, n.path.lastIndexOf("/")))) throw new Error("scoped_cgroup_evidence_incomplete");
    const expected = value.cgroups.filter(c => c.path.startsWith(n.path + "/") && !c.path.slice(n.path.length + 1).includes("/")).map(c => c.path.slice(n.path.length + 1)).sort();
    if (scopedDigest([...n.children].sort()) !== scopedDigest(expected)) throw new Error("scoped_cgroup_evidence_incomplete");
  }
}

/** Closed scheduling variant for one dependency provider while its authentic
 * ordinary parent remains Reserved. Parsing is factual validation only; the
 * store must consume the same original-map native authority, never this DTO. */
export enum ScopedTerminationExtent { ProviderOnly = "provider_only" }
export interface ScopedProviderOnlyMember {
  readonly startId:string;readonly unit:string;readonly creatorId:string;readonly originSha256:string;
  readonly generation:number;readonly start:import("./dependency-environment/dependency-custody-evidence").DependencyProtectedReference;
}
export interface ScopedProviderOnlyReceipt {
  readonly schemaVersion:2;readonly extent:ScopedTerminationExtent.ProviderOnly;readonly publicationGeneration:number;
  readonly identity:Readonly<{installationId:string;hostId:string;bootId:string;supervisorId:string;runtimeSha:string}>;
  readonly parent:ScopedProviderOnlyMember;readonly provider:ScopedProviderOnlyMember;
  readonly attempt:Readonly<{attemptId:string;epoch:number;grantDigest:string}>;
  readonly home:Readonly<{canonicalPath:string;dev:string;ino:string;mountId:string}>;
  readonly use:Readonly<{accountId:string;restoredHash:string}>;
  readonly completion:import("./dependency-environment/dependency-custody-evidence").DependencyProtectedReference;
}
export function parseScopedProviderOnlyReceipt(value:unknown):ScopedProviderOnlyReceipt {
  const v=fields(value,"schemaVersion,extent,publicationGeneration,identity,parent,provider,attempt,home,use,completion");
  if (v.schemaVersion!==2 || v.extent!==ScopedTerminationExtent.ProviderOnly) throw new Error("scoped_provider_only_invalid");
  positive(v.publicationGeneration);
  const identity=fields(v.identity,"installationId,hostId,bootId,supervisorId,runtimeSha");
  for (const key of ["installationId","hostId","bootId"]) match(identity[key],id);
  match(identity.supervisorId,birth);match(identity.runtimeSha,/^[a-f0-9]{40}$/);
  const member=(raw:unknown,kind:ScopedTerminationKind):ScopedProviderOnlyMember=>{
    const m=fields(raw,"startId,unit,creatorId,originSha256,generation,start");
    match(m.startId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);match(m.creatorId,id);match(m.originSha256,hash);positive(m.generation);
    if (m.unit!==`subscription-runtime-${kind===ScopedTerminationKind.Runtime ? "ordinary":"hosted"}-${m.startId}.service` ||
        !isDependencyProtectedReference(m.start) || m.start.path!==`/var/lib/subscription-runtime-host-policy/ordinary-starts/${m.startId}.json`) throw new Error("scoped_provider_only_invalid");
    return Object.freeze({...m,start:Object.freeze({...m.start,identity:Object.freeze({...m.start.identity})})}) as unknown as ScopedProviderOnlyMember;
  };
  const parent=member(v.parent,ScopedTerminationKind.Runtime),provider=member(v.provider,ScopedTerminationKind.Provider);
  if (parent.startId===provider.startId || provider.creatorId!==parent.creatorId || provider.originSha256!==parent.originSha256 ||
      provider.generation<=parent.generation || provider.generation>=Number(v.publicationGeneration)) throw new Error("scoped_provider_only_invalid");
  const attempt=fields(v.attempt,"attemptId,epoch,grantDigest");match(attempt.attemptId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);positive(attempt.epoch);match(attempt.grantDigest,hash);
  const home=fields(v.home,"canonicalPath,dev,ino,mountId");match(home.canonicalPath,/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if (String(home.canonicalPath).split("/").some(part=>part==="." || part==="..")) throw new Error("scoped_provider_only_invalid");
  for (const key of ["dev","mountId"]) match(home[key],/^(?:0|[1-9][0-9]{0,19})$/);match(home.ino,/^[1-9][0-9]{0,19}$/);
  const use=fields(v.use,"accountId,restoredHash");match(use.accountId,id);match(use.restoredHash,hash);
  if (!isDependencyProtectedReference(v.completion) || v.completion.path!==`/var/lib/subscription-runtime-host-policy/dependency-ordinary-provider-completions/${provider.startId}.json`) throw new Error("scoped_provider_only_invalid");
  return Object.freeze({...v,identity:Object.freeze({...identity}),parent,provider,attempt:Object.freeze({...attempt}),home:Object.freeze({...home}),use:Object.freeze({...use}),completion:Object.freeze({...v.completion,identity:Object.freeze({...v.completion.identity})})}) as unknown as ScopedProviderOnlyReceipt;
}
