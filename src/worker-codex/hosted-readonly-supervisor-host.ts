import { startCurrentHostedOrdinaryDependencySessionBootstrap } from "./hosted-ordinary-dependency-provider";
import { preclaimHostedReadonlyDependencyReader } from "./hosted-readonly-dependency-reader-entry";
import { CurrentHostedDependencyOriginKind, publishCurrentHostedManagedDependencyProvider, readCurrentHostedManagedDependencyProviderParent, spawnCurrentHostedManagedDependencyProvider, observeCurrentHostedManagedDependencyProviderFrame, remainingCurrentHostedManagedDependencyProviderSetup, releaseCurrentHostedManagedDependencyProviderFrame, invalidateCurrentHostedManagedDependencyProvider, readCurrentHostedDependencySessionRefreshParent, spawnCurrentHostedDependencySessionRefresh, spawnCurrentHostedDependencySessionModelProbe, observeCurrentHostedDependencySessionRefreshFrame, releaseCurrentHostedDependencySessionRefreshFrame, invalidateCurrentHostedDependencySessionRefresh, type CurrentHostedDependencySessionHome, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import type { CodexAppServerChildProcess } from "../provider-codex/app-server/application/app-server-process-port";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { assertHostedManagedDependencyToolParentFrame } from "./hosted-managed-dependency-tool-plan";
import { assertHostedReadonlyDependencyReadyPublication } from "./hosted-readonly-dependency-publication";
import { isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { parseHostedReadonlyDependencyStart, readonlyDependencyStartName } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { readHostedReadonlyDependencyMaterial, readonlyDependencyMaterialDigests } from "./hosted-readonly-dependency-records";
import { assertExclusiveHostedActivation } from "./hosted-installation-activation";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { HostedCustodyPhase, HostedCustodyReservationState, HostedCustodySupervisor, HostedCustodyLaunchKind, reserveHostedOuterRuntime, terminalHostedOuterRuntime, type HostedCustodyEpoch,
  type HostedCustodyIdentity, type HostedCustodyReservation, type HostedCustodySupervisorPort,
} from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId, assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { decodePrivateJson, readReadonlyManagedGrant, readReadonlyReview, readonlyIdentityName } from "./hosted-readonly-authority";
import { readHostedPrivateBytes, readHostedReadonlyPolicy } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, readonlyCustodyRoot, readonlyCustodySnapshot, readonlyRevokedRoot, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { completionBytes, completionPath, HostedReadonlyHostKernel, readHostedReadonlyHostInventory, type HostedWaitStatus } from "./hosted-readonly-host-kernel";
import { assertHostedForegroundResult, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";

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
    if (this.activationFence) return this.store.withHeldFence(this.activationFence, action, true);
    return withHostedActivationFence(fence => {
      this.activationFence = fence;
      try { return this.store.withHeldFence(fence, action, true); }
      finally { this.activationFence = undefined; }
    });
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
  fenceCreator(reservation: HostedCustodyReservation, boot: string): void { this.kernel.fenceCreator(reservation, boot, this.activationFence); }
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
        if (isHostedDependencyWorkspace(epoch.identity.workspacePath)) {
          assertHostedReadonlyDependencyReadyPublication(this.store.publicationFence(), epoch);
        }
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
        if (isHostedDependencyWorkspace(epoch.identity.workspacePath)) {
          const material = readHostedReadonlyDependencyMaterial(this.store.publicationFence(), epoch.identity);
          const evidence = parseHostedReadonlyDependencyStart({ version: 1, ...material.evidence.installation,
            hostId: epoch.hostId, bootId: epoch.bootId, supervisorId: epoch.supervisorId,
            generation: epoch.generation, ...record, association: material.reference,
            candidateJobId: material.evidence.candidate.jobId, readonlyJobId: epoch.identity.jobId,
            jobRootDir: epoch.identity.jobRootDir, workspace: material.evidence.workspace,
            ...readonlyDependencyMaterialDigests(material.evidence) });
          createReadonlyPrivateRecord(join(readonlySupervisorRoot, readonlyDependencyStartName(startId)),
            Buffer.from(JSON.stringify(evidence) + "\n"));
          preclaimHostedReadonlyDependencyReader(this.store.publicationFence(),startId);
        }
        this.runtimeGeneration = epoch.generation;
        this.runtimeStartId = startId;
        return submit(launch);
      } catch (error) {
        this.publishEpoch({ ...epoch, phase: HostedCustodyPhase.Closed });
        throw error;
      }
    });
  }
  releaseRuntimeFrame(frame: string | Buffer, release: (fence: HostedActivationFence, revalidate: () => void) => void): void {
    withHostedActivationFence(fence => this.store.withHeldFence(fence, () => {
      const revalidate = () => {
      const epoch = this.readEpoch(), record = epoch.outerRuntime;
      if (!record || record.state !== HostedCustodyReservationState.Reserved || record.startId !== this.runtimeStartId ||
          epoch.generation !== this.runtimeGeneration || epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked) denied();
      assertExclusiveHostedActivation(epoch);
      const session = this.session();
      if (session.hostId !== epoch.hostId || session.bootId !== epoch.bootId || session.supervisorId !== epoch.supervisorId) denied();
      this.verifyReadonlyMaterial(epoch.identity);
      const bytes = readHostedPrivateBytes(join(readonlySupervisorRoot, `readonly-outer-start-${record.startId}.json`), 4096);
      const expected = { schemaVersion: 1, hostId: epoch.hostId, bootId: epoch.bootId,
        jobId: epoch.identity.jobId, generation: epoch.generation, startId: record.startId, creatorId: record.creatorId, unit: record.unit };
      if (!bytes || JSON.stringify(decodePrivateJson(bytes)) !== JSON.stringify(expected)) denied();
      if (isHostedDependencyWorkspace(epoch.identity.workspacePath)) assertHostedManagedDependencyToolParentFrame(fence,record.unit,frame);
      };
      revalidate(); release(fence, revalidate);
    }));
  }
  releaseProviderFrame(unit: string, identity: HostedTestEgressIdentity, release: (fence: HostedActivationFence, revalidate: () => void) => void): void {
    withHostedActivationFence(fence => this.store.withHeldFence(fence, () => {
      const revalidate = () => {
      const epoch = this.assertManagedAdmission(identity, CodexProviderEgressProfileId.TestManagedQualification);
      const record = epoch.reservations.find(record => record.unit === unit);
      if (!record || record.state !== HostedCustodyReservationState.Reserved) denied();
      };
      revalidate(); release(fence, revalidate);
    }));
  }
  /** Called synchronously from the existing reserved-provider submit closure.
   * The store's actual held publication fence cannot be supplied by a caller. */
  publishDependencyProviderStart(context: CurrentHostedDependencyOrigin, unit: string): void {
    publishCurrentHostedManagedDependencyProvider(context,this.store.publicationFence(),unit);
  }
  /** Fixed concrete adapter call while the actual reservation fence is held.
   * Neither a fence nor a process callback escapes to the worker factory. */
  spawnDependencyProvider(context: CurrentHostedDependencyOrigin, unit: string,
    input: {readonly command:string;readonly args:readonly string[];readonly cwd:string;readonly env:Readonly<Record<string,string>>}) {
    const fence = this.store.publicationFence(), current = readCurrentHostedManagedDependencyProviderParent(context,fence);
    if (current.facts.kind!==CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) throw new Error("hosted_dependency_current_origin_unresolved");
    const identity = {jobId:current.facts.start.readonlyJobId,jobRootDir:current.binding.jobRootDir,workspacePath:current.binding.workspace.canonicalPath};
    this.assertManagedAdmission(identity,CodexProviderEgressProfileId.TestManagedQualification);
    this.publishDependencyProviderStart(context,unit);
    let child: CodexAppServerChildProcess;
    try { child = spawnCurrentHostedManagedDependencyProvider(context,fence,unit,input); }
    catch (error) {
      const record = this.readEpoch().reservations.find(row => row.unit === unit && row.state === HostedCustodyReservationState.Reserved);
      try { if (record) this.requestStop(record); } catch { /* Exact reservation remains held. */ }
      throw error;
    }
    void observeCurrentHostedManagedDependencyProviderFrame(context,unit).then(() => retryHostedFenceAcquisition(() => this.releaseProviderFrame(unit,identity,(held,revalidate) => {
      revalidate(); releaseCurrentHostedManagedDependencyProviderFrame(context,held,unit); revalidate();
    }),remainingCurrentHostedManagedDependencyProviderSetup(context,unit))).catch(() => {
      invalidateCurrentHostedManagedDependencyProvider(context,unit);
      // Stop this exact actual reservation; an ambiguous proxy/OS result keeps
      // it held and cannot create a successor or authorize another submission.
      try { const record = this.serialized(() => this.readEpoch().reservations.find(row => row.unit === unit &&
        row.state === HostedCustodyReservationState.Reserved)); if (record) this.requestStop(record); } catch { /* Held on uncertainty. */ }
    });
    return child;
  }
  /** Fixed refresh reserves a distinct actual provider under this same live R. */
  private startDependencySessionBootstrap(home:CurrentHostedDependencySessionHome,probe:boolean):CodexAppServerChildProcess {
    let child:CodexAppServerChildProcess|undefined;
    const current = withHostedActivationFence(fence => readCurrentHostedDependencySessionRefreshParent(home,fence));
    if (current.facts.kind===CurrentHostedDependencyOriginKind.Ordinary) return startCurrentHostedOrdinaryDependencySessionBootstrap(home,probe);
    const identity = {jobId:current.facts.start.readonlyJobId,jobRootDir:current.binding.jobRootDir,workspacePath:current.binding.workspace.canonicalPath};
    const admitted = this.assertManagedAdmission(identity,CodexProviderEgressProfileId.TestManagedQualification);
    const startId = randomUUID(), unit = `subscription-runtime-hosted-${startId}.service`;
    new HostedCustodySupervisor(this).start(HostedCustodyLaunchKind.ManagedProvider,admitted.identity,admitted.generation,
      {startId,unit,creatorId:startId},() => {
        child = probe ? spawnCurrentHostedDependencySessionModelProbe(home,this.store.publicationFence(),unit) : spawnCurrentHostedDependencySessionRefresh(home,this.store.publicationFence(),unit);
        void observeCurrentHostedDependencySessionRefreshFrame(home,unit).then(() => retryHostedFenceAcquisition(() =>
          this.releaseProviderFrame(unit,identity,(fence,revalidate) => {
            revalidate(); releaseCurrentHostedDependencySessionRefreshFrame(home,fence,unit); revalidate();
          }),5000)).catch(() => {
            invalidateCurrentHostedDependencySessionRefresh(home,unit);
            try { const record = this.serialized(() => this.readEpoch().reservations.find(row => row.unit === unit));
              if (record) this.requestStop(record); } catch { /* Exact unresolved reservation remains held. */ }
          });
      });
    if (!child) throw new Error("hosted_dependency_session_bootstrap_unknown"); return child;
  }
  startDependencySessionRefresh(home:CurrentHostedDependencySessionHome):void { this.startDependencySessionBootstrap(home,false); }
  startDependencySessionModelProbe(home:CurrentHostedDependencySessionHome):CodexAppServerChildProcess { return this.startDependencySessionBootstrap(home,true); }

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
  withForegroundTerminal<T>(result: HostedForegroundResult, action: (owner: { jobRootDir: string; args: readonly string[]; fence: HostedActivationFence }) => T): T {
    return withHostedActivationFence(fence => this.store.withHeldFence(fence, () => {
      assertHostedForegroundResult(result);
      const epoch = this.readEpoch(), record = epoch.outerRuntime;
      if (!record || record.unit !== result.unit || record.startId !== result.startId || record.startId !== this.runtimeStartId ||
          record.state !== (result.exitCode === 0 ? HostedCustodyReservationState.Terminal : HostedCustodyReservationState.Reserved)) denied();
      if (result.exitCode === 0) this.kernel.fenceCreator(record, epoch.bootId);
      else {
        assertExclusiveHostedActivation(epoch);
        const session = this.session();
        if (session.hostId !== epoch.hostId || session.bootId !== epoch.bootId || session.supervisorId !== epoch.supervisorId ||
            epoch.generation !== this.runtimeGeneration) denied();
      }
      this.kernel.drainQueuedStart(record); this.kernel.confirmTerminalDescendants(record);
      return action({ jobRootDir: epoch.identity.jobRootDir, args: readHostedReadonlyHostInventory().runtimeLaunch.args, fence });
    }));
  }
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function denied(): never { throw new Error("hosted_custody_admission_denied"); }
