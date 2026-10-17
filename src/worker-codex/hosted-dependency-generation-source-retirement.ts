import { DependencyOwnerPhase, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { assertOriginalHostedDependencyGenerationBarrier } from "./hosted-dependency-generation-controller";
import { assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyGenerationState,
  findOriginalHostedDependencyGenerationEntry, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencyGenerationBarrierPhase as BarrierPhase, HostedDependencySourceUsePhase, HostedDependencySourceRuntimeClosureKind as ClosureKind } from "./hosted-dependency-generation-state";
import { ManagedSessionUsePhase } from "./hosted-managed-dependency-session-state";
const root="/var/lib/subscription-runtime-host-policy/dependency-generation-source-retirements",encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function invalid():never {throw new Error("hosted_dependency_source_retirement_held");}
/** Actual same-map logical outcome, before revocation deletes the entry. This
 * can mark Retiring only, never Closed or custody/credential discharge. Later
 * operator publication owes this immutable lineage AND real native drains. */
export function retireOriginalHostedDependencyGenerationSourceUse(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state || state.phase===BarrierPhase.Unavailable)return;
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  const selected=findOriginalHostedDependencyGenerationEntry(context,access),purpose=selected.rootPurpose,runtime=purpose?.sessionRuntime,qualification=state.sourceUse.qualification;
  if(!qualification || purpose && !sameDependencyProtectedReference(qualification,purpose.record.qualification))invalid();
  // Absence of purpose in THIS retained map proves runtime/home was never
  // configured; a fresh process cannot reconstruct this from missing records.
  // A completed cold baseline may be revoked before Running. Only the actual
  // private no-runtime state is closable in this phase; unprepared/capturing
  // or credential/home debt is never reconstructed from later process absence.
  if(state.ownerPhase===DependencyOwnerPhase.ExclusiveMutation && (runtime || purpose?.sessionHome))invalid();
  if(selected.generation!==state || (state.phase!==BarrierPhase.Published && state.phase!==BarrierPhase.Retired) || !state.baseline || !state.pending ||
      state.sourceUse.phase!==HostedDependencySourceUsePhase.Live || purpose?.provider || purpose?.preparingHome || purpose?.sessionHome?.leased ||
      runtime && (runtime.use || runtime.idleWrites || runtime.retired && (runtime.retired.phase!==ManagedSessionUsePhase.Complete ||
        runtime.retired.credentialUnknown || runtime.retired.acquiring || runtime.retired.writing || runtime.retired.lease && !runtime.retired.lease.terminal)))invalid();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,state.ownerPhase);
  const bytes=encode({version:1,attempt:actual.attempt,binding:actual.binding,pending:state.pending,
    baseline:state.baseline.baseline,barrier:state.baseline.writerBarrier,qualification,
    lifecycle:runtime?ClosureKind.ConfiguredRuntimeDischarged:ClosureKind.RuntimeNeverConfigured});
  if(bytes.length>16384)invalid();ensureHostedDependencyDirectory(root);
  const path=`${root}/${actual.attempt.launch.startId}.json`;createReadonlyPrivateRecord(path,bytes);
  if(!pinReferenceFile(path,16384).bytes.equals(bytes))invalid();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  const after=findOriginalHostedDependencyGenerationEntry(context,access);
  if(after.generation!==state || after.rootPurpose!==purpose || purpose?.sessionRuntime!==runtime || purpose?.provider || purpose?.preparingHome || purpose?.sessionHome?.leased ||
      runtime && (runtime.use || runtime.idleWrites))invalid();
  assertHostedActivationFence(fence);
  // Synchronous transition blocks this use. The qualifier immediately revokes
  // its actual FDA gate/resources and context before yielding to queued work.
  state.sourceUse.phase=HostedDependencySourceUsePhase.Retiring;state.phase=BarrierPhase.Retiring;
}
