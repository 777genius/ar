import { dependencyOwnedReservations, releaseHostedDependencyConsumer } from "./hosted-dependency-release";
import { assertHostedLegacyReferenceReservationPrepared, sealHostedLegacyReferenceStart,
  retainHostedLegacyReferenceRelease } from "./hosted-dependency-legacy-reference";
import { evictHostedDependencyCandidate, recoverHostedDependencyEviction, removeHostedDependencyCommittedTrash,
  type HostedDependencyEvictionCandidate } from "./hosted-dependency-transactions";
import { assertHostedDependencyQualifiedInventory, assertHostedDependencyPhysicalWorkspace, hostedDependencyOwnerRoot, isHostedDependencyWorkspace, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { fenceDependencyConsumer, isDependencyConsumerOwner } from "@vioxen/subscription-runtime/worker-core";
import { scopedOrdinaryAuthority } from "./hosted-controller/scoped-termination-validation";
import { ScopedTerminationRecords } from "./hosted-controller/scoped-termination-records";
import { ScopedTerminationKind, type RuntimeValidatedOrdinaryTermination } from "../worker-core/hosted-custody/domain/scoped-termination";
import { readHostedChildSlot } from "./hosted-child-slot-files";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HostedActivationPhase, assertHostedActivationSuccessor, parseHostedActivation, parseHostedInstallation, parseHostedOrdinaryBirth, parseHostedOrdinaryOrigins, parseHostedOrdinaryStart, parseHostedCustodyEpoch, HostedCustodyPhase, HostedCustodyReservationState, HostedOriginKind, type HostedActivation, type HostedInstallation, type HostedOrdinaryBirth, type HostedOrdinaryOrigins, type HostedCustodyEpoch, type HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes,
  withHostedActivationFence, assertHostedActivationOperator, assertHostedScopedAdmission, retainHostedScopedCorrelation, CodexProviderEgressProfileId, type HostedActivationFence,
} from "@vioxen/subscription-runtime/provider-codex";
import { fileURLToPath } from "node:url";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory, ordinaryCompletionBytes, ordinaryCompletionPath } from "./hosted-readonly-host-kernel";
import { assertHostedForegroundResult, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { parseHostedTestEgressGrant, assertHostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { readHostedPrivateBytes, hostedReadonlyPolicyRoot } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, readonlySupervisorRoot, readonlyRevokedRoot } from "./hosted-readonly-custody";
import { issueFreshHostedManifestPlacement } from "./hosted-dependency-manifest-placement";

/** Installation, origin and activation persistence under the common host fence.
 * Authority derives from independently staged inventory and actual kernel facts;
 * caller records and stop requests never substitute for those proofs. */
export class HostedInstallationActivationStore {
  private ordinaryLaunch: ReturnType<HostedInstallationActivationStore["reserveOrdinaryRuntime"]> | undefined;
  read(): HostedActivation { return readHostedInstallationActivation().activation; }

  /** Candidate fields are comparisons only. Actual inspected operator/grant
   * facts are resolved here, never supplied as a request authorization DTO. */
  dependencyMaintenanceAuthority(fence: HostedActivationFence, jobId: string) {
      assertHostedActivationFence(fence);
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      const origin = readHostedOrdinaryBirth(jobId);
      assertInspectedInstallation(origin.installation); assertActivationSession(origin.activation, session);
      const binding = readHostedDependencyBinding(jobId);
      if (!binding || binding.installationId !== origin.installation.installationId || binding.runtimeSha !== origin.installation.runtimeSha ||
          binding.workspace.canonicalPath !== origin.birth.workspacePath || binding.jobRootDir !== origin.birth.jobRootDir ||
          assertNoManagedOrigin(origin.birth) !== binding.grantDigest) invalid();
      const grantBytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, digest(Buffer.from(jobId)) + ".json"), 4096);
      if (!grantBytes || parseHostedTestEgressGrant(decodeHostedActivationBytes(grantBytes)).profileId !== CodexProviderEgressProfileId.TestNpmQualification) invalid();
      assertHostedDependencyQualifiedInventory();
      assertHostedDependencyPhysicalWorkspace(binding);
      return { ...origin, binding, session };
  }
  /** Finite authenticated read model only; does not enroll, claim or recover. */
  dependencyReportOrigins(fence: HostedActivationFence) {
    assertHostedActivationFence(fence);
    const { installation, activation } = readHostedInstallationActivation();
    assertInspectedInstallation(installation);
    assertActivationSession(activation, new HostedReadonlyHostKernel().operatorSession());
    if (activation.phase !== HostedActivationPhase.Ordinary) invalid();
    assertHostedDependencyQualifiedInventory();
    const catalog = readOrdinaryCatalog(installation, activation.ordinaryOriginsSha256);
    return Object.freeze({ revision: catalog.revision, sha256: activation.ordinaryOriginsSha256,
      jobIds: Object.freeze(catalog.origins.map(row => row.jobId)) });
  }
  /** Lazy adapter boundary avoids importing the report back into lifecycle initialization. */
  async reportDependencyRetention(jobId?: string) {
    const { collectHostedDependencyRetentionFacts } = await import("./hosted-dependency-retention-facts");
    return collectHostedDependencyRetentionFacts(jobId);
  }
  evictDependencyCandidate(candidate: HostedDependencyEvictionCandidate) { return evictHostedDependencyCandidate(candidate); }
  recoverDependencyEviction(jobId: string) { return recoverHostedDependencyEviction(jobId); }
  removeDependencyCommittedTrash(jobId: string, revision: number) { return removeHostedDependencyCommittedTrash(jobId, revision); }
  /** Closed TEST reference operation; selection remains operator policy. */
  async compareLegacyDependency(input: { readonly candidateJobId: string; readonly referenceJobId: string; readonly expectedRevision: number | null }) {
    const { compareHostedLegacyDependency } = await import("./hosted-dependency-legacy-comparison");
    return compareHostedLegacyDependency(input);
  }

  serialized<T>(action: (fence: HostedActivationFence) => T): T {
    return withHostedActivationFence(fence => {
      this.read();
      return action(fence);
    });
  }

  /** Explicit recovery only: finish a retained immediate successor and persist
   * CLOSED before returning control. Do not guess missing history, erase an
   * incompatible .next, or silently resume either execution mode after a crash. */
  recoverSerialized<T>(action: (fence: HostedActivationFence) => T): T {
    return withHostedActivationFence(fence => {
      this.readCommitted(fence);
      const pending = readHostedActivationBytes("host-activation.next");
      if (pending) this.publish(fence, parseHostedActivation(decodeHostedActivationBytes(pending)), true);
      this.recoverCatalog(fence);
      this.retainManagedEnrollment(fence);
      const current = this.readCommitted(fence);
      this.publish(fence, { ...current, generation: current.generation + 1, phase: HostedActivationPhase.Closed });
      if (readHostedActivationBytes("readonly-enrollment.json")) {
        new HostedReadonlyEpochStore().withHeldFence(fence, () => {}, true);
      }
      // Catalog publication has its own evidence and is never discarded here.
      // A crash may require that reconciliation before this full reader passes.
      this.read();
      return action(fence);
    });
  }

  publish(fence: HostedActivationFence, next: HostedActivation, recovering = false, authority?: RuntimeValidatedOrdinaryTermination): void {
    assertHostedActivationFence(fence);
    const prior = this.readCommitted(fence);
    assertHostedActivationSuccessor(prior, next, authority ? scopedOrdinaryAuthority(authority) : undefined);
    const pending = readHostedActivationBytes("host-activation.next");
    if (pending && !recovering) throw new Error("hosted_activation_publication_recovery_required");
    const bytes = Buffer.from(JSON.stringify(parseHostedActivation(next)) + "\n");
    if (bytes.length > 4 * 1024 * 1024) throw new Error("hosted_activation_invalid");
    if (pending && !pending.equals(bytes)) throw new Error("hosted_activation_publication_recovery_required");
    const nextPath = join(readonlySupervisorRoot, "host-activation.next");
    createReadonlyPrivateRecord(nextPath, bytes);
    const staged = authority ? lstatSync(nextPath) : null;
    renameSync(nextPath, join(readonlySupervisorRoot, "host-activation.json"));
    const published = authority ? lstatSync(join(readonlySupervisorRoot, "host-activation.json")) : null;
    const parent = openSync(readonlySupervisorRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if (authority) {
      const current = lstatSync(join(readonlySupervisorRoot, "host-activation.json"));
      if (!staged || !published || current.dev !== staged.dev || current.ino !== staged.ino || current.dev !== published.dev || current.ino !== published.ino ||
          !current.isFile() || current.uid !== 0 || current.nlink !== 1 || (current.mode & 0o7777) !== 0o600 ||
          current.ctimeMs !== published.ctimeMs || current.mtimeMs !== published.mtimeMs || !readHostedActivationBytes("host-activation.json")?.equals(bytes)) invalid();
    }
  }

  /** Receipt validation is a host-owned closure, never a DTO/caller path. It
   * rereads private receipt, identity and the complete correlation under fence. */
  publishScopedTerminal(fence: HostedActivationFence, authority: RuntimeValidatedOrdinaryTermination): HostedActivation {
    assertHostedActivationFence(fence);
    const receipt = scopedOrdinaryAuthority(authority), prior = this.read();
    const members = new Map(receipt.operation.members.map(m => [m.startId, m]));
    for (const member of members.values()) {
      const row = prior.ordinaryStarts.find(r => r.startId === member.startId);
      if (!row || row.unit !== member.unit || row.generation !== member.reservationGeneration) invalid();
    }
    const next = { ...prior, generation: prior.generation + 1, ordinaryStarts: prior.ordinaryStarts.map(row =>
      members.has(row.startId) ? { ...row, state: HostedCustodyReservationState.Terminal } : row) };
    if (next.ordinaryStarts.every((row, i) => row.state === prior.ordinaryStarts[i]!.state)) {
      new ScopedTerminationRecords(assertHostedActivationOperator).synchronizeActivation(fence, encoded(prior)); return prior;
    }
    this.publish(fence, next, false, authority);
    const current = this.read();
    if (JSON.stringify(current) !== JSON.stringify(next)) invalid();
    new ScopedTerminationRecords(assertHostedActivationOperator).synchronizeActivation(fence, encoded(current));
    return current;
  }

  /** Root installation migration derives its identity from the independently
   * staged same artifact and finite inventory. No caller-authored approval JSON. */
  install(): HostedActivation {
    return withHostedActivationFence(fence => {
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      const binding = inspectedInstallation();
      const existing = readHostedActivationBytes("host-installation.json");
      if (existing) {
        const installed = parseHostedInstallation(decodeHostedActivationBytes(existing));
        if (Object.keys(binding).some(key => installed[key as keyof typeof binding] !== binding[key as keyof typeof binding])) invalid();
        const current = this.read();
        if (current.phase !== HostedActivationPhase.Closed) invalid();
        return current;
      }
      // Enrollment is create-only. Any retained mutable or managed state needs
      // its explicit migration/recovery, never a fresh ordinary installation.
      for (const name of ["host-activation.json", "host-activation.next", "ordinary-origins.json", "ordinary-origins.next",
        "readonly-enrollment.json", "readonly-epoch.json", "readonly-epoch.next"]) if (readHostedActivationBytes(name)) invalid();
      for (const directory of ["ordinary-origins", "ordinary-starts", "codex-readonly-custody", "codex-readonly-revoked"]) {
        const path = join(readonlySupervisorRoot, directory), stat = lstatSync(path);
        if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o077) || readdirSync(path).length) invalid();
      }
      return this.createInstallation(binding, session, null, fence);
    });
  }

  /** Explicit migration of retained managed custody. No inferred empty history,
   * stage rebinding, grant creation, revocation removal or automatic activation. */
  installManaged(): HostedActivation {
    return withHostedActivationFence(fence => {
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      const binding = inspectedInstallation();
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      const enrollment = required("readonly-enrollment.json");
      parseHostedCustodyEnrollment(enrollment);
      const epoch = new HostedReadonlyEpochStore().readEpoch();
      if (epoch.hostId !== binding.hostId || epoch.identity.runtimeSha !== binding.runtimeSha ||
          epoch.identity.runtimeManifestSha256 !== binding.runtimeManifestSha256 ||
          epoch.phase !== HostedCustodyPhase.Closed ||
          managedReservations(epoch).some(row => row.state !== HostedCustodyReservationState.Terminal)) invalid();
      // Retained terminal flags do not substitute for current independent OS
      // observations. A missing creator receipt in the same boot still denies.
      for (const row of managedReservations(epoch)) {
        kernel.fenceCreator(row, epoch.bootId); kernel.drainQueuedStart(row); kernel.confirmTerminalDescendants(row);
      }
      if (readHostedActivationBytes("host-installation.json")) {
        const { installation, activation } = readHostedInstallationActivation();
        assertInspectedInstallation(installation);
        if (activation.phase !== HostedActivationPhase.Closed || activation.exclusiveEnrollmentSha256 !== digest(enrollment)) invalid();
        return activation;
      }
      for (const name of ["host-activation.json", "host-activation.next", "ordinary-origins.json", "ordinary-origins.next"]) {
        if (readHostedActivationBytes(name)) invalid();
      }
      for (const directory of ["ordinary-origins", "ordinary-starts", "ordinary-completed"]) {
        const path = join(readonlySupervisorRoot, directory), stat = lstatSync(path);
        if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o077) || readdirSync(path).length) invalid();
      }
      return this.createInstallation(binding, session, digest(enrollment), fence);
    });
  }

  private createInstallation(binding: Omit<HostedInstallation, "schemaVersion" | "installationId">,
    session: Pick<HostedActivation, "hostId" | "bootId" | "supervisorId">, enrollmentSha256: string | null, fence: HostedActivationFence): HostedActivation {
    const installation = parseHostedInstallation({ ...binding, schemaVersion: 1, installationId: randomUUID() });
    issueFreshHostedManifestPlacement(fence, installation);
    const catalog = { schemaVersion: 1, installationId: installation.installationId, revision: 1, origins: [] };
    const catalogBytes = encoded(catalog);
    const activation = parseHostedActivation({ schemaVersion: 1, installationId: installation.installationId,
      ...session, generation: 1, phase: HostedActivationPhase.Closed, ordinaryOriginsSha256: digest(catalogBytes),
      exclusiveEnrollmentSha256: enrollmentSha256, ordinaryStarts: [] });
    createReadonlyPrivateRecord(join(readonlySupervisorRoot, "host-installation.json"), encoded(installation));
    createReadonlyPrivateRecord(join(readonlySupervisorRoot, "ordinary-origins.json"), catalogBytes);
    createReadonlyPrivateRecord(join(readonlySupervisorRoot, "host-activation.json"), encoded(activation));
    return this.read();
  }

  enrollOrdinary(creatorId: string): HostedOrdinaryBirth {
    return this.serialized(fence => {
      const { installation, activation } = readHostedInstallationActivation();
      assertInspectedInstallation(installation);
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      if (activation.phase !== HostedActivationPhase.Closed || activation.hostId !== session.hostId ||
          activation.bootId !== session.bootId || activation.supervisorId !== session.supervisorId ||
          activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal)) invalid();
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      const creator = readHostedReadonlyHostInventory().ordinaryCreators.find(row => row.creatorId === creatorId);
      if (!creator) invalid();
      readHostedChildSlot(creator);
      const birth = parseHostedOrdinaryBirth({ schemaVersion: 1, installationId: installation.installationId,
        jobId: creator.jobId, jobRootDir: creator.jobRootDir, workspacePath: creator.workspacePath, origin: HostedOriginKind.Ordinary });
      assertNoManagedOrigin(birth);
      const name = digest(Buffer.from(birth.jobId)) + ".json", bytes = encoded(birth);
      const prior = readOrdinaryCatalog(installation, activation.ordinaryOriginsSha256);
      const retained = prior.origins.find(row => row.jobId === birth.jobId);
      if (retained) {
        if (retained.birthSha256 !== digest(bytes)) invalid();
        return birth;
      }
      createReadonlyPrivateRecord(join(readonlySupervisorRoot, "ordinary-origins", name), bytes);
      const next = parseHostedOrdinaryOrigins({ ...prior, revision: prior.revision + 1,
        origins: [...prior.origins, { jobId: birth.jobId, jobRootDir: birth.jobRootDir,
          workspacePath: birth.workspacePath, birthSha256: digest(bytes) }] });
      const catalogBytes = encoded(next);
      // Readers remain closed while catalog.next exists. Activation binds its
      // exact successor before the catalog rename; recovery validates both.
      createReadonlyPrivateRecord(join(readonlySupervisorRoot, "ordinary-origins.next"), catalogBytes);
      this.publish(fence, { ...activation, generation: activation.generation + 1, ordinaryOriginsSha256: digest(catalogBytes) });
      this.recoverCatalog(fence);
      return birth;
    });
  }

  resumeOrdinary(): HostedActivation {
    return this.serialized(fence => {
      const { installation, activation } = readHostedInstallationActivation();
      assertInspectedInstallation(installation);
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      if (activation.phase !== HostedActivationPhase.Closed || activation.hostId !== session.hostId ||
          activation.bootId !== session.bootId || activation.supervisorId !== session.supervisorId ||
          activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal)) invalid();
      const catalog = readOrdinaryCatalog(installation, activation.ordinaryOriginsSha256);
      const slotIds = new Set<string>();
      for (const creator of readHostedReadonlyHostInventory().ordinaryCreators) {
        const slot = readHostedChildSlot(creator);
        if (slot) {
          new ChildExecutionBudget(slot.lifetime).remainingMs();
          if (slotIds.has(slot.slotId)) invalid(); slotIds.add(slot.slotId);
        }
        if (!catalog.origins.some(row => row.jobId === creator.jobId && row.jobRootDir === creator.jobRootDir && row.workspacePath === creator.workspacePath)) invalid();
      }
      const epochBytes = readHostedActivationBytes("readonly-epoch.json");
      if (epochBytes) {
        const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(epochBytes));
        if (epoch.phase !== HostedCustodyPhase.Closed || epoch.reservations.some(row => row.state !== HostedCustodyReservationState.Terminal) ||
            (epoch.outerRuntime !== null && epoch.outerRuntime.state !== HostedCustodyReservationState.Terminal)) invalid();
      }
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      this.publish(fence, { ...activation, generation: activation.generation + 1, phase: HostedActivationPhase.Ordinary });
      return this.read();
    });
  }

  /** Root dispatcher preparation. The caller must keep this same fence through
   * synchronous OS submission. Reservation precedes birth publication, so a
   * crash at either write remains held and cannot become an untracked creator. */
  reserveOrdinaryRuntime(fence: HostedActivationFence, command: string, args: readonly string[], cwd: string, correlation?: Readonly<{ startId: string; unit: string; identity?: import("../worker-core/hosted-custody/domain/scoped-termination").RetainedScopeIdentity }>) {
    assertHostedActivationFence(fence);
    if (correlation) assertHostedScopedAdmission(fence, correlation.startId);
    const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
    const candidates = readHostedReadonlyHostInventory().ordinaryCreators.filter(row =>
      row.launch.command === command && row.launch.cwd === cwd && JSON.stringify(row.launch.args) === JSON.stringify(args));
    if (candidates.length !== 1) invalid();
    const creator = candidates[0]!;
    const childSlot = readHostedChildSlot(creator);
    if (correlation && !childSlot) invalid();
    const childBudget = childSlot ? new ChildExecutionBudget(childSlot.lifetime) : undefined;
    childBudget?.remainingMs();
    const { installation, activation, birth, originSha256 } = readHostedOrdinaryBirth(creator.jobId);
    assertInspectedInstallation(installation); assertActivationSession(activation, session);
    if (isHostedDependencyWorkspace(creator.workspacePath)) {
      assertHostedDependencyQualifiedInventory();
      const binding = readHostedDependencyBinding(creator.jobId);
      if (!binding || binding.installationId !== installation.installationId ||
          binding.jobRootDir !== creator.jobRootDir || binding.workspace.canonicalPath !== creator.workspacePath) invalid();
      assertHostedLegacyReferenceReservationPrepared(fence, binding);
    }
    if (childSlot && activation.ordinaryStarts.some(row => row.creatorId === creator.creatorId)) throw new Error("child_invocation_consumed");
    if (birth.jobRootDir !== creator.jobRootDir || birth.workspacePath !== creator.workspacePath) invalid();
    const grantSha256 = assertNoManagedOrigin(birth); kernel.verifyDescriptorBoundary();
    const creatorPidBirth = kernel.ordinaryCreatorBirth(), startId = correlation?.startId ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(startId) || (correlation && correlation.unit !== `subscription-runtime-ordinary-${startId}.service`) ||
        activation.ordinaryStarts.some(row => row.startId === startId || row.unit === correlation?.unit)) invalid();
    const row = { startId, unit: `subscription-runtime-ordinary-${startId}.service`, creatorId: creator.creatorId,
      originSha256, generation: activation.generation + 1, state: HostedCustodyReservationState.Reserved };
    const start = parseHostedOrdinaryStart({ schemaVersion: 1, installationId: installation.installationId,
      jobId: birth.jobId, jobRootDir: birth.jobRootDir, workspacePath: birth.workspacePath,
      activationGeneration: row.generation, bootId: activation.bootId, supervisorId: activation.supervisorId,
      originSha256, unit: row.unit, controlGroup: ordinaryUnitGroup(row), creatorId: row.creatorId, creatorPidBirth, grantSha256 });
    this.publish(fence, { ...activation, generation: row.generation, ordinaryStarts: [...activation.ordinaryStarts, row] });
    createReadonlyPrivateRecord(join(readonlySupervisorRoot, "ordinary-starts", startId + ".json"), encoded(start));
    const dependencyBinding = readHostedDependencyBinding(birth.jobId);
    if (dependencyBinding?.version === 3) sealHostedLegacyReferenceStart(fence, dependencyBinding, start, row);
    if (correlation?.identity) {
      const identity = correlation.identity;
      if (identity.parentStartId !== startId || identity.installationId !== installation.installationId ||
          identity.hostId !== activation.hostId || identity.bootId !== activation.bootId || identity.supervisorId !== activation.supervisorId ||
          identity.inventoryDigest !== installation.inventorySha256 || identity.grantDigest !== grantSha256 ||
          !childSlot || identity.accountId !== childSlot.lifetime.accountId || identity.deadlineEpochMs !== childSlot.lifetime.deadlineEpochMs ||
          identity.sourceSha !== childSlot.sourceSha || identity.artifactSha !== childSlot.artifactSha) invalid();
      const inventory = readHostedReadonlyHostInventory(), owner = inventory.units.find(u => u.name === inventory.supervisorUnit)!;
      if (identity.supervisorUnit !== owner.name || identity.supervisorControlGroup !== owner.controlGroup) invalid();
      retainHostedScopedCorrelation(fence, { schemaVersion: 1, kind: ScopedTerminationKind.Runtime, identity,
        startId, startDigest: digest(encoded(start)), parentStartDigest: digest(encoded(start)), reservationGeneration: row.generation,
        unit: row.unit, controlGroup: start.controlGroup, creatorPidBirth, creatorControlGroup: owner.controlGroup });
    }
    return Object.freeze({ start, reservation: Object.freeze(row), launch: creator.launch,
      ...(childBudget ? { childLifetime: childBudget.lifetime, childBudget } : {}) });
  }

  runOrdinaryRuntimeLaunch<T>(command: string, args: readonly string[], cwd: string,
    submit: (launch: { command: string; args: readonly string[] }) => T): T {
    if (this.ordinaryLaunch) invalid();
    try {
      return this.serialized(fence => {
        this.ordinaryLaunch = this.reserveOrdinaryRuntime(fence, command, args, cwd);
        try {
          const invocation = new HostedReadonlyHostKernel().ordinaryRuntimeInvocation(this.ordinaryLaunch.reservation, cwd);
          this.ordinaryLaunch.childBudget?.remainingMs();
          const submitted = submit(invocation);
          // Submission can consume elapsed time or cross a clock rollback.
          // Failure retains the reserved origin and requests cleanup below.
          this.ordinaryLaunch.childBudget?.remainingMs();
          return submitted;
        } catch (error) {
          if (!this.ordinaryLaunch.childLifetime) {
            const activation = this.read();
            this.publish(fence, { ...activation, generation: activation.generation + 1, phase: HostedActivationPhase.Closed });
          }
          throw error;
        }
      });
    } catch (error) {
      if (this.ordinaryChildLifetime()) { try { this.requestOrdinaryChildCleanup(); } catch { /* Retain uncertain ownership. */ } }
      throw error;
    }
  }
  releaseOrdinaryRuntimeFrame(release: (fence: HostedActivationFence, revalidate: () => void) => void): void {
    this.serialized(fence => {
      const revalidate = () => {
      const launch = this.ordinaryLaunch;
      if (!launch) invalid();
      const { installation, activation, birth, originSha256 } = readHostedOrdinaryBirth(launch.start.jobId);
      assertInspectedInstallation(installation);
      assertActivationSession(activation, new HostedReadonlyHostKernel().operatorSession());
      const row = activation.ordinaryStarts.find(row => row.startId === launch.reservation.startId);
      if (!row || row.state !== HostedCustodyReservationState.Reserved || JSON.stringify(row) !== JSON.stringify(launch.reservation) ||
          installation.installationId !== launch.start.installationId || activation.bootId !== launch.start.bootId ||
          originSha256 !== launch.start.originSha256 || birth.workspacePath !== launch.start.workspacePath ||
          !required(`ordinary-starts/${row.startId}.json`).equals(encoded(launch.start))) invalid();
      launch.childBudget?.remainingMs();
      if (isHostedDependencyWorkspace(launch.start.workspacePath)) assertHostedDependencyQualifiedInventory();
      launch.childBudget?.remainingMs();
      };
      revalidate(); release(fence, revalidate);
    });
  }
  /** Dependency attempt release is per retained invocation, never global phase
   * closure. Called by the host --wait owner after successful completion. */
  releaseOrdinaryDependencyConsumer(): boolean {
    return this.serialized(fence => {
      const launch = this.ordinaryLaunch;
      if (!launch) invalid();
      const released = releaseHostedDependencyConsumer(fence, this.read(), launch.start, launch.reservation);
      if (released) retainHostedLegacyReferenceRelease(fence, launch.start, launch.reservation);
      return released;
    });
  }
  requestOrdinaryDependencyCleanup(): boolean {
    const retained = this.serialized(() => {
      const launch = this.ordinaryLaunch;
      if (!launch) invalid();
      const binding = readHostedDependencyBinding(launch.start.jobId);
      if (!binding) return undefined;
      if (binding.workspace.canonicalPath !== launch.start.workspacePath || binding.grantDigest !== launch.start.grantSha256) invalid();
      const activation = this.read(), kernel = new HostedReadonlyHostKernel();
      assertActivationSession(activation, kernel.operatorSession());
      const runtime = activation.ordinaryStarts.find(r => r.startId === launch.reservation.startId);
      if (!runtime || JSON.stringify(runtime) !== JSON.stringify(launch.reservation)) invalid();
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try {
        const owner = store.read(binding.workspace);
        if (owner?.owner && !isDependencyConsumerOwner(owner.owner)) invalid();
        const attempt = owner && isDependencyConsumerOwner(owner.owner) ? owner.owner.attempt : undefined;
        if (attempt) {
          if (attempt.launch.startId !== runtime.startId || attempt.launch.grantDigest !== binding.grantDigest ||
              attempt.launch.installationId !== binding.installationId) invalid();
          fenceDependencyConsumer(store, binding.workspace, attempt);
          createReadonlyPrivateRecord(`${readonlySupervisorRoot}/dependency-attempt-fences/${runtime.startId}.json`,
            Buffer.from(JSON.stringify({ version: 1, startId: runtime.startId, attemptId: attempt.attemptId, epoch: attempt.epoch }) + "\n"));
        }
        // The owner fence persists before this snapshot and unlocked stops,
        // so a delayed provider enqueue cannot grow the selected namespace.
        return dependencyOwnedReservations(activation, runtime, attempt);
      } finally { store.close(); }
    });
    if (!retained) return false;
    this.requestStops(retained, undefined, new HostedReadonlyHostKernel());
    return true;
  }
  ordinaryChildLifetime() { return this.ordinaryLaunch?.childLifetime; }
  ordinaryChildBudget() { return this.ordinaryLaunch?.childBudget; }

  withOrdinaryForegroundTerminal<T>(result: HostedForegroundResult, action: (owner: { jobRootDir: string; args: readonly string[]; fence: HostedActivationFence }) => T): T {
    return this.serialized(fence => {
      assertHostedForegroundResult(result);
      const launch = this.ordinaryLaunch;
      if (!launch || launch.start.unit !== result.unit || launch.reservation.startId !== result.startId ||
          !required(`ordinary-starts/${launch.reservation.startId}.json`).equals(encoded(launch.start))) invalid();
      const kernel = new HostedReadonlyHostKernel();
      const activation = this.read();
      assertActivationSession(activation, kernel.operatorSession());
      const reservation = activation.ordinaryStarts.find(row => row.startId === launch.reservation.startId);
      if (!reservation || JSON.stringify(reservation) !== JSON.stringify(launch.reservation)) invalid();
      if (result.exitCode === 0) {
        if (!required(`ordinary-completed/${launch.reservation.startId}.json`).equals(
            ordinaryCompletionBytes(launch.reservation.startId, digest(encoded(launch.start))))) invalid();
        kernel.fenceOrdinaryCreator(launch.reservation, launch.start.bootId, digest(encoded(launch.start)));
      }
      kernel.drainOrdinaryQueue(launch.reservation); kernel.confirmOrdinaryDescendants(launch.reservation);
      const creator = readHostedReadonlyHostInventory().ordinaryCreators.find(row => row.creatorId === launch.start.creatorId);
      if (!creator || creator.jobRootDir !== launch.start.jobRootDir) invalid();
      return action({ jobRootDir: launch.start.jobRootDir, args: creator.launch.args, fence });
    });
  }

  recordOrdinaryRuntimeWaitCompletion(): void {
    this.serialized(() => {
      const launch = this.ordinaryLaunch;
      if (!launch) invalid();
      const activation = this.read(), session = new HostedReadonlyHostKernel().operatorSession();
      assertActivationSession(activation, session);
      const row = activation.ordinaryStarts.find(row => row.startId === launch.reservation.startId);
      if (!row || row.state !== HostedCustodyReservationState.Reserved ||
          JSON.stringify(row) !== JSON.stringify(launch.reservation)) invalid();
      const bytes = required(`ordinary-starts/${row.startId}.json`);
      if (!bytes.equals(encoded(launch.start))) invalid();
      createReadonlyPrivateRecord(ordinaryCompletionPath(row.startId), ordinaryCompletionBytes(row.startId, digest(bytes)));
    });
  }
  /** Child cleanup is scoped and retains reservations. A stop request is never
   * a terminal receipt and must not close every creator in the installation. */
  requestOrdinaryChildCleanup(): boolean {
    const launch = this.ordinaryLaunch;
    if (!launch) invalid();
    const retained = this.serialized(() => {
      const creator = readHostedReadonlyHostInventory().ordinaryCreators.find(row => row.creatorId === launch.reservation.creatorId);
      if (!creator?.childSlotSha256) return undefined;
      const activation = this.read(), kernel = new HostedReadonlyHostKernel();
      assertActivationSession(activation, kernel.operatorSession());
      const row = activation.ordinaryStarts.find(row => row.startId === launch.reservation.startId);
      if (!row || row.generation !== launch.reservation.generation || row.originSha256 !== launch.reservation.originSha256) invalid();
      const owned = activation.ordinaryStarts.filter(candidate => candidate.creatorId === row.creatorId && candidate.originSha256 === row.originSha256);
      for (const candidate of owned) {
        const start = parseHostedOrdinaryStart(decodeHostedActivationBytes(required(`ordinary-starts/${candidate.startId}.json`)));
        if (start.installationId !== launch.start.installationId || start.jobId !== launch.start.jobId ||
            start.bootId !== launch.start.bootId || start.supervisorId !== launch.start.supervisorId ||
            start.creatorId !== row.creatorId || start.originSha256 !== row.originSha256 ||
            start.unit !== candidate.unit || start.activationGeneration !== candidate.generation) invalid();
      }
      return owned;
    });
    if (!retained) return false;
    this.requestStops(retained, undefined, new HostedReadonlyHostKernel());
    return true;
  }

  closeOrdinaryRuntimeLaunch(): void {
    const launch = this.ordinaryLaunch;
    if (!launch) invalid();
    const kernel = new HostedReadonlyHostKernel();
    const retained = this.serialized(fence => {
      const activation = this.read();
      assertActivationSession(activation, kernel.operatorSession());
      const row = activation.ordinaryStarts.find(row => row.startId === launch.reservation.startId);
      if (!row || row.state === HostedCustodyReservationState.Terminal) return [];
      if (row.generation !== launch.reservation.generation || row.originSha256 !== launch.reservation.originSha256) invalid();
      this.publish(fence, { ...activation, generation: activation.generation + 1, phase: HostedActivationPhase.Closed });
      return activation.ordinaryStarts;
    });
    this.requestStops(retained, undefined, kernel);
  }

  /** Stop uses retained positive origin, even after admission closes or a grant
   * changes. It cannot authorize a new launch or claim terminal custody. */
  stopOrdinaryRuntime(identity: { readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string }): boolean {
    const kernel = new HostedReadonlyHostKernel();
    const retained = this.serialized(fence => {
      const { installation, activation } = readHostedInstallationActivation();
      const enrollment = readHostedActivationBytes("readonly-enrollment.json");
      if (enrollment && parseHostedCustodyEnrollment(enrollment) === identity.jobId) return undefined;
      assertInspectedInstallation(installation);
      if (isHostedOrdinaryRuntime()) {
        const origin = readRetainedOrdinaryRuntime(fence);
        if (origin.birth.jobId !== identity.jobId || origin.birth.jobRootDir !== identity.jobRootDir ||
            origin.birth.workspacePath !== identity.workspacePath) invalid();
      } else assertActivationSession(activation, kernel.operatorSession());
      const catalog = readOrdinaryCatalog(installation, activation.ordinaryOriginsSha256);
      const birth = catalog.origins.find(row => row.jobId === identity.jobId);
      if (!birth) return undefined;
      if (birth.jobRootDir !== identity.jobRootDir || birth.workspacePath !== identity.workspacePath) invalid();
      const selected = activation.ordinaryStarts.filter(row => row.originSha256 === birth.birthSha256);
      for (const row of selected) {
        const start = parseHostedOrdinaryStart(decodeHostedActivationBytes(required(`ordinary-starts/${row.startId}.json`)));
        if (start.installationId !== installation.installationId || start.jobId !== birth.jobId ||
            start.jobRootDir !== birth.jobRootDir || start.workspacePath !== birth.workspacePath ||
            start.originSha256 !== row.originSha256 || start.activationGeneration !== row.generation ||
            start.unit !== row.unit || start.creatorId !== row.creatorId || start.controlGroup !== ordinaryUnitGroup(row)) invalid();
        if (row.state !== HostedCustodyReservationState.Terminal &&
            (start.bootId !== activation.bootId || start.supervisorId !== activation.supervisorId)) invalid();
      }
      const childBound = readHostedReadonlyHostInventory().ordinaryCreators.some(creator => creator.jobId === birth.jobId && creator.childSlotSha256);
      if (!childBound && selected.some(row => row.state !== HostedCustodyReservationState.Terminal)) {
        this.publish(fence, { ...activation, generation: activation.generation + 1, phase: HostedActivationPhase.Closed });
      }
      return selected;
    });
    if (!retained) return false;
    this.requestStops(retained, undefined, kernel);
    return true;
  }

  enterExclusive(): void { this.closeForTransition(HostedActivationPhase.EnteringExclusive); }
  leaveExclusive(): void { this.closeForTransition(HostedActivationPhase.LeavingExclusive); }

  /** Managed material may be enrolled/recovered only after ordinary creators,
   * queues and descendants are independently drained. The same lock covers
   * preparation; a newly published managed birth is retained even on failure. */
  withExclusivePreparation<T>(action: (fence: HostedActivationFence) => T, recoverPublication = false): T {
    return withHostedActivationFence(fence => {
      const committed = this.readCommitted(fence);
      const kernel = new HostedReadonlyHostKernel();
      if (committed.phase !== HostedActivationPhase.EnteringExclusive) invalid();
      assertActivationSession(committed, kernel.operatorSession());
      this.retainManagedEnrollment(fence);
      if (recoverPublication && readHostedActivationBytes("readonly-enrollment.json")) {
        new HostedReadonlyEpochStore().withHeldFence(fence, () => {}, true);
      }
      const { installation, activation } = readHostedInstallationActivation();
      assertInspectedInstallation(installation);
      this.reconcileOrdinary(fence, activation, installation, kernel);
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      try { return action(fence); }
      finally { this.retainManagedEnrollment(fence); }
    });
  }

  private closeForTransition(phase: HostedActivationPhase.EnteringExclusive | HostedActivationPhase.LeavingExclusive): void {
    const kernel = new HostedReadonlyHostKernel();
    const retained = this.serialized(fence => {
      const { installation, activation } = readHostedInstallationActivation();
      assertInspectedInstallation(installation);
      assertActivationSession(activation, kernel.operatorSession());
      if (phase === HostedActivationPhase.EnteringExclusive ?
          ![HostedActivationPhase.Ordinary, HostedActivationPhase.Closed].includes(activation.phase) :
          activation.phase !== HostedActivationPhase.Exclusive) invalid();
      // Fence both old and new submitters before any stop callback can run.
      this.publish(fence, { ...activation, generation: activation.generation + 1, phase });
      let managed: HostedCustodyEpoch | undefined;
      if (readHostedActivationBytes("readonly-enrollment.json")) {
        const store = new HostedReadonlyEpochStore();
        store.withHeldFence(fence, () => {
          managed = store.readEpoch();
          store.publishEpoch({ ...managed, phase: HostedCustodyPhase.Closed });
        });
      }
      return { ordinary: activation.ordinaryStarts, managed };
    });
    this.requestStops(retained.ordinary, retained.managed, kernel);
  }

  revokeManaged(jobId: string): number {
    const kernel = new HostedReadonlyHostKernel();
    const retained = this.serialized(fence => {
      const activation = this.read();
      kernel.operatorSession();
      if (parseHostedCustodyEnrollment(required("readonly-enrollment.json")) !== jobId) invalid();
      this.publish(fence, { ...activation, generation: activation.generation + 1, phase: HostedActivationPhase.Closed });
      const store = new HostedReadonlyEpochStore();
      const managed = store.withHeldFence(fence, () => {
        const epoch = store.readEpoch();
        store.publishEpoch({ ...epoch, phase: HostedCustodyPhase.Closed, revoked: true });
        createReadonlyPrivateRecord(join(readonlyRevokedRoot, digest(Buffer.from(jobId)) + ".json"), encoded({ schemaVersion: 1, jobId }));
        return store.readEpoch();
      });
      return { ordinary: activation.ordinaryStarts, managed };
    });
    this.requestStops(retained.ordinary, retained.managed, kernel);
    return retained.managed.reservations.filter(row => row.state !== HostedCustodyReservationState.Terminal).length;
  }

  private requestStops(ordinary: readonly HostedOrdinaryReservation[], managed: HostedCustodyEpoch | undefined, kernel: HostedReadonlyHostKernel): void {
    // Outside the short mutex. Retained unique births prevent delayed callbacks
    // from targeting successor units. Stop failures never become terminal proof.
    let failed = false;
    for (const row of ordinary) if (row.state !== HostedCustodyReservationState.Terminal) {
      try { kernel.stopOrdinary(row); } catch { failed = true; }
    }
    for (const row of managedReservations(managed)) if (row.state !== HostedCustodyReservationState.Terminal) {
      try { kernel.requestStop(row); } catch { failed = true; }
    }
    if (failed) throw new Error("hosted_activation_stop_incomplete");
  }

  finishExclusive(): HostedActivation {
    return withHostedActivationFence(fence => {
      this.retainManagedEnrollment(fence);
      let activation = this.read();
      const installation = readHostedInstallationActivation().installation;
      assertInspectedInstallation(installation);
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      assertActivationSession(activation, session);
      if (activation.phase !== HostedActivationPhase.EnteringExclusive) invalid();
      activation = this.reconcileOrdinary(fence, activation, installation, kernel);
      const epoch = new HostedReadonlyEpochStore().readEpoch();
      if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || epoch.hostId !== session.hostId ||
          epoch.bootId !== session.bootId || epoch.supervisorId !== session.supervisorId ||
          managedReservations(epoch).some(row => row.state !== HostedCustodyReservationState.Terminal)) invalid();
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      new HostedReadonlySupervisorHost().verifyReadonlyMaterial(epoch.identity);
      this.publish(fence, { ...activation, generation: activation.generation + 1, phase: HostedActivationPhase.Exclusive });
      return this.read();
    });
  }

  /** Explicit drain/recovery ends CLOSED. It never resumes ordinary and never
   * clears a same-boot ambiguous creator on a stop, PID absence or proxy exit. */
  finishClosed(): HostedActivation {
    return this.recoverSerialized(fence => {
      this.retainManagedEnrollment(fence);
      let activation = this.read();
      const installation = readHostedInstallationActivation().installation;
      assertInspectedInstallation(installation);
      const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      if (activation.hostId !== session.hostId) invalid();
      activation = this.reconcileOrdinary(fence, activation, installation, kernel);
      if (readHostedActivationBytes("readonly-enrollment.json")) {
        const store = new HostedReadonlyEpochStore();
        store.withHeldFence(fence, () => {
          let epoch = store.readEpoch();
          store.publishEpoch({ ...epoch, phase: HostedCustodyPhase.Closed });
          epoch = store.readEpoch();
          for (const row of managedReservations(epoch)) {
            if (row.state === HostedCustodyReservationState.Terminal) continue;
            kernel.fenceCreator(row, epoch.bootId);
            kernel.drainQueuedStart(row);
            kernel.confirmTerminalDescendants(row);
            epoch = { ...epoch, reservations: epoch.reservations.map(item => item.startId === row.startId ?
              { ...item, state: HostedCustodyReservationState.Terminal } : item),
              outerRuntime: epoch.outerRuntime?.startId === row.startId ?
                { ...epoch.outerRuntime, state: HostedCustodyReservationState.Terminal } : epoch.outerRuntime };
            store.publishEpoch(epoch);
          }
        }, true);
      }
      kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
      this.publish(fence, { ...activation, ...session, generation: activation.generation + 1, phase: HostedActivationPhase.Closed });
      return this.read();
    });
  }

  private reconcileOrdinary(fence: HostedActivationFence, activation: HostedActivation,
    installation: HostedInstallation, kernel: HostedReadonlyHostKernel): HostedActivation {
    for (const row of activation.ordinaryStarts) {
      if (row.state === HostedCustodyReservationState.Terminal) continue;
      const bytes = required(`ordinary-starts/${row.startId}.json`), start = parseHostedOrdinaryStart(decodeHostedActivationBytes(bytes));
      const catalog = readOrdinaryCatalog(installation, activation.ordinaryOriginsSha256);
      const birth = catalog.origins.find(item => item.jobId === start.jobId);
      if (!birth || start.installationId !== installation.installationId || start.activationGeneration !== row.generation ||
          start.bootId !== activation.bootId || start.supervisorId !== activation.supervisorId ||
          start.unit !== row.unit || start.creatorId !== row.creatorId || start.originSha256 !== row.originSha256 ||
          birth.birthSha256 !== row.originSha256 || start.jobRootDir !== birth.jobRootDir || start.workspacePath !== birth.workspacePath ||
          start.controlGroup !== ordinaryUnitGroup(row)) invalid();
      kernel.fenceOrdinaryCreator(row, activation.bootId, digest(bytes));
      kernel.drainOrdinaryQueue(row);
      kernel.confirmOrdinaryDescendants(row);
      activation = { ...activation, generation: activation.generation + 1,
        ordinaryStarts: activation.ordinaryStarts.map(item => item.startId === row.startId ?
          { ...item, state: HostedCustodyReservationState.Terminal } : item) };
      this.publish(fence, activation);
    }
    return activation;
  }

  private retainManagedEnrollment(fence: HostedActivationFence): void {
    const activation = this.readCommitted(fence), bytes = readHostedActivationBytes("readonly-enrollment.json");
    if (!bytes) { if (activation.exclusiveEnrollmentSha256 !== null) invalid(); return; }
    parseHostedCustodyEnrollment(bytes);
    const birth = parseHostedCustodyEpoch(decodeHostedActivationBytes(bytes));
    const installation = parseHostedInstallation(decodeHostedActivationBytes(required("host-installation.json")));
    if (birth.hostId !== activation.hostId || birth.identity.runtimeSha !== installation.runtimeSha ||
        birth.identity.runtimeManifestSha256 !== installation.runtimeManifestSha256) invalid();
    if (activation.exclusiveEnrollmentSha256 === null) {
      if (activation.phase !== HostedActivationPhase.EnteringExclusive) invalid();
      this.publish(fence, { ...activation, generation: activation.generation + 1, exclusiveEnrollmentSha256: digest(bytes) });
    } else if (activation.exclusiveEnrollmentSha256 !== digest(bytes)) invalid();
  }

  private recoverCatalog(fence: HostedActivationFence): void {
    const pending = readHostedActivationBytes("ordinary-origins.next");
    if (!pending) return;
    const activation = this.readCommitted(fence);
    if (activation.phase !== HostedActivationPhase.Closed) invalid();
    const installation = parseHostedInstallation(decodeHostedActivationBytes(required("host-installation.json")));
    const priorBytes = required("ordinary-origins.json"), prior = parseHostedOrdinaryOrigins(decodeHostedActivationBytes(priorBytes));
    const next = parseHostedOrdinaryOrigins(decodeHostedActivationBytes(pending));
    if (prior.installationId !== installation.installationId || next.installationId !== installation.installationId ||
        next.revision !== prior.revision + 1 || next.origins.length !== prior.origins.length + 1 ||
        prior.origins.some((row, index) => JSON.stringify(row) !== JSON.stringify(next.origins[index]))) invalid();
    validateCatalogBirths(next);
    if (activation.ordinaryOriginsSha256 === digest(priorBytes)) {
      this.publish(fence, { ...activation, generation: activation.generation + 1, ordinaryOriginsSha256: digest(pending) });
    } else if (activation.ordinaryOriginsSha256 !== digest(pending)) invalid();
    renameSync(join(readonlySupervisorRoot, "ordinary-origins.next"), join(readonlySupervisorRoot, "ordinary-origins.json"));
    const fd = openSync(readonlySupervisorRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private readCommitted(fence: HostedActivationFence): HostedActivation {
    assertHostedActivationFence(fence);
    const installationBytes = readHostedActivationBytes("host-installation.json");
    const activationBytes = readHostedActivationBytes("host-activation.json");
    if (!installationBytes || !activationBytes) throw new Error("hosted_activation_authority_required");
    const installation = parseHostedInstallation(decodeHostedActivationBytes(installationBytes));
    const activation = parseHostedActivation(decodeHostedActivationBytes(activationBytes));
    if (installation.installationId !== activation.installationId || installation.hostId !== activation.hostId) {
      throw new Error("hosted_activation_evidence_invalid");
    }
    return activation;
  }
}

export function readHostedInstallationActivation(): {
  readonly installation: HostedInstallation; readonly activation: HostedActivation;
} {
  if (readHostedActivationBytes("host-activation.next") || readHostedActivationBytes("ordinary-origins.next")) {
    throw new Error("hosted_activation_publication_recovery_required");
  }
  const installation = parseHostedInstallation(decodeHostedActivationBytes(required("host-installation.json")));
  const activation = parseHostedActivation(decodeHostedActivationBytes(required("host-activation.json")));
  if (installation.installationId !== activation.installationId || installation.hostId !== activation.hostId) invalid();
  // The durable exclusive reference cannot disappear with mutable egress grants.
  const enrollment = readHostedActivationBytes("readonly-enrollment.json");
  if ((activation.exclusiveEnrollmentSha256 === null) !== (enrollment === null) ||
      (enrollment && digest(enrollment) !== activation.exclusiveEnrollmentSha256)) invalid();
  const epochBytes = readHostedActivationBytes("readonly-epoch.json");
  if (readHostedActivationBytes("readonly-epoch.next")) throw new Error("hosted_activation_publication_recovery_required");
  if (enrollment) {
    const jobId = parseHostedCustodyEnrollment(enrollment);
    if (!epochBytes) invalid();
    const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(epochBytes));
    const birth = parseHostedCustodyEpoch(decodeHostedActivationBytes(enrollment));
    if (activation.phase === HostedActivationPhase.Ordinary &&
        (epoch.phase !== HostedCustodyPhase.Closed ||
          epoch.reservations.some(row => row.state !== HostedCustodyReservationState.Terminal) ||
          (epoch.outerRuntime !== null && epoch.outerRuntime.state !== HostedCustodyReservationState.Terminal))) invalid();
    if (epoch.identity.jobId !== jobId || epoch.hostId !== installation.hostId || birth.hostId !== epoch.hostId ||
        Object.keys(birth.identity).some(key => birth.identity[key as keyof typeof birth.identity] !==
          epoch.identity[key as keyof typeof epoch.identity])) invalid();
  } else if (epochBytes) invalid();
  return { installation, activation };
}

/** Positive origin lookup only. Session/kernel/stage binding and the common
 * fence remain required at the submission boundary. No grant-based downgrade. */
export function readHostedOrdinaryBirth(jobId: string): {
  readonly installation: HostedInstallation; readonly activation: HostedActivation;
  readonly birth: HostedOrdinaryBirth; readonly originSha256: string;
} {
  const origin = readRetainedOrdinaryBirth(jobId);
  if (origin.activation.phase !== HostedActivationPhase.Ordinary) invalid();
  return origin;
}

function readRetainedOrdinaryBirth(jobId: string) {
  const { installation, activation } = readHostedInstallationActivation();
  const catalogBytes = required("ordinary-origins.json");
  if (digest(catalogBytes) !== activation.ordinaryOriginsSha256) invalid();
  const catalog = parseHostedOrdinaryOrigins(decodeHostedActivationBytes(catalogBytes));
  if (catalog.installationId !== installation.installationId) invalid();
  const row = catalog.origins.find(row => row.jobId === jobId);
  if (!row) invalid();
  const name = digest(Buffer.from(jobId)) + ".json";
  const bytes = required("ordinary-origins/" + name), birth = parseHostedOrdinaryBirth(decodeHostedActivationBytes(bytes));
  if (digest(bytes) !== row.birthSha256 || birth.installationId !== installation.installationId ||
      birth.jobId !== row.jobId || birth.jobRootDir !== row.jobRootDir || birth.workspacePath !== row.workspacePath) invalid();
  if (readHostedActivationBytes("codex-readonly-custody/" + name) ||
      readHostedActivationBytes("codex-readonly-revoked/" + name)) invalid();
  // Partial managed enrollment also takes priority over an older ordinary birth.
  const enrollment = readHostedActivationBytes("readonly-enrollment.json");
  if (enrollment) {
    const value = parseHostedCustodyEnrollment(enrollment);
    if (value === jobId) invalid();
  }
  return { installation, activation, birth, originSha256: row.birthSha256 };
}

/** Actual process-origin lookup for the ordinary runtime. Job ids and inherited
 * markers cannot select authority. Call under the common fence before effects;
 * generation belongs to the retained start, since sibling reservations advance
 * activation without invalidating the still-running original creator. */
export function readHostedOrdinaryRuntime(fence: HostedActivationFence) {
  const origin = readRetainedOrdinaryRuntime(fence);
  if (origin.activation.phase !== HostedActivationPhase.Ordinary ||
      assertNoManagedOrigin(origin.birth) !== origin.start.grantSha256) invalid();
  return origin;
}

/** Stop authenticates the retained actual origin; it does not grant scheduling. */
function readRetainedOrdinaryRuntime(fence: HostedActivationFence) {
  assertHostedActivationFence(fence);
  const group = readFileSync("/proc/self/cgroup", "utf8").trim();
  const match = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.service$/.exec(group);
  if (!match) invalid();
  const bytes = required(`ordinary-starts/${match[1]}.json`), start = parseHostedOrdinaryStart(decodeHostedActivationBytes(bytes));
  const origin = readRetainedOrdinaryBirth(start.jobId);
  const { installation, activation, birth, originSha256 } = origin;
  const row = activation.ordinaryStarts.find(row => row.startId === match[1]);
  if (!row || row.state !== HostedCustodyReservationState.Reserved || row.unit !== start.unit ||
      row.creatorId !== start.creatorId || row.originSha256 !== originSha256 || row.generation !== start.activationGeneration ||
      start.installationId !== installation.installationId || start.originSha256 !== originSha256 ||
      start.jobRootDir !== birth.jobRootDir || start.workspacePath !== birth.workspacePath ||
      start.controlGroup !== ordinaryUnitGroup(row) || group !== `0::${start.controlGroup}`) invalid();
  assertInspectedInstallation(installation);
  assertNoManagedOrigin(birth);
  const creator = readHostedReadonlyHostInventory().ordinaryCreators.find(row => row.creatorId === start.creatorId);
  if (!creator || creator.jobId !== birth.jobId || creator.jobRootDir !== birth.jobRootDir || creator.workspacePath !== birth.workspacePath) invalid();
  const kernel = new HostedReadonlyHostKernel();
  assertActivationSession(activation, kernel.ordinaryRuntimeSession(start));
  kernel.verifyDescriptorBoundary();
  return Object.freeze({ ...origin, start, creator, reservation: row, launch: creator.launch });
}
function parseHostedCustodyEnrollment(bytes: Buffer): string {
  const birth = parseHostedCustodyEpoch(decodeHostedActivationBytes(bytes));
  if (birth.generation !== 1 || birth.phase !== HostedCustodyPhase.Closed || birth.revoked ||
      birth.reservations.length || birth.outerRuntime !== null) invalid();
  return birth.identity.jobId;
}
function required(name: string): Buffer {
  const bytes = readHostedActivationBytes(name);
  if (!bytes) throw new Error("hosted_activation_authority_required");
  return bytes;
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function invalid(): never { throw new Error("hosted_activation_evidence_invalid"); }

function encoded(value: unknown): Buffer { return Buffer.from(JSON.stringify(value) + "\n"); }
function inspectedInstallation(): Omit<HostedInstallation, "schemaVersion" | "installationId"> {
  const inventory = readHostedReadonlyHostInventory();
  if (inventory.schemaVersion !== 2 && inventory.schemaVersion !== 3 && inventory.schemaVersion !== 4) invalid();
  const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const cliPath = join(runtimeDirectory, "dist/worker-codex/codex-goal-cli.js");
  for (const creator of inventory.ordinaryCreators) {
    const launch = creator.launch;
    if (launch.cwd !== creator.workspacePath || !(launch.command === cliPath ||
        (launch.command === process.execPath && launch.args[0] === cliPath))) invalid();
  }
  const stagePath = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + digest(Buffer.from(runtimeDirectory)) + ".json";
  const stageBytes = readHostedPrivateBytes(stagePath, 4096);
  if (!stageBytes) throw new Error("hosted_readonly_verified_stage_required");
  const stage = decodeHostedActivationBytes(stageBytes);
  if (!stage || typeof stage !== "object" || Array.isArray(stage) ||
      Object.keys(stage).sort().join(",") !== "runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion" ||
      !("schemaVersion" in stage) || stage.schemaVersion !== 1 || !("runtimeDirectory" in stage) || stage.runtimeDirectory !== runtimeDirectory ||
      !("runtimeSha" in stage) || typeof stage.runtimeSha !== "string" || !("runtimeManifestSha256" in stage) || typeof stage.runtimeManifestSha256 !== "string") invalid();
  const inventoryBytes = readHostedPrivateBytes(join(readonlySupervisorRoot, "readonly-inventory.json"), 64 * 1024);
  if (!inventoryBytes) invalid();
  return { hostId: inventory.hostId, runtimeDirectory, runtimeSha: stage.runtimeSha,
    runtimeManifestSha256: stage.runtimeManifestSha256, inventorySha256: digest(inventoryBytes) };
}
function assertInspectedInstallation(installation: HostedInstallation): void {
  const binding = inspectedInstallation();
  if (Object.keys(binding).some(key => installation[key as keyof typeof binding] !== binding[key as keyof typeof binding])) invalid();
}
function readOrdinaryCatalog(installation: HostedInstallation, expected: string): HostedOrdinaryOrigins {
  const bytes = required("ordinary-origins.json"), catalog = parseHostedOrdinaryOrigins(decodeHostedActivationBytes(bytes));
  if (digest(bytes) !== expected || catalog.installationId !== installation.installationId) invalid();
  validateCatalogBirths(catalog);
  return catalog;
}
function validateCatalogBirths(catalog: HostedOrdinaryOrigins): void {
  for (const row of catalog.origins) {
    const bytes = required("ordinary-origins/" + digest(Buffer.from(row.jobId)) + ".json");
    const birth = parseHostedOrdinaryBirth(decodeHostedActivationBytes(bytes));
    if (digest(bytes) !== row.birthSha256 || birth.installationId !== catalog.installationId || birth.jobId !== row.jobId ||
        birth.jobRootDir !== row.jobRootDir || birth.workspacePath !== row.workspacePath) invalid();
  }
}
function assertNoManagedOrigin(birth: HostedOrdinaryBirth): string | null {
  const jobId = birth.jobId;
  const name = digest(Buffer.from(jobId)) + ".json";
  if (readHostedPrivateBytes(join(hostedReadonlyPolicyRoot, name), 64 * 1024)) invalid();
  if (readHostedActivationBytes("codex-readonly-custody/" + name) || readHostedActivationBytes("codex-readonly-revoked/" + name)) invalid();
  const enrollment = readHostedActivationBytes("readonly-enrollment.json");
  if (enrollment && parseHostedCustodyEnrollment(enrollment) === jobId) invalid();
  const grantBytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, name), 4096);
  if (grantBytes) {
    const grant = parseHostedTestEgressGrant(decodeHostedActivationBytes(grantBytes));
    assertHostedTestEgressIdentity(grant, birth);
    if (grant.profileId === CodexProviderEgressProfileId.TestManagedQualification) invalid();
  }
  return grantBytes ? digest(grantBytes) : null;
}

/** Routing observation only. The positive private origin reader, never this
 * cgroup prefix or caller identity, authorizes the selected ordinary route. */
export function isHostedOrdinaryRuntime(): boolean {
  return process.platform === "linux" && /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-/.test(
    readFileSync("/proc/self/cgroup", "utf8").trim());
}
export function admitHostedOrdinaryIdentity(identity: { readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string }): CodexProviderEgressProfileId {
  return withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence);
    if (origin.birth.jobId !== identity.jobId || origin.birth.jobRootDir !== identity.jobRootDir ||
        origin.birth.workspacePath !== identity.workspacePath) invalid();
    if (origin.start.grantSha256 === null) return CodexProviderEgressProfileId.FullInternetV1;
    const name = digest(Buffer.from(identity.jobId)) + ".json";
    const bytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, name), 4096);
    if (!bytes || digest(bytes) !== origin.start.grantSha256) invalid();
    const grant = parseHostedTestEgressGrant(decodeHostedActivationBytes(bytes));
    assertHostedTestEgressIdentity(grant, identity);
    return grant.profileId;
  });
}

function managedReservations(epoch: HostedCustodyEpoch | undefined) {
  return epoch ? [...epoch.reservations, ...(epoch.outerRuntime ? [epoch.outerRuntime] : [])] : [];
}
function assertActivationSession(activation: HostedActivation, session: { hostId: string; bootId: string; supervisorId: string }): void {
  if (activation.hostId !== session.hostId || activation.bootId !== session.bootId || activation.supervisorId !== session.supervisorId) invalid();
}
function ordinaryUnitGroup(row: HostedOrdinaryReservation): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.startId) ||
      ![`subscription-runtime-ordinary-${row.startId}.service`, `subscription-runtime-hosted-${row.startId}.service`].includes(row.unit)) invalid();
  return `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`;
}

/** Scheduling admission supplements, never replaces, managed material/owner
 * checks. Both outer launch and every provider spawn call this production gate. */
export function assertExclusiveHostedActivation(epoch: HostedCustodyEpoch): void {
  const { installation, activation } = readHostedInstallationActivation();
  assertInspectedInstallation(installation);
  if (activation.phase !== HostedActivationPhase.Exclusive || activation.exclusiveEnrollmentSha256 === null ||
      activation.hostId !== epoch.hostId || activation.bootId !== epoch.bootId || activation.supervisorId !== epoch.supervisorId ||
      installation.runtimeSha !== epoch.identity.runtimeSha || installation.runtimeManifestSha256 !== epoch.identity.runtimeManifestSha256) invalid();
}
