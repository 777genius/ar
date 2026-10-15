/** TEST readback only; Unix ownership and the genuine common fence remain required. */
import assert from "node:assert/strict";
import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState } from "../../dist/worker-core/index.js";
import { assertHostedActivationFence, readHostedActivationBytes, type HostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { hostedDependencyJobRoot, hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyEpochStore } from "../../dist/worker-codex/hosted-readonly-epoch-store.js";
import { HostedReadonlyHostKernel } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { createHash } from "node:crypto";
import { parseDependencyOwner, type DependencyOwnerRecord } from "../../dist/core/dependency-environment/dependency-owner.js";
import type { HostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { isDependencyProtectedReference, sameDependencyProtectedReference, type DependencyProtectedReference, isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
/** Pure factual reconciliation only. No result brand, fence or effect is granted. */
export function currentIdleClosureMatches(owner: DependencyOwnerRecord, binding: HostedDependencyBinding,
    idle: unknown, closure: DependencyProtectedReference, startId: string): boolean {
  try {
    if (owner.owner !== null || !isDependencyCustodyObject(idle, "attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") || idle.version !== 1 ||
        !isDependencyCustodyObject(idle.attempt, "attemptId,epoch,launch") || !isDependencyCustodyObject(idle.attempt.launch,
          "bootId,grantDigest,installationId,runtimeSha,startId,unit") && !isDependencyCustodyObject(idle.attempt.launch,
          "association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit")) return false;
    if (idle.attempt.launch.startId !== startId || !encode(idle.binding).equals(encode(binding)) ||
        !encode(parseDependencyOwner(idle.releasedOwner)).equals(encode(owner)) ||
        idle.releasedOwnerSha256 !== createHash("sha256").update(encode(owner)).digest("hex") ||
        typeof idle.previousOwnerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(idle.previousOwnerSha256) ||
        !isDependencyProtectedReference(idle.sourceClosed) || !sameDependencyProtectedReference(idle.sourceClosed, closure)) return false;
    return true;
  } catch { return false; }
}
/** No caller fields/files before original FDA brand. A successful old wait alone
 * is insufficient: CURRENT closed activation, native census and idle owner join. */
export function assertCurrentClosedEntry(fence: HostedActivationFence, jobRoot: string, result: HostedForegroundResult) {
  assertHostedForegroundResult(result); assertHostedActivationFence(fence); assertReadonlyHostOperator();
  const jobId = jobRoot.slice(jobRoot.lastIndexOf("/") + 1);
  assert(/^TEST-os-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(jobId));
  assert.equal(hostedDependencyJobRoot(jobId), jobRoot);
  const native = readHostedForegroundLaunchObservation(result); assert.equal(native.closeStatus, 0); assert.equal(result.exitCode, 0);
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(native.startId));
  const binding = readHostedDependencyBinding(jobId); assert(binding && binding.version === 2); assert.equal(binding.jobRootDir, jobRoot);
  const path = "/var/lib/subscription-runtime-host-policy/dependency-generation-source-closures/" + native.startId + ".json";
  const pin = pinReferenceFile(path, 65536), closed: unknown = JSON.parse(pin.bytes.toString("utf8"));
  assert(isDependencyCustodyObject(closed, "attempt,barrier,baseline,binding,final,pending,retirement,version") && closed.version === 1 ||
    isDependencyCustodyObject(closed, "attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") && closed.version === 2);
  assert(encode(closed).equals(pin.bytes)); assert(encode(closed.binding).equals(encode(binding)));
  assert(isDependencyCustodyObject(closed.attempt, "attemptId,epoch,launch"));
  const launch = closed.attempt.launch;
  assert(isDependencyCustodyObject(launch, "bootId,grantDigest,installationId,runtimeSha,startId,unit") ||
    isDependencyCustodyObject(launch, "association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit"));
  assert.equal(launch.startId, native.startId); assert.equal(launch.unit, native.unit);
  assert.equal(launch.installationId, binding.installationId); assert.equal(launch.runtimeSha, binding.runtimeSha); assert.equal(launch.grantDigest, binding.grantDigest);
  const actual = readHostedInstallationActivation(); assert.equal(actual.activation.phase, HostedActivationPhase.Closed);
  assert(actual.activation.ordinaryStarts.every(row => row.state === HostedCustodyReservationState.Terminal));
  if (readHostedActivationBytes("readonly-enrollment.json")) {
    const epoch = new HostedReadonlyEpochStore().readEpoch();
    assert.equal(epoch.identity.jobRootDir, jobRoot); assert.equal(epoch.phase, HostedCustodyPhase.Closed); assert.equal(epoch.revoked, true);
    assert(epoch.reservations.every(row => row.state === HostedCustodyReservationState.Terminal));
    assert(epoch.outerRuntime === null || epoch.outerRuntime.state === HostedCustodyReservationState.Terminal);
  }
  const owners = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  let owner: DependencyOwnerRecord;
  try { const selected = owners.read(binding.workspace); assert(selected && selected.owner === null); owner = selected; }
  finally { owners.close(); }
  const idlePath = `/var/lib/subscription-runtime-host-policy/dependency-generation-idle-closures/${binding.workspace.dev}-${binding.workspace.ino}/${owner.revision}.json`;
  const idlePin = pinReferenceFile(idlePath, 16384), idle: unknown = JSON.parse(idlePin.bytes.toString("utf8"));
  assert(encode(idle).equals(idlePin.bytes)); assert(currentIdleClosureMatches(owner, binding, idle, pin.reference, native.startId));
  assert(isDependencyCustodyObject(idle, "attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version"));
  assert(encode(idle.attempt).equals(encode(closed.attempt)));
  const kernel = new HostedReadonlyHostKernel(); kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
  const idleAfter = pinReferenceFile(idlePath, 16384); assert(idleAfter.bytes.equals(idlePin.bytes)); assert.deepEqual(idleAfter.reference, idlePin.reference);
  const after = pinReferenceFile(path, 65536); assert(after.bytes.equals(pin.bytes)); assert.deepEqual(after.reference, pin.reference);
  return Object.freeze({ startId: native.startId, sourceClosedSha256: pin.reference.sha256 });
}
