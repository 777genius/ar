/** Actual native C entry and protected provider facts, never a publication grant. */
import assert from "node:assert/strict";
import { HostedActivationPhase } from "../../dist/worker-core/index.js";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation }
  from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { readHostedOrdinaryReaderFinalFacts } from "../../dist/worker-codex/hosted-ordinary-reader-final-facts.js";
import { runHostedRuntimeForeground } from "../../dist/worker-codex/hosted-readonly-foreground.js";
import { readHostedForegroundResultRecord } from "../../dist/worker-codex/hosted-foreground-result.js";
import { loadJobLaunch } from "../../dist/worker-codex/application/codex-goal-job-launch-loader.js";
import { codexGoalStateRootDir, codexGoalWorkerControlService, codexGoalWorkerControlTarget }
  from "../../dist/worker-codex/application/codex-goal-worker-control.js";
import { EntryObservationState, readCurrentEntryContentObservation } from "./current-entry-observations.js";
import { assertRootScope, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { currentFullEnvironment } from "./current-full-env.js";
export enum FullEntryKind { Cold = "cold", Hot = "hot" }
export enum FullRequestPhase { CurrentHot = "current_hot", ReadonlyFirst = "readonly_first", ReadonlyHot = "readonly_hot" }
/** A real registered job defines the inbox/state/workspace. Guidance requests
 * genuinely new disposable work; neither a journal deletion nor a run hook. */
export async function requestCurrentNextWork(roots: CurrentColdHotRoots, phase: FullRequestPhase) {
  assertRootScope(roots);
  const loaded = await loadJobLaunch({ jobId: roots.candidateJobId, registryRootDir: roots.jobRoot + "/state/registry" });
  assert.equal(loaded.manifest.jobId, roots.candidateJobId);
  assert.equal(loaded.launch.config.jobRootDir, roots.jobRoot); assert.equal(loaded.launch.config.workspacePath, roots.workspace);
  assert.equal(codexGoalStateRootDir(loaded.launch), roots.jobRoot + "/state");
  const target = codexGoalWorkerControlTarget(loaded), service = codexGoalWorkerControlService(loaded.launch);
  const body = phase === FullRequestPhase.CurrentHot
    ? "Read the disposable TEST pure linked package index.ts. Report its exported liveRevision after the operator edit. Do not edit files or access credentials."
    : "Inspect the disposable TEST local packages with the configured read-only tools and report their exports. Do not edit files or access credentials.";
  const signal = await service.enqueueSignal({ target, intent: "guidance", deliveryMode: "next_safe_point", body,
    createdBy: "operator", priority: "normal", idempotencyKey: "TEST-full-" + phase });
  return Object.freeze({ signalId: signal.signalId, target, phase });
}
/** No caller JSON can substitute for the original retained FDA result. Both
 * publication and the original provider-final reader independently join it. */
export async function runCurrentOrdinaryEntry(roots: CurrentColdHotRoots, kind: FullEntryKind) {
  assertRootScope(roots); assert.equal(readHostedInstallationActivation().activation.phase, HostedActivationPhase.Ordinary);
  const launch = readHostedReadonlyHostInventory().runtimeLaunch;
  assert.equal(launch.cwd, roots.workspace);
  const result = await runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, currentFullEnvironment());
  assert(typeof result !== "number", "TEST actual retained FDA result required");
  assertHostedForegroundResult(result); assert.equal(result.exitCode, 0);
  const native = readHostedForegroundLaunchObservation(result); assert.equal(native.closeStatus, 0);
  // These public readers each own their actual fence. Never nest either reader.
  const published = readHostedForegroundResultRecord(roots.jobRoot + "/state/TEST-result.json");
  assert.equal(published.value.status, "done"); assert.equal(published.output.exitCode, 0); assert.equal(published.output.unit, native.unit);
  const content = readCurrentEntryContentObservation(roots.candidateJobId, result);
  assert.equal(content.state, EntryObservationState.Measured); assert(content.state === EntryObservationState.Measured);
  assert.equal(content.startId, native.startId); assert.equal(content.invocationId, native.invocationId);
  assert.equal(content.attempted, kind === FullEntryKind.Cold ? 3 : 0);
  assert.equal(content.completed, kind === FullEntryKind.Cold ? 3 : 0);
  assert.equal(content.finalRoot, kind === FullEntryKind.Cold ? 1 : 0);
  const providers = withHostedActivationFence(fence => {
    const actual = readHostedOrdinaryReaderFinalFacts(fence, native.startId);
    assert.equal(actual.reader.startId, native.startId); assert.equal(actual.reader.unit, native.unit);
    assert.equal(actual.attempt.attemptId, content.attemptId); assert.equal(String(actual.attempt.epoch), content.epoch);
    assert(actual.providers.length > 0);
    // The original final reader already revalidates SAME native/provider/HOME/use
    // completion and drain. Export bounded public identity/digests only.
    return actual.providers.map(provider => Object.freeze({startId:provider.member.startId,
      completionSha256:provider.completion.sha256,relationSha256:provider.relation.sha256}));
  });
  return Object.freeze({ result, observation: Object.freeze({kind,startId:native.startId,attemptId:content.attemptId,
    invocationId:native.invocationId,scopeSha256:content.scopeSha256,sourceClosedSha256:content.sourceClosedSha256,
    attempted:content.attempted,completed:content.completed,finalRoot:content.finalRoot,providers:Object.freeze(providers)}) });
}
/** Diagnostic distinctness only, not lifecycle or model availability authority. */
export function assertDistinctCurrentEntries(entries: readonly Awaited<ReturnType<typeof runCurrentOrdinaryEntry>>[]) {
  assert(entries.length >= 2 && entries.length <= 8);
  for (const select of [(entry: (typeof entries)[number]) => entry.observation.startId,
    (entry: (typeof entries)[number]) => entry.observation.attemptId,
    (entry: (typeof entries)[number]) => entry.observation.invocationId])
    assert.equal(new Set(entries.map(select)).size, entries.length);
  const ids = entries.flatMap(entry => entry.observation.providers.map(provider => provider.startId));
  assert.equal(new Set(ids).size, ids.length);
}

/** Actual delivered receipt from the same registered inbox. Never a caller bool. */
export async function assertCurrentNextWorkDelivered(roots:CurrentColdHotRoots, requested:Awaited<ReturnType<typeof requestCurrentNextWork>>) {
  assertRootScope(roots);
  const loaded=await loadJobLaunch({jobId:roots.candidateJobId,registryRootDir:roots.jobRoot+"/state/registry"});
  const target=codexGoalWorkerControlTarget(loaded);assert.deepEqual(target,requested.target);
  const views=await codexGoalWorkerControlService(loaded.launch).listSignals({target,signalIds:[requested.signalId],includeBodies:false,includeExpired:true});
  assert.equal(views.length,1);const view=views[0]!;
  assert.equal(view.signal.signalId,requested.signalId);assert.deepEqual(view.signal.target,target);
  assert(view.state==="delivered" || view.state==="continued" || view.state==="acknowledged");
  assert(view.latestReceipt && view.latestReceipt.signalId===requested.signalId && view.latestReceipt.deliveryAttemptId);
  assert.deepEqual(view.latestReceipt.target,target);
  return Object.freeze({signalId:requested.signalId,deliveryAttemptId:view.latestReceipt.deliveryAttemptId,state:view.state});
}
