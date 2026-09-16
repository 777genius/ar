import { assertExclusiveHostedActivation } from "./hosted-installation-activation";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { HostedCustodyPhase, HostedCustodyReservationState, HostedCustodySupervisor, reserveHostedOuterRuntime, terminalHostedOuterRuntime, type HostedCustodyEpoch,
  type HostedCustodyIdentity, type HostedCustodyReservation, type HostedCustodySupervisorPort,
} from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId, assertHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { decodePrivateJson, readReadonlyManagedGrant, readReadonlyReview, readonlyIdentityName } from "./hosted-readonly-authority";
import { readHostedPrivateBytes, readHostedReadonlyPolicy } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, readonlyCustodyRoot, readonlyCustodySnapshot, readonlyRevokedRoot, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { completionBytes, completionPath, HostedReadonlyHostKernel, type HostedWaitStatus } from "./hosted-readonly-host-kernel";

/** Production composition, deliberately without an injected authority, inventory
 * callback, storage path or process factory. Test substitutes live OS facts at
 * the filesystem/process adapter boundaries, never through launch arguments. */
export class HostedReadonlySupervisorHost implements HostedCustodySupervisorPort {
  private runtimeGeneration: number | undefined;
  private runtimeStartId: string | undefined;
  private readonly store = new HostedReadonlyEpochStore();
  private readonly kernel = new HostedReadonlyHostKernel();
  private activationFence: HostedActivationFence | undefined;
  serialized<T>(action: () => T): T { return this.store.serialized(action); }
  recoverSerialized<T>(action: () => T): T {
    return this.activationFence ? this.store.withHeldFence(this.activationFence, action, true) : this.store.recoverSerialized(action);
  }
  recoverWithHeldFence(fence: HostedActivationFence, identity: HostedCustodyIdentity): void {
    assertHostedActivationFence(fence);
    if (this.activationFence) throw new Error("hosted_custody_common_fence_required");
    this.activationFence = fence;
    try { new HostedCustodySupervisor(this).recover(identity); }
    finally { this.activationFence = undefined; }
  }
  readEpoch(): HostedCustodyEpoch { return this.store.readEpoch(); }
  publishEpoch(epoch: HostedCustodyEpoch): void { this.store.publishEpoch(epoch); }
  session() { return this.kernel.session(); }
  verifyExclusiveInventory(): void { this.kernel.verifyExclusiveInventory(); }
  runtimeRole() { return this.kernel.runtimeRole(); }
  verifyRuntimeOwner(): void { assertExclusiveHostedActivation(this.readEpoch()); this.kernel.verifyRuntimeOwner(); }
  verifyDescriptorBoundary(): void { this.kernel.verifyDescriptorBoundary(); }
  fenceCreator(reservation: HostedCustodyReservation, boot: string): void { this.kernel.fenceCreator(reservation, boot); }
  drainQueuedStart(reservation: HostedCustodyReservation): void { this.kernel.drainQueuedStart(reservation); }
  confirmTerminalDescendants(reservation: HostedCustodyReservation): void { this.kernel.confirmTerminalDescendants(reservation); }
  requestStop(reservation: HostedCustodyReservation): void { this.kernel.requestStop(reservation); }
  verifyReadonlyMaterial(identity: HostedCustodyIdentity): void {
    const material = readHostedReadonlyPolicy(identity.jobId);
    if (!material || readHostedPrivateBytes(join(readonlyRevokedRoot, readonlyIdentityName(identity.jobId)), 4096)) denied();
    const review = readReadonlyReview(material.policy);
    const actual: HostedCustodyIdentity = {
      jobId: material.policy.jobId, jobRootDir: material.policy.jobRootDir, workspacePath: material.policy.workspacePath,
      runtimeSha: material.policy.runtimeSha, runtimeManifestSha256: material.policy.runtimeManifestSha256,
      issuerDeploymentDigest: material.policy.issuerDeploymentDigest,
      policySha256: hash(material.bytes), reviewSha256: hash(review.reviewBytes), stageSha256: hash(review.stageBytes),
      grantSha256: hash(readReadonlyManagedGrant(identity)),
    };
    if (Object.keys(actual).some(key => actual[key as keyof HostedCustodyIdentity] !== identity[key as keyof HostedCustodyIdentity])) denied();
    // Structural custody remains independently necessary alongside the global
    // inventory fence; the original issuer still verifies complete input bytes.
    const lease = readHostedPrivateBytes(join(readonlyCustodyRoot, readonlyIdentityName(identity.jobId)), 4096);
    const expectedLease = { schemaVersion: 1, jobId: identity.jobId,
      policySha256: actual.policySha256, reviewSha256: actual.reviewSha256, stageSha256: actual.stageSha256,
      snapshot: readonlyCustodySnapshot(material.policy) };
    if (!lease || JSON.stringify(decodePrivateJson(lease)) !== JSON.stringify(expectedLease)) denied();
  }

  assertManagedAdmission(identity: HostedTestEgressIdentity, profile: CodexProviderEgressProfileId): HostedCustodyEpoch {
    const epoch = this.readEpoch(), session = this.session();
    if (profile !== CodexProviderEgressProfileId.TestManagedQualification || epoch.phase !== HostedCustodyPhase.Ready ||
        epoch.revoked || epoch.hostId !== session.hostId || epoch.bootId !== session.bootId ||
        epoch.supervisorId !== session.supervisorId || epoch.identity.jobId !== identity.jobId ||
        epoch.identity.jobRootDir !== identity.jobRootDir || epoch.identity.workspacePath !== identity.workspacePath) denied();
    this.verifyRuntimeOwner();
    this.verifyReadonlyMaterial(epoch.identity);
    return epoch;
  }
  /** Authenticated stop requests close admission first; they do not assert
   * terminal descendants or erase reservations. */
  stopRuntime(identity: HostedTestEgressIdentity): void {
    const retained = this.serialized(() => {
      this.runtimeRole();
      const epoch = this.readEpoch();
      if (epoch.identity.jobId !== identity.jobId || epoch.identity.jobRootDir !== identity.jobRootDir ||
          epoch.identity.workspacePath !== identity.workspacePath) denied();
      this.publishEpoch({ ...epoch, phase: HostedCustodyPhase.Closed });
      return [...epoch.reservations, ...(epoch.outerRuntime ? [epoch.outerRuntime] : [])];
    });
    let failed = false;
    for (const record of retained) {
      if (record.state === HostedCustodyReservationState.Terminal) continue;
      try { this.requestStop(record); } catch { failed = true; }
    }
    if (failed) throw new Error("hosted_custody_stop_incomplete");
  }
  runRuntimeLaunch<T>(command: string, args: readonly string[], cwd: string, submit: (launch: { command: string; args: readonly string[] }) => T): T {
    if (this.runtimeGeneration !== undefined) throw new Error("hosted_custody_runtime_already_submitted");
    return this.serialized(() => {
      let epoch = this.readEpoch();
      try {
        if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked ||
            epoch.reservations.some(record => record.state !== HostedCustodyReservationState.Terminal)) denied();
        assertExclusiveHostedActivation(epoch);
        this.kernel.assertRuntimeLaunch(epoch, command, args, cwd);
        this.verifyReadonlyMaterial(epoch.identity);
        this.verifyExclusiveInventory();
        this.verifyDescriptorBoundary();
        const startId = randomUUID();
        const record = { startId, creatorId: startId, unit: `subscription-runtime-outer-${startId}.service` };
        const launch = this.kernel.runtimeInvocation(record, command, args, cwd);
        epoch = reserveHostedOuterRuntime(epoch, record);
        this.publishEpoch(epoch);
        // Permanent per-start birth prevents a UUID reuse from reusing an old
        // completion receipt after the compact outer record rotates generations.
        createReadonlyPrivateRecord(join(readonlySupervisorRoot, `readonly-outer-start-${startId}.json`),
          Buffer.from(JSON.stringify({ schemaVersion: 1, hostId: epoch.hostId, bootId: epoch.bootId,
            jobId: epoch.identity.jobId, generation: epoch.generation, ...record }) + "\n"));
        this.runtimeGeneration = epoch.generation;
        this.runtimeStartId = startId;
        return submit(launch);
      } catch (error) {
        this.publishEpoch({ ...epoch, phase: HostedCustodyPhase.Closed });
        throw error;
      }
    });
  }
  /** Outer exit/cancellation closes future admission before stop requests. This
   * never treats the wrapper/child exit as terminal proof for a hosted unit.
   * A delayed callback from an older generation cannot close a recovered epoch. */
  closeRuntimeLaunch(): void {
    const generation = this.runtimeGeneration;
    if (generation === undefined) throw new Error("hosted_custody_runtime_not_started");
    const retained = this.serialized(() => {
      const epoch = this.readEpoch();
      if (!epoch.outerRuntime || epoch.outerRuntime.startId !== this.runtimeStartId ||
          (epoch.outerRuntime.state === HostedCustodyReservationState.Terminal && epoch.generation !== generation)) return [];
      this.publishEpoch({ ...epoch, phase: HostedCustodyPhase.Closed });
      return [...epoch.reservations, epoch.outerRuntime];
    });
    // Closing is durable before unlocked OS stops. A completion callback must
    // be able to acquire the common fence; unit births cannot target successors.
    let failed = false;
    for (const reservation of retained) {
      if (reservation.state === HostedCustodyReservationState.Terminal) continue;
      try { this.requestStop(reservation); } catch { failed = true; }
    }
    if (failed) throw new Error("hosted_custody_runtime_stop_incomplete");
  }
  recordRuntimeWaitCompletion(): void {
    if (this.runtimeStartId === undefined) throw new Error("hosted_custody_runtime_not_started");
    this.serialized(() => {
      const epoch = this.readEpoch(), record = epoch.outerRuntime;
      if (!record || record.startId !== this.runtimeStartId) return;
      createReadonlyPrivateRecord(completionPath(record), completionBytes(record, 0));
      this.kernel.fenceCreator(record, epoch.bootId);
      this.kernel.drainQueuedStart(record);
      this.kernel.confirmTerminalDescendants(record);
      this.publishEpoch(terminalHostedOuterRuntime(epoch, record.startId));
    });
  }
  recordWaitCompletion(reservation: Omit<HostedCustodyReservation, "state">, status: HostedWaitStatus): void {
    this.serialized(() => createReadonlyPrivateRecord(completionPath(reservation), completionBytes(reservation, status)));
    new HostedCustodySupervisor(this).reconcile(reservation.startId);
  }
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function denied(): never { throw new Error("hosted_custody_admission_denied"); }
