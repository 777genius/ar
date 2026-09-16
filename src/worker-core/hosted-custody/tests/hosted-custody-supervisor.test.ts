import { describe, expect, it } from "vitest";
import { HostedCustodyLaunchKind, HostedCustodySupervisor } from "../hosted-custody-supervisor";
import { HostedCustodyPhase as Phase, HostedCustodyReservationState as ReservationState,
  HostedCustodyRequirement, parseHostedCustodyEpoch, type HostedCustodyEpoch, type HostedCustodyIdentity,
} from "../domain/hosted-custody-epoch";
import type { HostedCustodySupervisorPort } from "../ports/hosted-custody-supervisor-port";

const identity: HostedCustodyIdentity = {
  jobId: "TEST", jobRootDir: "/synthetic/job", workspacePath: "/synthetic/W",
  runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
  issuerDeploymentDigest: "c".repeat(64), policySha256: "d".repeat(64),
  reviewSha256: "e".repeat(64), stageSha256: "f".repeat(64), grantSha256: "0".repeat(64),
};
const reservation = { startId: "start-A", unit: "unit-A", creatorId: "creator-A" };

/** Explicit simulated host port. These tests prove application ordering and
 * retained safety state, not root authority, fsync, mounts or host exclusivity. */
class Host implements HostedCustodySupervisorPort {
  value: unknown = { schemaVersion: 1, hostId: "host", bootId: "boot-A", supervisorId: "supervisor-A",
    outerRuntime: null, generation: 1, requirement: HostedCustodyRequirement.TestManagedQualification,
    identity, phase: Phase.Closed, revoked: false, reservations: [] };
  current = { hostId: "host", bootId: "boot-A", supervisorId: "supervisor-A" };
  events: string[] = [];
  failure: string | undefined;
  locked = false;
  get epoch(): HostedCustodyEpoch { return parseHostedCustodyEpoch(this.value); }
  serialized<T>(action: () => T): T {
    if (this.locked) throw new Error("host-fence-held");
    this.locked = true;
    try { return action(); } finally { this.locked = false; }
  }
  recoverSerialized<T>(action: () => T): T { return this.serialized(action); }
  record(event: string): void {
    expect(this.locked).toBe(true);
    this.events.push(event);
    if (event === this.failure) throw new Error(event);
  }
  readEpoch(): unknown { this.record("read"); return this.value; }
  publishEpoch(epoch: HostedCustodyEpoch): void {
    this.record(`publish:${epoch.phase}:${epoch.revoked}`);
    this.value = structuredClone(epoch);
  }
  session() { this.record("session"); return this.current; }
  verifyRuntimeOwner() {} // Explicit synthetic ownership; kernel tests cover the real adapter.
  verifyExclusiveInventory() { this.record("inventory"); }
  verifyReadonlyMaterial() { this.record("material"); }
  verifyDescriptorBoundary() { this.record("descriptors"); }
  fenceCreator() { this.record("creator"); }
  drainQueuedStart() { this.record("queue"); }
  confirmTerminalDescendants() { this.record("descendants"); }
  requestStop() { this.record("stop"); }
}
function ready() {
  const host = new Host(), supervisor = new HostedCustodySupervisor(host);
  supervisor.recover(identity); host.events = [];
  const start = (submit: () => unknown = () => host.record("submit")) =>
    supervisor.start(HostedCustodyLaunchKind.ManagedProvider, identity, host.epoch.generation, reservation, submit);
  return { host, supervisor, start };
}

describe("finite exclusive epoch application contract (simulated host)", () => {
  it("closes durably before any recovery observation, then publishes READY last", () => {
    const host = new Host(); new HostedCustodySupervisor(host).recover(identity);
    expect(host.events).toEqual(["read", "publish:closed:false", "session", "publish:closed:false", "inventory", "material", "descriptors", "publish:ready:false"]);
  });
  it.each(["inventory", "material", "descriptors"])("failed %s leaves recovery CLOSED", failure => {
    const host = new Host(); host.failure = failure;
    expect(() => new HostedCustodySupervisor(host).recover(identity)).toThrow(failure);
    expect(host.epoch.phase).toBe(Phase.Closed);
  });
  it("publishes reservation before submission under the same fence", () => {
    const { host, start } = ready();
    start(() => {
      expect(host.locked).toBe(true);
      expect(host.epoch.reservations[0]?.state).toBe(ReservationState.Reserved);
      host.record("submit");
    });
    expect(host.events.slice(-2)).toEqual(["publish:ready:false", "submit"]);
  });
  it("failed submission cannot release its start or let a second account start", () => {
    const { host, supervisor, start } = ready();
    expect(() => start(() => { throw new Error("partial-submission"); })).toThrow("partial-submission");
    expect(host.epoch.reservations[0]?.state).toBe(ReservationState.Reserved);
    expect(() => supervisor.start(HostedCustodyLaunchKind.ManagedProvider, identity, host.epoch.generation,
      { startId: "B", unit: "B", creatorId: "B" }, () => host.record("unsafe-submit"))).toThrow("start_denied");
    expect(host.events).not.toContain("unsafe-submit");
  });
  it.each([HostedCustodyLaunchKind.Ordinary, HostedCustodyLaunchKind.Legacy])(
    "excludes %s even with the selected managed job identity", kind => {
      const { host, supervisor } = ready();
      expect(() => supervisor.start(kind, identity, host.epoch.generation, reservation, () => host.record("unsafe-submit"))).toThrow("start_denied");
      expect(host.events).not.toContain("unsafe-submit");
    });
  it.each(Object.keys(identity) as (keyof HostedCustodyIdentity)[])("binds exact %s", key => {
    const { host, supervisor } = ready();
    const changed = { ...identity, [key]: key.endsWith("Sha256") || key === "issuerDeploymentDigest" ? "1".repeat(64) :
      key === "runtimeSha" ? "1".repeat(40) : key === "jobId" ? "other" : "/other" };
    expect(() => supervisor.start(HostedCustodyLaunchKind.ManagedProvider, changed, host.epoch.generation, reservation,
      () => host.record("unsafe-submit"))).toThrow("identity_mismatch");
    expect(host.events).not.toContain("unsafe-submit");
  });
  it.each(["hostId", "bootId", "supervisorId"] as const)("requires CLOSED recovery after %s changes", key => {
    const { host, start } = ready(); host.current[key] = "new";
    expect(() => start()).toThrow("recovery_required");
    expect(host.epoch.phase).toBe(Phase.Closed);
  });
  it.each(["creator", "queue", "descendants"])("%s ambiguity cannot release a reservation", failure => {
    const { host, supervisor, start } = ready(); start(); host.failure = failure;
    expect(() => supervisor.reconcile("start-A")).toThrow(failure);
    expect(host.epoch.reservations[0]?.state).toBe(ReservationState.Reserved);
  });
  it("allows account turnover only after creator, manager queue and descendants are terminal", () => {
    const { host, supervisor, start } = ready(); start(); host.events = [];
    supervisor.reconcile("start-A");
    expect(host.events).toEqual(["read", "session", "creator", "queue", "descendants", "publish:ready:false"]);
    supervisor.start(HostedCustodyLaunchKind.ManagedProvider, identity, host.epoch.generation,
      { startId: "start-B", unit: "unit-B", creatorId: "creator-B" }, () => host.record("submit-B"));
    expect(host.epoch.reservations.map(record => record.state)).toEqual([ReservationState.Terminal, ReservationState.Reserved]);
  });
  it.each(["inventory", "material", "descriptors"])("revalidates %s after terminal account turnover", failure => {
    const { host, supervisor, start } = ready(); start(); supervisor.reconcile("start-A");
    host.failure = failure;
    expect(() => supervisor.start(HostedCustodyLaunchKind.ManagedProvider, identity, host.epoch.generation,
      { startId: "start-B", unit: "unit-B", creatorId: "creator-B" }, () => host.record("unsafe-submit")))
      .toThrow(failure);
    expect(host.epoch.phase).toBe(Phase.Closed);
    expect(host.epoch.reservations).toHaveLength(1);
    expect(host.events).not.toContain("unsafe-submit");
  });
  it("rejects replay of either terminal unit or start id", () => {
    for (const duplicate of [{ ...reservation, unit: "new" }, { ...reservation, startId: "new" }]) {
      const { host, supervisor, start } = ready(); start(); supervisor.reconcile("start-A");
      expect(() => supervisor.start(HostedCustodyLaunchKind.ManagedProvider, identity, host.epoch.generation, duplicate,
        () => host.record("unsafe-submit"))).toThrow("epoch_invalid");
      expect(host.events).not.toContain("unsafe-submit");
    }
  });
  it("revokes durably before stopping; failure and reboot cannot un-revoke", () => {
    const { host, supervisor, start } = ready(); start(); host.events = []; host.failure = "stop";
    expect(() => supervisor.revoke(identity)).toThrow("stop");
    expect(host.events).toEqual(["read", "publish:closed:true", "stop"]);
    expect(host.epoch.revoked).toBe(true);
    expect(host.epoch.reservations[0]?.state).toBe(ReservationState.Reserved);
    host.current = { ...host.current, bootId: "boot-B", supervisorId: "supervisor-B" };
    host.failure = undefined;
    expect(() => new HostedCustodySupervisor(host).recover(identity)).toThrow("recovery_required");
    expect(host.epoch.revoked).toBe(true);
  });
  it("same-boot and reboot recovery both reconcile retained starts, rather than deleting them", () => {
    for (const bootId of ["boot-A", "boot-B"]) {
      const { host, start } = ready(); start(); host.events = [];
      host.current = { ...host.current, bootId, supervisorId: "supervisor-B" };
      new HostedCustodySupervisor(host).recover(identity);
      expect(host.events.indexOf("publish:closed:false")).toBeLessThan(host.events.indexOf("creator"));
      expect(host.epoch.reservations[0]?.state).toBe(ReservationState.Terminal);
      expect(host.epoch.bootId).toBe(bootId);
    }
  });
  it.each([undefined, null, {}, "{", { schemaVersion: 1 }])("does not recreate lost/corrupt authority: %j", value => {
    const host = new Host(); host.value = value;
    expect(() => new HostedCustodySupervisor(host).recover(identity)).toThrow("epoch_invalid");
    expect(host.events).toEqual(["read"]);
    expect(host.value).toBe(value);
  });
  it("refuses reentrant launch/revoke while reserve/submission holds the common fence", () => {
    const { host, supervisor, start } = ready();
    start(() => expect(() => supervisor.revoke(identity)).toThrow("host-fence-held"));
    expect(host.epoch.revoked).toBe(false);
    supervisor.revoke(identity); expect(host.epoch.revoked).toBe(true);
  });
  it("rejects open-schema records, invalid generations and more than one outstanding start", () => {
    const { host, start } = ready(); start(); const epoch = host.epoch;
    for (const value of [
      { ...epoch, extra: true }, { ...epoch, generation: 0 }, { ...epoch, generation: 1.1 },
      { ...epoch, requirement: "ordinary" }, { ...epoch, requirement: undefined },
      { ...epoch, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...epoch, revoked: "false" },
      { ...epoch, identity: { ...identity, extra: true } },
      { ...epoch, reservations: [...epoch.reservations, { ...reservation, startId: "B", unit: "B", state: ReservationState.Reserved }] },
    ]) expect(() => parseHostedCustodyEpoch(value)).toThrow("epoch_invalid");
  });
  it("same-session recovery consumes monotonic generations even when fresh material fails", () => {
    const host = new Host(), supervisor = new HostedCustodySupervisor(host);
    supervisor.recover(identity);
    expect(host.epoch.generation).toBe(2);
    host.failure = "material";
    expect(() => supervisor.recover(identity)).toThrow("material");
    expect(host.epoch.generation).toBe(3);
    expect(host.epoch.phase).toBe(Phase.Closed);
    host.failure = undefined;
    supervisor.recover(identity);
    expect(host.epoch.generation).toBe(4);
  });
  it("generation exhaustion closes the epoch without resetting its history", () => {
    const host = new Host();
    host.value = { ...host.epoch, phase: Phase.Ready, generation: Number.MAX_SAFE_INTEGER };
    expect(() => new HostedCustodySupervisor(host).recover(identity)).toThrow("epoch_invalid");
    expect(host.epoch.phase).toBe(Phase.Closed);
    expect(host.epoch.generation).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a cached generation before reserving or submitting, even in the same session", () => {
    const { host, supervisor } = ready(), generation = host.epoch.generation;
    supervisor.recover(identity);
    expect(() => supervisor.start(HostedCustodyLaunchKind.ManagedProvider, identity, generation,
      reservation, () => host.record("unsafe-submit"))).toThrow("generation_changed");
    expect(host.epoch.phase).toBe(Phase.Closed);
    expect(host.epoch.reservations).toEqual([]);
    expect(host.events).not.toContain("unsafe-submit");
  });

});

it.each(["creator", "queue", "descendants"])("outer %s ambiguity prevents recovery and retains its reservation", failure => {
  const host = new Host();
  const outer = { ...reservation, generation: 1, state: ReservationState.Reserved };
  host.value = { ...host.epoch, outerRuntime: outer };
  host.failure = failure;
  expect(() => new HostedCustodySupervisor(host).recover(identity)).toThrow(failure);
  expect(host.epoch.outerRuntime).toEqual(outer);
  expect(host.epoch.phase).toBe(Phase.Closed);
  expect(host.events).not.toContain("inventory");
});
it("recovery requires outer creator, queue and descendants before READY", () => {
  const host = new Host();
  host.value = { ...host.epoch, outerRuntime: { ...reservation, generation: 1, state: ReservationState.Reserved } };
  new HostedCustodySupervisor(host).recover(identity);
  expect(host.epoch.outerRuntime!.state).toBe(ReservationState.Terminal);
  expect(host.events.indexOf("creator")).toBeLessThan(host.events.indexOf("queue"));
  expect(host.events.indexOf("queue")).toBeLessThan(host.events.indexOf("descendants"));
  expect(host.events.indexOf("descendants")).toBeLessThan(host.events.indexOf("inventory"));
  expect(host.epoch.phase).toBe(Phase.Ready);
});
it("revocation attempts both nested and outer stops even when the first fails", () => {
  const { host, supervisor, start } = ready(); start(); host.events = [];
  host.value = { ...host.epoch, outerRuntime: { startId: "outer-A", creatorId: "outer-A", unit: "outer-unit-A", generation: 1, state: ReservationState.Reserved } };
  host.failure = "stop";
  expect(() => supervisor.revoke(identity)).toThrow("stop_incomplete");
  expect(host.events.filter(event => event === "stop")).toHaveLength(2);
  expect(host.epoch.revoked).toBe(true);
  expect(host.epoch.outerRuntime!.state).toBe(ReservationState.Reserved);
});
