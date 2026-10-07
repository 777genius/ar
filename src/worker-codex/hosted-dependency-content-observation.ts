import type { DependencyProtectedReference } from "../core/dependency-environment/dependency-protected-reference";
import { createHash } from "node:crypto";
import { DependencyContentObservationRecordKind as Kind, DependencyContentObservationOutcome as Outcome,
  dependencyContentObservationLimit, type DependencyContentObservationIdentity,
  type DependencyContentObservationStage, type DependencyContentObservationRecord } from "../core/dependency-environment/dependency-content-observation";
import { sameDependencyAttempt } from "../core/dependency-environment/dependency-owner";
import { assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyGenerationState,
  assertOriginalHostedDependencyPhysicalRecordAccess, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
export type OriginalHostedDependencyContentObservation = {
  identity: DependencyContentObservationIdentity; count: number; pending?: { ordinal: number; stage: DependencyContentObservationStage };
  opened?: DependencyProtectedReference; pairs: Map<number, { started: DependencyProtectedReference; returned?: DependencyProtectedReference }>;
  uncertain: boolean; closed: boolean;
};
const root="/var/lib/subscription-runtime-host-policy/dependency-content-observations";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_content_observation_context_invalid");}
function current(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state)held();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,state.ownerPhase);
  if(!sameDependencyAttempt(actual.attempt,state.attempt) || !encode(actual.binding).equals(encode(state.binding)))held();
  return state;
}
function publish(state:OriginalHostedDependencyContentObservation,name:string,row:DependencyContentObservationRecord):DependencyProtectedReference|undefined {
  if(state.uncertain)return undefined;
  try {
    const directory=`${root}/${state.identity.startId}/${state.identity.attemptId}`;
    ensureHostedDependencyDirectory(root);ensureHostedDependencyDirectory(`${root}/${state.identity.startId}`);ensureHostedDependencyDirectory(directory);
    const bytes=encode(row),path=`${directory}/${name}.json`;createReadonlyPrivateRecord(path,bytes);
    const pin=pinReferenceFile(path,16384);if(!pin.bytes.equals(bytes))held();return pin.reference;
  }catch {state.uncertain=true;return undefined;}
}
/** Lexical original access precedes every property/IO. These fixed callsites
 * record physical work; neither an event nor a returned ordinal is a grant. */
export function openOriginalHostedDependencyContentObservation(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const owner=current(context,fence,access);if(owner.contentObservation)return;
  const identity={attemptId:owner.attempt.attemptId,startId:owner.attempt.launch.startId,epoch:owner.attempt.epoch,
    scopeSha256:createHash("sha256").update(encode({attempt:owner.attempt,binding:owner.binding})).digest("hex")};
  const state:OriginalHostedDependencyContentObservation={identity,count:0,pairs:new Map(),uncertain:false,closed:false};owner.contentObservation=state;
  const opened=publish(state,"opened",{version:1,identity,kind:Kind.Opened});if(opened)state.opened=opened;
}
export function startOriginalHostedDependencyContentObservation(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol,
  stage:DependencyContentObservationStage):number {
  openOriginalHostedDependencyContentObservation(context,fence,access);const state=current(context,fence,access).contentObservation;if(!state)held();
  if(state.closed || state.pending || state.count>=dependencyContentObservationLimit){state.uncertain=true;return 0;}
  const ordinal=++state.count;state.pending={ordinal,stage};
  const started=publish(state,`${ordinal}.started`,{version:1,identity:state.identity,kind:Kind.Started,ordinal,stage});
  if(started)state.pairs.set(ordinal,{started});return ordinal;
}
export function finishOriginalHostedDependencyContentObservation(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol,
  ordinal:number,complete:boolean):void {
  const state=current(context,fence,access).contentObservation;if(!state)held();
  if(!state.pending || state.closed || state.pending.ordinal!==ordinal){state.uncertain=true;return;}
  const stage=state.pending.stage;
  const returned=publish(state,`${ordinal}.returned`,{version:1,identity:state.identity,kind:Kind.Returned,ordinal,stage,outcome:complete?Outcome.Complete:Outcome.Incomplete}),pair=state.pairs.get(ordinal);
  if(returned && pair)pair.returned=returned;else state.uncertain=true;
  delete state.pending;if(!complete)state.uncertain=true;
}
/** An uninstrumented legacy/fallback scan or failure never receives a zero seal. */
export function markOriginalHostedDependencyContentObservationUnknown(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=current(context,fence,access).contentObservation;if(state)state.uncertain=true;
}
export function closeOriginalHostedDependencyContentObservation(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=current(context,fence,access).contentObservation;if(!state)return;
  if(state.pending){state.uncertain=true;return;}if(state.closed)return;
  if(!state.opened || state.pairs.size!==state.count){state.uncertain=true;return;}
  const observations:{ordinal:number;started:DependencyProtectedReference;returned:DependencyProtectedReference}[]=[];
  for(let ordinal=1;ordinal<=state.count;ordinal++) {
    const pair=state.pairs.get(ordinal);if(!pair?.returned){state.uncertain=true;return;}observations.push({ordinal,started:pair.started,returned:pair.returned});
  }
  publish(state,"closed",{version:1,identity:state.identity,kind:Kind.Closed,count:state.count,opened:state.opened,observations});state.closed=true;
}
