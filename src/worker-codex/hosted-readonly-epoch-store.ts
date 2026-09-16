import { closeSync, constants, fsyncSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HostedCustodyPhase, HostedCustodyRequirement, HostedCustodyReservationState, parseHostedCustodyEpoch,
  type HostedCustodyEpoch, type HostedCustodyIdentity } from "@vioxen/subscription-runtime/worker-core";
import { assertReadonlyHostOperator, decodePrivateJson, readonlyIdentityName } from "./hosted-readonly-authority";
import { createReadonlyPrivateRecord, readonlyCustodyRoot, readonlyRevokedRoot, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { withHostedActivationFence, assertHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";

export const readonlyEpochPath = join(readonlySupervisorRoot, "readonly-epoch.json");
export const readonlyEnrollmentPath = join(readonlySupervisorRoot, "readonly-enrollment.json");
const nextPath = join(readonlySupervisorRoot, "readonly-epoch.next");

/** Fixed-root durable adapter, not a host inventory or readiness authority.
 * An absent/corrupt epoch never becomes an empty ordinary-host record. No
 * implicit initialization, path override, stale-lock removal or de-enrollment is exposed.
 * A crash between next-file creation and rename retains that file as evidence. */
export class HostedReadonlyEpochStore {
  private locked = false;

  readEpoch(): HostedCustodyEpoch {
    const epoch = this.readCommittedEpoch();
    if (!this.locked && readHostedPrivateBytes(nextPath, 64 * 1024)) {
      throw new Error("hosted_custody_publication_recovery_required");
    }
    return epoch;
  }

  enrolledIdentity(jobId: string): HostedCustodyIdentity {
    assertReadonlyHostOperator();
    const birth = this.readEnrollment();
    if (birth.identity.jobId !== jobId) throw new Error("hosted_custody_enrollment_mismatch");
    return birth.identity;
  }

  private readCommittedEpoch(): HostedCustodyEpoch {
    assertReadonlyHostOperator();
    const bytes = readHostedPrivateBytes(readonlyEpochPath, 64 * 1024);
    if (!bytes) throw new Error("hosted_custody_durable_authority_required");
    const epoch = parseHostedCustodyEpoch(decodePrivateJson(bytes));
    const birth = this.readEnrollment();
    if (!sameEnrollment(birth, epoch)) throw new Error("hosted_custody_enrollment_mismatch");
    return epoch;
  }

  private readEnrollment(): HostedCustodyEpoch {
    const enrollment = readHostedPrivateBytes(readonlyEnrollmentPath, 64 * 1024);
    if (!enrollment) throw new Error("hosted_custody_durable_authority_required");
    const birth = parseHostedCustodyEpoch(decodePrivateJson(enrollment));
    if (birth.generation !== 1 || birth.phase !== HostedCustodyPhase.Closed || birth.revoked || birth.reservations.length || birth.outerRuntime !== null) {
      throw new Error("hosted_custody_enrollment_mismatch");
    }
    return birth;
  }

  /** Explicit host-operator first enrollment only, never called by admission or
   * resume. Publish permanent identity before the mutable CLOSED epoch. A partial
   * creation or loss of either record stays CLOSED; do not reconstruct history
   * from a seed that cannot prove whether a later revocation existed. */
  enroll(identity: HostedCustodyIdentity, session: {
    readonly hostId: string; readonly bootId: string; readonly supervisorId: string;
  }): HostedCustodyEpoch {
    return withHostedActivationFence(fence => this.enrollWithHeldFence(fence, identity, session));
  }

  enrollWithHeldFence(fence: HostedActivationFence, identity: HostedCustodyIdentity, session: {
    readonly hostId: string; readonly bootId: string; readonly supervisorId: string;
  }): HostedCustodyEpoch {
    assertHostedActivationFence(fence);
    assertReadonlyHostOperator();
    const birth = parseHostedCustodyEpoch({ schemaVersion: 1, ...session, generation: 1,
      requirement: HostedCustodyRequirement.TestManagedQualification, identity,
      phase: HostedCustodyPhase.Closed, revoked: false, reservations: [], outerRuntime: null });
    // The private reader validates ancestry even when the final file is absent.
    readHostedPrivateBytes(readonlyEnrollmentPath, 64 * 1024);
    if (readHostedPrivateBytes(readonlyEpochPath, 64 * 1024)) {
      const epoch = this.readEpoch();
      if (epoch.revoked || !sameEnrollment(epoch, birth)) throw new Error("hosted_custody_enrollment_mismatch");
      return epoch;
    }
    const name = readonlyIdentityName(identity.jobId);
    if (readHostedPrivateBytes(readonlyEnrollmentPath, 64 * 1024) || readHostedPrivateBytes(nextPath, 64 * 1024) ||
        readHostedPrivateBytes(join(readonlyCustodyRoot, name), 4096) ||
        readHostedPrivateBytes(join(readonlyRevokedRoot, name), 4096)) {
      throw new Error("hosted_custody_durable_authority_required");
    }
    const bytes = Buffer.from(JSON.stringify(birth) + "\n");
    createReadonlyPrivateRecord(readonlyEnrollmentPath, bytes);
    createReadonlyPrivateRecord(readonlyEpochPath, bytes);
    return this.readEpoch();
  }

  serialized<T>(action: () => T): T {
    return this.withLock(action, false);
  }

  /** Explicit recovery alone may finish a retained, valid immediate successor.
   * It uses the same mutex and publication validator, never deletes a conflict
   * or regenerates state from the immutable birth record. */
  recoverSerialized<T>(action: () => T): T {
    return this.withLock(action, true);
  }

  private withLock<T>(action: () => T, recoverPublication: boolean): T {
    this.readCommittedEpoch();
    return withHostedActivationFence(fence => this.withHeldFence(fence, action, recoverPublication));
  }

  /** Worker activation composition may already own the same mutex. The token is
   * valid only synchronously in the provider-owned fence, never caller JSON. */
  withHeldFence<T>(fence: HostedActivationFence, action: () => T, recoverPublication = false): T {
    assertHostedActivationFence(fence);
    if (this.locked) throw new Error("hosted_custody_common_fence_required");
    this.locked = true;
    try {
      this.readCommittedEpoch();
      const pending = readHostedPrivateBytes(nextPath, 64 * 1024);
      if (pending) {
        if (!recoverPublication) throw new Error("hosted_custody_publication_recovery_required");
        this.publishEpoch(parseHostedCustodyEpoch(decodePrivateJson(pending)));
      }
      if (recoverPublication) this.publishEpoch({ ...this.readEpoch(), phase: HostedCustodyPhase.Closed });
      return action();
    } finally { this.locked = false; }
  }

  publishEpoch(value: HostedCustodyEpoch): void {
    if (!this.locked) throw new Error("hosted_custody_common_fence_required");
    const prior = this.readEpoch(), next = parseHostedCustodyEpoch(value);
    // This adapter updates an enrolled epoch. Replacing its identity, resetting generation,
    // forgetting reservations, un-revoking or replaying a terminal unit is not a
    // phase update, even when called by trusted code with structurally valid JSON.
    const rotation = !prior.revoked && prior.phase === HostedCustodyPhase.Closed &&
      next.generation === prior.generation + 1 && Object.keys(prior).every(key =>
        key === "generation" || JSON.stringify(prior[key as keyof HostedCustodyEpoch]) === JSON.stringify(next[key as keyof HostedCustodyEpoch]));
    // Session replacement is the final recovery publication, after all old
    // starts became terminal. Otherwise a retained next record could rewrite
    // their boot and make recovery skip a live creator's same-boot fence.
    const reopening = prior.phase === HostedCustodyPhase.Closed && next.phase === HostedCustodyPhase.Ready;
    const sessionChanged = prior.bootId !== next.bootId || prior.supervisorId !== next.supervisorId;
    const readyPublication = reopening && !prior.revoked &&
      prior.reservations.every(record => record.state === HostedCustodyReservationState.Terminal) &&
      (prior.outerRuntime === null || prior.outerRuntime.state === HostedCustodyReservationState.Terminal) &&
      Object.keys(prior).every(key => ["phase", "bootId", "supervisorId"].includes(key) ||
        JSON.stringify(prior[key as keyof HostedCustodyEpoch]) === JSON.stringify(next[key as keyof HostedCustodyEpoch]));
    const beforeOuter = prior.outerRuntime, afterOuter = next.outerRuntime;
    const outerChanged = JSON.stringify(beforeOuter) !== JSON.stringify(afterOuter);
    const outerTerminal = beforeOuter !== null && afterOuter !== null &&
      afterOuter.state === HostedCustodyReservationState.Terminal &&
      Object.keys(beforeOuter).every(key => key === "state" ||
        beforeOuter[key as keyof typeof beforeOuter] === afterOuter[key as keyof typeof afterOuter]);
    const outerReservation = afterOuter !== null && afterOuter.state === HostedCustodyReservationState.Reserved &&
      afterOuter.generation === prior.generation && prior.phase === HostedCustodyPhase.Ready && !prior.revoked &&
      (beforeOuter === null || (beforeOuter.state === HostedCustodyReservationState.Terminal && beforeOuter.generation < prior.generation &&
        beforeOuter.startId !== afterOuter.startId && beforeOuter.unit !== afterOuter.unit)) &&
      prior.reservations.every(item => item.state === HostedCustodyReservationState.Terminal);
    const isolatedOuterChange = Object.keys(prior).every(key => key === "outerRuntime" ||
      JSON.stringify(prior[key as keyof HostedCustodyEpoch]) === JSON.stringify(next[key as keyof HostedCustodyEpoch]));
    if ((outerChanged && (!(outerTerminal || outerReservation) || !isolatedOuterChange)) ||
        ((reopening || sessionChanged) && !readyPublication) ||
        prior.hostId !== next.hostId || (prior.generation !== next.generation && !rotation) ||
        Object.keys(prior.identity).some(key => prior.identity[key as keyof typeof prior.identity] !==
          next.identity[key as keyof typeof next.identity]) ||
        (prior.revoked && !next.revoked) || next.reservations.length < prior.reservations.length ||
        next.reservations.length > prior.reservations.length + 1 ||
        prior.reservations.some((record, index) => {
          const current = next.reservations[index];
          return !current || record.startId !== current.startId || record.unit !== current.unit ||
            record.creatorId !== current.creatorId || (record.state === HostedCustodyReservationState.Terminal &&
              current.state !== HostedCustodyReservationState.Terminal);
        })) throw new Error("hosted_custody_epoch_replacement_denied");
    const bytes = Buffer.from(JSON.stringify(next) + "\n");
    if (bytes.length > 64 * 1024) throw new Error("hosted_custody_epoch_invalid");
    // create-only + byte-identical replay preserves partial publication. A
    // different retained .next requires explicit trusted recovery, never unlink.
    createReadonlyPrivateRecord(nextPath, bytes);
    renameSync(nextPath, readonlyEpochPath);
    const parent = openSync(readonlySupervisorRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
function sameEnrollment(left: HostedCustodyEpoch, right: HostedCustodyEpoch): boolean {
  return left.hostId === right.hostId && Object.keys(left.identity).every(key =>
    left.identity[key as keyof HostedCustodyIdentity] === right.identity[key as keyof HostedCustodyIdentity]);
}
