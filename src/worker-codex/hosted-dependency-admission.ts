import { prepareHostedDependencyRootHelpers } from "./hosted-dependency-root-preparation";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { claimDependencyConsumer, markDependencyConsumerRunning, DependencyAdmissionError,
  DependencyAdmissionFailure as Failure, DependencyOwnerPhase, DependencyReceiptState, DependencyTreeObservationStatus, type DependencyAttempt, isDependencyConsumerOwner } from "@vioxen/subscription-runtime/worker-core";
import { sameDependencyAttempt } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence, CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { armCurrentHostedDependencyGenerationBarrier, markCurrentHostedDependencyGenerationRunning, enterCurrentHostedOrdinaryDependencyReader, consumeCurrentHostedOrdinaryDependencyExecution, readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyOrigin, assertCurrentHostedDependencyAttempt,
  isCurrentHostedDependencyManagedReadonlyOrigin, isHostedManagedReadonlyOuterRuntime, readHostedDependencyRootGitConfigPin, CurrentHostedDependencyOriginKind } from "./hosted-current-dependency-origin";
import { consumeHostedReadonlyDependencyPreclaim, readHostedReadonlyDependencyPreclaim, publishHostedReadonlyDependencyReaderReady } from "./hosted-readonly-dependency-reader-entry";
import { readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { assertHostedDependencyQualifiedInventory, assertHostedDependencyPhysicalWorkspace, hostedDependencyOwnerRoot, isHostedDependencyWorkspace,
  readHostedDependencyBinding, readHostedDependencyAttempt, assertHostedDependencyStartAllowed } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { qualifyHostedDependencyToolClosure, assertHostedDependencyQualifiedToolEntry, markHostedDependencyQualifiedToolEntryRunning,
  invalidateHostedDependencyQualifiedToolEntry, type HostedDependencyQualifiedToolEntry } from "./hosted-dependency-tool-profile";
import { hasHostedDependencyFreshAbsence, materializeHostedDependencyAbsenceForToolEntry, closeHostedDependencyColdHandoff, type HostedDependencyColdHandoff, matchesHostedDependencyReady,
  readHostedDependencyReceipt, hostedDependencyObservationLimits, readHostedDependencyKeyInputs,
  assertHostedDependencyKeyInputsCurrent } from "./hosted-dependency-materialization";

/** First supported profile: safe warm TEST reuse and fresh script-free npm.
 * Actual origin and private grant decide authority; request config carries none.
 */
export async function admitHostedDependencyConsumer(config: CodexGoalRunConfig): Promise<DependencyAttempt | undefined> {
  return (await admitHostedDependencyEntry(config))?.attempt;
}
/** Internal worker composition retains the qualifier's one real context.
 * The public attempt-only wrapper cannot reconstruct or convey that relation. */
export async function admitHostedDependencyEntry(config: CodexGoalRunConfig): Promise<Readonly<{
  attempt: DependencyAttempt; toolEntry?: HostedDependencyQualifiedToolEntry;
}> | undefined> {
  const selected = isHostedDependencyWorkspace(config.workspacePath);
  const managed = isHostedManagedReadonlyOuterRuntime() && withHostedActivationFence(fence => isCurrentHostedDependencyManagedReadonlyOrigin(fence));
  if (!isHostedOrdinaryRuntime() && !managed) {
    if (selected) fail(Failure.Unsupported);
    return undefined;
  }
  enterCurrentHostedOrdinaryDependencyReader();
  const context = withHostedActivationFence(fence => readCurrentHostedDependencyOrigin(fence));
  const held = withHostedActivationFence(fence => assertCurrentHostedDependencyOrigin(context,fence));
  const actualSelected = isHostedDependencyWorkspace(held.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ?
    held.binding.workspace.canonicalPath : String(held.ordinary.start.workspacePath));
  if (!actualSelected && !selected) return undefined;
  // Keep the ordinary initial-host principal guard intact. These finite paths
  // are hidden from old managed payloads, not selected by env or model options.
  const admission = withHostedActivationFence(fence => {
    const current = assertCurrentHostedDependencyOrigin(context,fence);
    const readonly = current.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal;
    const logicalJobId = readonly ? current.binding.jobId : String(current.ordinary.start.jobId);
    const root = readonly ? current.binding.jobRootDir : String(current.ordinary.start.jobRootDir);
    const workspace = readonly ? current.binding.workspace.canonicalPath : String(current.ordinary.start.workspacePath);
    if ((!readonly && current.ordinary.profileId !== CodexProviderEgressProfileId.TestNpmQualification) || !actualSelected ||
        workspace !== config.workspacePath || root !== config.jobRootDir || logicalJobId !== (config.jobId ?? config.taskId) ||
        (config.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
        config.allowDangerFullAccess || config.providerSandboxMode === "danger-full-access" ||
        config.childLifetime || config.checkpointPublisherSocketPath) fail(Failure.Unsupported);
    if (config.runtimeHomeRootDir !== undefined && config.runtimeHomeRootDir !== `${config.jobRootDir}/home`) fail(Failure.Unsupported);
    const binding = readonly ? current.binding : readHostedDependencyBinding(logicalJobId);
    if (!binding || (!readonly && (binding.grantDigest !== current.ordinary.start.grantSha256 ||
        binding.installationId !== current.ordinary.start.installationId))) fail(Failure.Unsupported);
    if (binding.version === 3) fail(Failure.Unsupported);
    assertHostedDependencyQualifiedInventory();
    assertHostedDependencyPhysicalWorkspace(binding);
    assertHostedDependencyStartAllowed(readonly ? current.start.startId : String(current.ordinary.reservation.startId));
    const preclaimed = readonly ? consumeHostedReadonlyDependencyPreclaim(context,fence) :
      binding.version === 2 ? consumeCurrentHostedOrdinaryDependencyExecution(fence) : undefined;
    if(binding.version===2)armCurrentHostedDependencyGenerationBarrier(context,fence);
    assertManagedDependencyGitInputs(binding.workspace.canonicalPath);
    const receipt = readonly ? readHostedDependencyEstablishedReceipt(binding) : readHostedDependencyReceipt(binding);
    if (receipt?.state === DependencyReceiptState.Installing || receipt?.state === DependencyReceiptState.Evicting) fail(Failure.Busy);
    let tree, absent = false;
    try { tree = lstatSync(`${binding.workspace.canonicalPath}/node_modules`); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (receipt ? receipt.state !== DependencyReceiptState.Absent : !hasHostedDependencyFreshAbsence(binding)) fail(Failure.NeedsInstall);
      absent = true;
    }
    if (tree && (!tree.isDirectory() || tree.isSymbolicLink())) fail(Failure.UnsafeTree);
    if (tree && receipt?.state === DependencyReceiptState.Absent) fail(Failure.UnsafeTree);
    const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
    try {
      const attempt = readonly || binding.version === 2 ? (preclaimed ?? fail(Failure.StaleAttempt)) : claimDependencyConsumer(store,binding.workspace,{
        installationId:binding.installationId,bootId:String(current.ordinary.start.bootId),runtimeSha:binding.runtimeSha,
        grantDigest:binding.grantDigest,startId:String(current.ordinary.reservation.startId),unit:String(current.ordinary.start.unit),
      },randomUUID());
      return { binding, attempt, absent, receipt };
    } finally { store.close(); }
  });
  // Capture safety while durable ExclusiveMutation prevents other managed
  // consumers/materializers. Incomplete capture stays held, never legacy reuse.
  const readyInputs = admission.binding.version === 1 && !admission.absent && admission.receipt?.state === DependencyReceiptState.Ready
    ? await readHostedDependencyKeyInputs(admission.binding) : undefined;
  let coldHandoff: HostedDependencyColdHandoff | undefined;
  if (admission.absent) coldHandoff = await materializeHostedDependencyAbsenceForToolEntry(admission.binding, admission.attempt,context);
  else if (admission.binding.version === 1 && (!readyInputs || admission.receipt?.state !== DependencyReceiptState.Ready ||
      !matchesHostedDependencyReady(admission.binding, admission.receipt, readyInputs))) {
    const observation = await observeDependencyTree({ workspacePath: admission.binding.workspace.canonicalPath,
      treeName: "node_modules", expectedWorkspace: admission.binding.workspace, limits: hostedDependencyObservationLimits });
    if (observation.status !== DependencyTreeObservationStatus.Complete) fail(Failure.UnsafeTree);
  }
  // Explicit N3 profile only: authenticate its installed executable graph while
  // still exclusive. Generic Ready reuse keeps its existing hash-free path.
  let toolEntry: HostedDependencyQualifiedToolEntry | undefined;
  try { toolEntry = await qualifyHostedDependencyToolClosure(admission.binding, admission.attempt, coldHandoff,context); }
  finally { closeHostedDependencyColdHandoff(coldHandoff); }
  if (admission.binding.version === 2 && !toolEntry) fail(Failure.Unsupported);
  try {
  withHostedActivationFence(fence => {
    const current = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if (!sameDependencyAttempt(current.attempt,admission.attempt) ||
        JSON.stringify(current.binding) !== JSON.stringify(admission.binding)) fail(Failure.StaleAttempt);
    if (readyInputs) assertHostedDependencyKeyInputsCurrent(admission.binding, readyInputs);
    if (toolEntry) assertHostedDependencyQualifiedToolEntry(toolEntry, fence, DependencyOwnerPhase.ExclusiveMutation);
    if (toolEntry) {
      publishHostedReadonlyDependencyReaderReady(context,fence);
      prepareHostedDependencyRootHelpers(fence);
    }
    if(admission.binding.version===2)markCurrentHostedDependencyGenerationRunning(context,fence);
    else {
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try { markDependencyConsumerRunning(store, admission.binding.workspace, admission.attempt, String(Date.now())); }
      finally { store.close(); }
    }
    if (toolEntry) markHostedDependencyQualifiedToolEntryRunning(toolEntry, fence);
  });
  return Object.freeze({ attempt: admission.attempt, ...(toolEntry ? { toolEntry } : {}) });
  } catch (error) { invalidateHostedDependencyQualifiedToolEntry(toolEntry); throw error; }
}

/** A project cannot configure executable filters/hooks/fsmonitor for privileged
 * host hygiene. Provider .git is OS read-only; host global config is disabled.
 */
export function assertManagedDependencyGitInputs(workspacePath: string): void {
  readHostedDependencyRootGitConfigPin(workspacePath);
}
/** Mandatory direct-library/prewarm entry, separate from the legacy optional
 * provider callback. A path or a fabricated config cannot mint host authority. */
export function assertHostedDependencyExecutionWorkspace(workspacePath: string | undefined): void {
  // Actual reference purpose vetoes every direct-library/prewarm/provider call,
  // including one hiding the selected workspace behind an absent/foreign cwd.
  if (!isHostedOrdinaryRuntime() && !isHostedManagedReadonlyOuterRuntime()) {
    if (workspacePath !== undefined && isHostedDependencyWorkspace(workspacePath)) fail(Failure.Unsupported);
    return;
  }
  withHostedActivationFence(fence => {
    const readonly = isCurrentHostedDependencyManagedReadonlyOrigin(fence);
    if (!readonly && !isHostedOrdinaryRuntime()) {
      if (workspacePath !== undefined && isHostedDependencyWorkspace(workspacePath)) fail(Failure.Unsupported);
      return;
    }
    const context = readCurrentHostedDependencyOrigin(fence), current = assertCurrentHostedDependencyOrigin(context,fence);
    if (current.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) {
      if (workspacePath !== undefined && workspacePath !== current.binding.workspace.canonicalPath) fail(Failure.Unsupported);
      if (!isDependencyConsumerOwner(current.owner.owner) || current.owner.owner.phase === DependencyOwnerPhase.Fenced) fail(Failure.Unsupported);
      readHostedReadonlyDependencyPreclaim(context,fence,current.owner.owner.phase);
      return;
    }
    const origin = current.ordinary, binding = readHostedDependencyBinding(String(origin.start.jobId));
    if (binding?.version === 3) fail(Failure.Unsupported);
    if (workspacePath === undefined || !isHostedDependencyWorkspace(workspacePath)) return;
    if (origin.profileId !== CodexProviderEgressProfileId.TestNpmQualification || origin.start.workspacePath !== workspacePath ||
        !binding || binding.workspace.canonicalPath !== workspacePath) fail(Failure.Unsupported);
    readHostedDependencyAttempt(binding,origin.start,String(origin.reservation.startId));
  });
}
function fail(reason: Failure): never { throw new DependencyAdmissionError(reason); }
