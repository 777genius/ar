import { captureOriginalHostedDependencyColdInstaller, prepareOriginalHostedDependencyColdInstaller, releaseOriginalHostedDependencyColdInstaller,
  completeOriginalHostedDependencyColdInstaller, type HostedDependencyInstallerCompletion } from "./hosted-dependency-installer";
import { produceOriginalHostedDependencyColdTree, readOriginalHostedDependencyColdInstallerMapping } from "./hosted-dependency-materialization";
import { assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyColdState,
  readOriginalHostedDependencyColdInstallerState, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencyColdPhase, HostedDependencyColdInstallerPhase, type HostedDependencyColdReady, type HostedDependencyColdResult } from "./hosted-dependency-cold-materialization-state";
import { OriginalHostedDependencyColdHandoff } from "./hosted-dependency-cold-handoff-view";
import { assertHostedDependencyKeyInputsCurrent, sameHostedDependencyKeyInputs, type HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import { readHostedDependencyBinding, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
import { assertDependencySourceExposureCurrent, assertDependencyLocalRegistrySelectionAbsent, closeDependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import { closeDependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { DependencyAdmissionError, DependencyAdmissionFailure, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { DependencyOwnerPhase, sameDependencyProtectedReference, sameDependencyAttempt } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence } from "./hosted-dependency-activation";
import { type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
/** No map or issuer lives here. Each fixed dispatch must resolve the existing
 * original map through its private lexical access and freshly held fence. */
/** Internal access is lexical; this factual assertion cannot register/replace a
 * result or return the symbol. It selects only the actual in-progress attempt. */
export function assertOriginalHostedDependencyColdProducer(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  const state=findOriginalHostedDependencyColdState(context,access);
  if(!state || state.phase!==HostedDependencyColdPhase.Producing) coldInvalid();
  return readOriginalHostedDependencyColdSelection(context,fence,access);
}
/** Internal factual selection for installer/readback checks. Closed/Held
 * phases cannot regain authority; no public symbol or raw result setter. */
export function readOriginalHostedDependencyColdSelection(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  const state=findOriginalHostedDependencyColdState(context,access);
  if(!state || ![HostedDependencyColdPhase.Producing,HostedDependencyColdPhase.Published,HostedDependencyColdPhase.Consumed].includes(state.phase))coldInvalid();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(!sameDependencyAttempt(actual.attempt,state.attempt) || !encode(actual.binding).equals(encode(state.binding))) coldInvalid();return actual;
}
export async function finishOriginalHostedDependencyColdTree(context:CurrentHostedDependencyOrigin,access:symbol):Promise<Readonly<{startId:string}>|undefined> {
  readOriginalHostedDependencyColdInstallerState(context,access);
  try {
    const result=await produceOriginalHostedDependencyColdTree(context,access);
    const state=findOriginalHostedDependencyColdState(context,access);
    if(!state) {if(result){closeDependencySourceExposure(result.exposure);if(result.source)closeDependencySourceLinkSession(result.source);}coldInvalid();}
    if(result)state.result={...result,ready:freezeFacts(result.ready),reference:freezeFacts(result.reference),installerMapping:Buffer.from(result.installerMapping),
      observed:{...result.observed,entries:freezeFacts(result.observed.entries),canonicalBytes:Buffer.from(result.observed.canonicalBytes),measurement:freezeFacts(result.observed.measurement)}};
    return withHostedActivationFence(fence=>{
      const actual=assertOriginalHostedDependencyColdProducer(context,fence,access),state=readOriginalHostedDependencyColdInstallerState(context,access);
      if(!result) {state.phase=HostedDependencyColdPhase.Closed;return undefined;}
      assertHostedDependencyKeyInputsCurrent(actual.binding,result.inputs);
      const committed=readHostedDependencyCommittedReady(actual.binding,result.ready.revision);
      if(!encode(committed.receipt).equals(encode(result.ready)) || !sameDependencyProtectedReference(committed.reference,result.reference) ||
          !encode(result.observed.tree).equals(encode(result.ready.tree)) || result.observed.digest!==result.ready.manifestDigest) coldInvalid();
      if(!readOriginalHostedDependencyColdInstallerMapping(context,fence,access).equals(result.installerMapping))coldInvalid();
      if(result.source)assertDependencyLocalRegistrySelectionAbsent(result.exposure,result.source,actual.binding.workspace,result.ready.tree);
      else assertDependencySourceExposureCurrent(result.exposure);
      const handle=new OriginalHostedDependencyColdHandoff(actual.attempt.launch.startId,context,access);
      state.handle=handle;Object.freeze(handle);state.phase=HostedDependencyColdPhase.Published;
      return state.handle;
    });
  } catch(error) {const state=findOriginalHostedDependencyColdState(context,access);if(state)state.phase=HostedDependencyColdPhase.Held;throw error;}
}
export async function finishOriginalHostedDependencyColdInstaller(context:CurrentHostedDependencyOrigin,access:symbol):Promise<HostedDependencyInstallerCompletion> {
  const retained=findOriginalHostedDependencyColdState(context,access);if(!retained || retained.phase!==HostedDependencyColdPhase.Producing || retained.installerPhase)coldInvalid();
  const state=withHostedActivationFence(fence=>{
    assertOriginalHostedDependencyColdProducer(context,fence,access);
    const state=readOriginalHostedDependencyColdInstallerState(context,access);if(state.installerPhase)coldInvalid();state.installerPhase=HostedDependencyColdInstallerPhase.Capturing;return state;
  });
  try {
    const capture=await captureOriginalHostedDependencyColdInstaller(context,access);
    const frame=withHostedActivationFence(fence=>{
      assertOriginalHostedDependencyColdProducer(context,fence,access);
      if(findOriginalHostedDependencyColdState(context,access)!==state || state.installerPhase!==HostedDependencyColdInstallerPhase.Capturing)coldInvalid();
      state.installerCapture=capture;
      const frame=prepareOriginalHostedDependencyColdInstaller(context,fence,access);
      // No await or caller boundary separates real spawn and sole-map custody.
      state.installerFrame=frame;state.installerPhase=HostedDependencyColdInstallerPhase.Prepared;return frame;
    });
    const guard=frame.guard;if(!guard)coldInvalid();await guard.observe();
    await retryHostedFenceAcquisition(()=>withHostedActivationFence(fence=>{
      assertOriginalHostedDependencyColdProducer(context,fence,access);
      if(findOriginalHostedDependencyColdState(context,access)!==state || state.installerFrame!==frame || state.installerPhase!==HostedDependencyColdInstallerPhase.Prepared)coldInvalid();
      releaseOriginalHostedDependencyColdInstaller(context,fence,access);state.installerPhase=HostedDependencyColdInstallerPhase.Released;
    }),guard.remainingSetupMs());
    if(!await frame.waited)coldInvalid();
    if(findOriginalHostedDependencyColdState(context,access)!==state || state.installerFrame!==frame || findOriginalHostedDependencyColdState(context,access)?.installerPhase!==HostedDependencyColdInstallerPhase.Released)coldInvalid();
    state.installerPhase=HostedDependencyColdInstallerPhase.Waited;
    return withHostedActivationFence(fence=>{
      assertOriginalHostedDependencyColdProducer(context,fence,access);
      if(findOriginalHostedDependencyColdState(context,access)!==state || state.installerFrame!==frame || state.installerPhase!==HostedDependencyColdInstallerPhase.Waited)coldInvalid();
      return completeOriginalHostedDependencyColdInstaller(context,fence,access);
    });
  } catch(error) {
    const frame=state.installerFrame;state.installerPhase=HostedDependencyColdInstallerPhase.Held;state.phase=HostedDependencyColdPhase.Held;
    try {frame?.guard?.invalidate();}catch { /* The actual owner/output stays held; no successful discharge is inferred. */ }
    throw error;
  }
}
function coldState(handle:unknown,access:symbol) {
  const context=OriginalHostedDependencyColdHandoff.resolve(handle,access),state=context&&findOriginalHostedDependencyColdState(context,access);
  if(!context || !state || state.handle!==handle || !state.result) coldInvalid();return {context,state,result:state.result};
}
function assertColdState(handle:unknown,fence:HostedActivationFence,access:symbol) {
  const held=coldState(handle,access),actual=assertCurrentHostedDependencyAttempt(held.context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(!sameDependencyAttempt(actual.attempt,held.state.attempt) || !encode(actual.binding).equals(encode(held.state.binding)) ||
      !encode(readHostedDependencyBinding(actual.binding.jobId)).equals(encode(held.state.binding))) coldInvalid();
  if(!readOriginalHostedDependencyColdInstallerMapping(held.context,fence,access).equals(held.result.installerMapping))coldInvalid();
  assertHostedDependencyKeyInputsCurrent(actual.binding,held.result.inputs);
  if(!sameDependencyProtectedReference(readHostedDependencyCommittedReady(actual.binding,held.result.ready.revision).reference,held.result.reference)) coldInvalid();
  if(held.result.source)assertDependencyLocalRegistrySelectionAbsent(held.result.exposure,held.result.source,actual.binding.workspace,held.result.ready.tree);
  else assertDependencySourceExposureCurrent(held.result.exposure);
  return held;
}
export function consumeOriginalHostedDependencyColdHandoff(handle:Readonly<{startId:string}>,binding:HostedDependencyBinding,
  attempt:DependencyAttempt,inputs:HostedDependencyKeyInputs,ready:HostedDependencyColdReady,access:symbol):Pick<HostedDependencyColdResult,"observed"|"reference"|"exposure"|"source"> {
  coldState(handle,access); // Counterfeit/unissued view refuses before fence/record IO.
  return withHostedActivationFence(fence=>{
    const held=assertColdState(handle,fence,access);
    if(held.state.phase!==HostedDependencyColdPhase.Published || !sameDependencyAttempt(attempt,held.state.attempt) ||
        !encode(binding).equals(encode(held.state.binding)) || !sameHostedDependencyKeyInputs(inputs,held.result.inputs) || !encode(ready).equals(encode(held.result.ready))) coldInvalid();
    if(assertColdState(handle,fence,access).state!==held.state)coldInvalid();
    held.state.phase=HostedDependencyColdPhase.Consumed;
    return {observed:{...held.result.observed,canonicalBytes:Buffer.from(held.result.observed.canonicalBytes)},reference:held.result.reference,
      exposure:held.result.exposure,...(held.result.source?{source:held.result.source}:{})};
  });
}
export function assertOriginalHostedDependencyConsumedColdHandoff(handle:Readonly<{startId:string}>,fence:HostedActivationFence,access:symbol):void {
  const held=assertColdState(handle,fence,access);if(held.state.phase!==HostedDependencyColdPhase.Consumed)coldInvalid();
}
export function closeOriginalHostedDependencyColdHandoff(handle:Readonly<{startId:string}>|undefined,access:symbol):void {
  if(!handle)return;
  const context=OriginalHostedDependencyColdHandoff.resolve(handle,access);
  if(!context)return;
  let state:ReturnType<typeof findOriginalHostedDependencyColdState>;
  try {state=findOriginalHostedDependencyColdState(context,access);}catch {return;} // No IO occurs in this private-symbol/map lookup.
  if(!state || state.handle!==handle || state.phase===HostedDependencyColdPhase.Closed)return;
  const consumed=state.phase===HostedDependencyColdPhase.Consumed;state.phase=HostedDependencyColdPhase.Closed;
  if(!consumed && state.result) {closeDependencySourceExposure(state.result.exposure);if(state.result.source)closeDependencySourceLinkSession(state.result.source);}
}
function coldInvalid():never {throw new DependencyAdmissionError(DependencyAdmissionFailure.StaleAttempt);}

export function revokeOriginalHostedDependencyColdState(context:CurrentHostedDependencyOrigin,access:symbol):void {
  const state=findOriginalHostedDependencyColdState(context,access);let failure:unknown;
  const installer=state?.installerFrame;
  if(state?.installerPhase)state.installerPhase=HostedDependencyColdInstallerPhase.Held;
  if(installer?.guard) {try {installer.guard.invalidate();}catch(error){failure=error;}}
  const coldResult=state?.result;
  if(state)state.phase=HostedDependencyColdPhase.Held;
  if(coldResult) {
    try {closeDependencySourceExposure(coldResult.exposure);if(coldResult.source)closeDependencySourceLinkSession(coldResult.source);} catch(error){failure=error;}
  }
  if(failure!==undefined)throw failure;
}
