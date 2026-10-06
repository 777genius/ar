import { createHash } from "node:crypto";
import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState, parseHostedActivation, parseHostedInstallation, parseHostedCustodyEpoch,
  parseHostedOrdinaryBirth, parseHostedOrdinaryOrigins, type HostedInstallation, type HostedActivation, type HostedOrdinaryBirth, type HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import { readHostedActivationBytes, decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
function required(name:string):Buffer {const bytes=readHostedActivationBytes(name);if (!bytes) throw new Error("hosted_activation_authority_required");return bytes;}
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function invalid():never {throw new Error("hosted_activation_evidence_invalid");}
/** Same fixed installation/catalog/selected-birth factual reader. No process,
 * reservation, terminal or descriptor-policy issuance lives in this module. */
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

export function readRetainedOrdinaryBirth(jobId: string) {
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

function parseHostedCustodyEnrollment(bytes: Buffer): string {
  const birth = parseHostedCustodyEpoch(decodeHostedActivationBytes(bytes));
  if (birth.generation !== 1 || birth.phase !== HostedCustodyPhase.Closed || birth.revoked ||
      birth.reservations.length || birth.outerRuntime !== null) invalid();
  return birth.identity.jobId;
}
export function ordinaryUnitGroup(row: HostedOrdinaryReservation): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.startId) ||
      ![`subscription-runtime-ordinary-${row.startId}.service`, `subscription-runtime-hosted-${row.startId}.service`].includes(row.unit)) invalid();
  return `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`;
}
