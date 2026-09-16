import { describe, expect, it } from "vitest";
import { HostedCustodyReservationState as State } from "../domain/hosted-custody-epoch";
import { HostedActivationPhase as Phase, parseHostedActivation, parseHostedInstallation,
  parseHostedOrdinaryBirth, parseHostedOrdinaryOrigins, parseHostedOrdinaryStart,
  assertHostedActivationSuccessor, type HostedActivation } from "../domain/hosted-installation-activation";

const sha = "a".repeat(64), other = "b".repeat(64);
const closed: HostedActivation = { schemaVersion: 1, installationId: "install-1", hostId: "host-1",
  bootId: "boot-1", supervisorId: "supervisor-1", generation: 1, phase: Phase.Closed,
  ordinaryOriginsSha256: sha, exclusiveEnrollmentSha256: null, ordinaryStarts: [] };
const birth = { schemaVersion: 1, installationId: "install-1", jobId: "job-1",
  jobRootDir: "/jobs/job-1", workspacePath: "/work/job-1", origin: "ordinary" };
const reservation = { startId: "start-1", unit: "runtime-1.service", creatorId: "creator-1",
  originSha256: sha, generation: 3, state: State.Reserved };
const ordinary = { ...closed, generation: 2, phase: Phase.Ordinary };
const reserved = { ...ordinary, generation: 3, ordinaryStarts: [reservation] };
function successor(prior: HostedActivation, patch: Partial<HostedActivation>): HostedActivation {
  return { ...prior, generation: prior.generation + 1, ...patch };
}

describe("closed installation scheduling records", () => {
  it("parses and deeply freezes positive records without claiming authority", () => {
    expect(Object.isFrozen(parseHostedInstallation({ schemaVersion: 1, installationId: "install-1", hostId: "host-1",
      runtimeDirectory: "/opt/runtime", runtimeSha: "c".repeat(40), runtimeManifestSha256: sha, inventorySha256: sha }))).toBe(true);
    expect(parseHostedOrdinaryBirth(birth).origin).toBe("ordinary");
    const catalog = parseHostedOrdinaryOrigins({ schemaVersion: 1, installationId: "install-1", revision: 1,
      origins: [{ jobId: birth.jobId, jobRootDir: birth.jobRootDir, workspacePath: birth.workspacePath, birthSha256: sha }] });
    expect(Object.isFrozen(catalog.origins[0])).toBe(true);
    const parsed = parseHostedActivation(reserved);
    expect(Object.isFrozen(parsed.ordinaryStarts)).toBe(true);
    expect(Object.isFrozen(parsed.ordinaryStarts[0])).toBe(true);
    const { origin: _, ...identity } = birth;
    expect(parseHostedOrdinaryStart({ ...identity, activationGeneration: 3, bootId: "boot-1", supervisorId: "supervisor-1",
      originSha256: sha, unit: reservation.unit, controlGroup: "/system.slice/runtime-1.service",
      creatorId: "creator-1", creatorPidBirth: "123:12345", grantSha256: null }).activationGeneration).toBe(3);
  });
  it.each([undefined, null, {}, { ...closed, arbitrary: true }, { ...closed, generation: 0 },
    { ...closed, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...closed, phase: "ready" },
    { ...closed, hostId: "host\n" }, { ...closed, ordinaryOriginsSha256: "A".repeat(64) },
    { ...closed, ordinaryStarts: Array(257).fill(reservation) },
    { ...reserved, ordinaryStarts: [reservation, reservation] },
    { ...closed, phase: Phase.Exclusive }, { ...reserved, phase: Phase.Exclusive, exclusiveEnrollmentSha256: sha },
  ])("rejects malformed or ambiguous activation %#", value => expect(() => parseHostedActivation(value)).toThrow());
  it.each(["/work/../job", "/work/./job", "/work//job", "/work/job/", "relative", "/work/job\n"])(
    "rejects noncanonical origin path %s", workspacePath => expect(() => parseHostedOrdinaryBirth({ ...birth, workspacePath })).toThrow());
  it("rejects duplicate catalog identities and unknown birth fields", () => {
    const row = { jobId: "job", jobRootDir: "/jobs/job", workspacePath: "/work/job", birthSha256: sha };
    expect(() => parseHostedOrdinaryOrigins({ schemaVersion: 1, installationId: "install-1", revision: 1, origins: [row, row] })).toThrow();
    expect(() => parseHostedOrdinaryBirth({ ...birth, managed: false })).toThrow();
  });
});

describe("retained ordinary reservations and finite activation transitions", () => {
  it("retains sibling starts while exclusive entry closes submission", () => {
    assertHostedActivationSuccessor(closed, ordinary);
    assertHostedActivationSuccessor(ordinary, reserved);
    const sibling = successor(reserved, { ordinaryStarts: [reservation, { ...reservation,
      startId: "provider-1", unit: "provider-1.service", generation: 4 }] });
    assertHostedActivationSuccessor(reserved, sibling);
    const entering = successor(sibling, { phase: Phase.EnteringExclusive });
    assertHostedActivationSuccessor(sibling, entering);
    expect(() => assertHostedActivationSuccessor(entering, successor(entering, { phase: Phase.Exclusive,
      exclusiveEnrollmentSha256: sha }))).toThrow();
    const terminal = successor(entering, { ordinaryStarts: entering.ordinaryStarts.map(row => ({ ...row, state: State.Terminal })) });
    assertHostedActivationSuccessor(entering, terminal);
    const exclusive = successor(terminal, { phase: Phase.Exclusive, exclusiveEnrollmentSha256: sha });
    assertHostedActivationSuccessor(terminal, exclusive);
    const leaving = successor(exclusive, { phase: Phase.LeavingExclusive });
    assertHostedActivationSuccessor(exclusive, leaving);
    const ended = successor(leaving, { phase: Phase.Closed });
    assertHostedActivationSuccessor(leaving, ended);
    assertHostedActivationSuccessor(ended, successor(ended, { phase: Phase.Ordinary }));
    expect(() => assertHostedActivationSuccessor(ended, successor(ended, { exclusiveEnrollmentSha256: null }))).toThrow();
  });
  it.each([
    { generation: 5 }, { installationId: "foreign" }, { hostId: "foreign" }, { bootId: "reboot" },
    { supervisorId: "restarted" }, { ordinaryOriginsSha256: other }, { ordinaryStarts: [] },
    { phase: Phase.Exclusive, exclusiveEnrollmentSha256: sha },
    { ordinaryStarts: [{ ...reservation, creatorId: "foreign" }] },
    { ordinaryStarts: [{ ...reservation, state: State.Terminal }] },
  ])("rejects replacement, skipped publication or unfenced mutation %#", patch => {
    expect(() => assertHostedActivationSuccessor(reserved, successor(reserved, patch))).toThrow();
  });
  it("cannot submit after entry won or resume from an entering crash", () => {
    const entering = successor(ordinary, { phase: Phase.EnteringExclusive });
    assertHostedActivationSuccessor(ordinary, entering);
    expect(() => assertHostedActivationSuccessor(entering, successor(entering, { ordinaryStarts: [{ ...reservation, generation: 4 }] }))).toThrow();
    expect(() => assertHostedActivationSuccessor(entering, successor(entering, { phase: Phase.Ordinary }))).toThrow();
  });
  it("retains terminal births and requires closed drained state for session recovery", () => {
    const drained = { ...reserved, phase: Phase.Closed, ordinaryStarts: [{ ...reservation, state: State.Terminal }] };
    assertHostedActivationSuccessor(drained, successor(drained, { bootId: "boot-2", supervisorId: "supervisor-2" }));
    expect(() => assertHostedActivationSuccessor(drained, successor(drained, { ordinaryStarts: [reservation] }))).toThrow();
    expect(() => assertHostedActivationSuccessor({ ...reserved, phase: Phase.Closed }, successor(reserved, { phase: Phase.Closed, bootId: "boot-2" }))).toThrow();
  });
});

it("retains the first managed enrollment during ENTERING even if exclusive preparation aborts", () => {
  const entering = successor(ordinary, { phase: Phase.EnteringExclusive });
  const retained = successor(entering, { exclusiveEnrollmentSha256: sha });
  assertHostedActivationSuccessor(entering, retained);
  const aborted = successor(retained, { phase: Phase.Closed });
  assertHostedActivationSuccessor(retained, aborted);
  expect(() => assertHostedActivationSuccessor(aborted, successor(aborted, { exclusiveEnrollmentSha256: null }))).toThrow();
});
