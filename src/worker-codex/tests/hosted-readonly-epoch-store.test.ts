import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedCustodyPhase, HostedCustodyReservationState, HostedCustodyRequirement } from "@vioxen/subscription-runtime/worker-core";
import { HostedReadonlyEpochStore, readonlyEnrollmentPath, readonlyEpochPath } from "../hosted-readonly-epoch-store";

// Real disposable file writes/rename/fsync; fixed authority path and host-root
// metadata are mapped explicitly for this test. No genuine authority is read or
// created. This does not test host namespaces, ownership or operational custody.
const fixture = vi.hoisted(() => ({ boot: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12), root: "", failRename: false, failEnrollment: false, synced: [] as string[], handles: new Map<number, string>() }));
const prefix = "/var/lib/subscription-runtime-host-policy";
function local(path: string): string {
  if (["/", "/var", "/var/lib", prefix].includes(path)) return fixture.root;
  if (path.startsWith(prefix + "/")) return join(fixture.root, path.slice(prefix.length + 1));
  throw new Error("unexpected test filesystem path");
}
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real,
    readFileSync: (path: string, options: Parameters<typeof real.readFileSync>[1]) =>
      path === "/proc/sys/kernel/random/boot_id" ? fixture.boot + "\n" :
        path === "/proc/self/uid_map" ? "0 0 4294967295\n" : real.readFileSync(path, options),
    readlinkSync: (path: string) => path.startsWith("/proc/") ? "namespace:1" : real.readlinkSync(path),
    lstatSync: (path: string) => Object.assign(real.lstatSync(local(path)), { uid: 0 }),
    fstatSync: (fd: number) => Object.assign(real.fstatSync(fd), { uid: 0 }),
    mkdirSync: (path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), options),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
    renameSync: (from: string, to: string) => {
      if (fixture.failRename) throw new Error("synthetic rename failure");
      return real.renameSync(local(from), local(to));
    },
    openSync: (path: string, flags: number, mode: number) => {
      if (fixture.failEnrollment && path.endsWith("/readonly-epoch.json") && (flags & real.constants.O_CREAT)) throw new Error("synthetic interrupted enrollment");
      const fd = real.openSync(local(path), flags, mode); fixture.handles.set(fd, path); return fd;
    },
    closeSync: (fd: number) => { fixture.handles.delete(fd); real.closeSync(fd); },
    fsyncSync: (fd: number) => { fixture.synced.push(fixture.handles.get(fd)!); real.fsyncSync(fd); },
  };
});
vi.mock("../hosted-readonly-authority", async importOriginal => ({
  ...await importOriginal<typeof import("../hosted-readonly-authority")>(),
  assertReadonlyHostOperator: () => {},
}));
vi.mock("../hosted-readonly-inputs", async importOriginal => {
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...await importOriginal<typeof import("../hosted-readonly-inputs")>(),
    readHostedPrivateBytes: (path: string, limit: number) => {
      try {
        const bytes = realFs.readFileSync(local(path));
        if (bytes.length > limit) throw new Error("oversized fixture authority");
        return bytes;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
  };
});

const initial = () => ({ schemaVersion: 1 as const, hostId: "host", bootId: "boot-A", supervisorId: "supervisor-A",
  outerRuntime: null, generation: 3, requirement: HostedCustodyRequirement.TestManagedQualification,
  phase: HostedCustodyPhase.Closed, revoked: false, reservations: [], identity: {
    jobId: "TEST", jobRootDir: "/synthetic/job", workspacePath: "/synthetic/W", runtimeSha: "a".repeat(40),
    runtimeManifestSha256: "b".repeat(64), issuerDeploymentDigest: "c".repeat(64), policySha256: "d".repeat(64),
    reviewSha256: "e".repeat(64), stageSha256: "f".repeat(64), grantSha256: "0".repeat(64),
  } });
function seed() {
  writeFileSync(local(readonlyEnrollmentPath), JSON.stringify({ ...initial(), generation: 1 }), { mode: 0o600 });
  writeFileSync(local(readonlyEpochPath), JSON.stringify(initial()), { mode: 0o600 });
}

beforeEach(() => { vi.spyOn(process, "getuid").mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

describe("fixed epoch durable store with real disposable files", () => {
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), "readonly-epoch-store-"));
    fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fixture.failRename = false; fixture.failEnrollment = false; fixture.synced = []; fixture.handles.clear(); seed();
  });
  afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));

  it("retains a crashed mutex; only another actual boot can enter explicit recovery", () => {
    const retained = prefix + `/readonly-epoch.${fixture.boot}.lock`;
    mkdirSync(retained, { mode: 0o700 });
    const store = new HostedReadonlyEpochStore();
    expect(() => store.serialized(() => {})).toThrow();
    expect(() => store.recoverSerialized(() => {})).toThrow();
    // Simulated kernel boot change. Production never accepts this from caller
    // arguments or an operator receipt, and never removes the old lock.
    fixture.boot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let recovered = false;
    store.recoverSerialized(() => { recovered = true; });
    expect(recovered).toBe(true);
    expect(() => mkdirSync(retained, { mode: 0o700 })).toThrow();
    expect(store.readEpoch().phase).toBe(HostedCustodyPhase.Closed);
  });
  it("never migrates an unversioned retained mutex or accepts malformed boot identity", () => {
    mkdirSync(prefix + "/readonly-epoch.lock", { mode: 0o700 });
    expect(() => new HostedReadonlyEpochStore().recoverSerialized(() => {})).toThrow();
    rmSync(local(prefix + "/readonly-epoch.lock"), { recursive: true });
    fixture.boot = "../../untrusted";
    expect(() => new HostedReadonlyEpochStore().serialized(() => {})).toThrow("boot_identity_invalid");
  });

  it("persists revocation across adapter recreation; fsyncs next before rename and parent after", () => {
    const store = new HostedReadonlyEpochStore();
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), revoked: true }));
    expect(new HostedReadonlyEpochStore().readEpoch().revoked).toBe(true);
    expect(fixture.synced[0]).toBe(prefix + "/readonly-epoch.next");
    expect(fixture.synced.at(-1)).toBe(prefix);
  });
  it("rejects publish without the common lock and serializes independent store instances", () => {
    const first = new HostedReadonlyEpochStore(), second = new HostedReadonlyEpochStore();
    expect(() => first.publishEpoch(initial())).toThrow("common_fence_required");
    first.serialized(() => expect(() => second.serialized(() => {})).toThrow());
    expect(() => second.serialized(() => {})).not.toThrow();
  });
  it.each(["missing", "corrupt", "oversized"])("%s durable authority is not recreated", kind => {
    const path = local(readonlyEpochPath);
    if (kind === "missing") rmSync(path); else writeFileSync(path, kind === "corrupt" ? "{" : "x".repeat(65537));
    const store = new HostedReadonlyEpochStore();
    expect(() => store.serialized(() => store.publishEpoch(initial()))).toThrow();
    if (kind === "missing") expect(() => readFileSync(path)).toThrow();
    else expect(readFileSync(path, "utf8")).toBe(kind === "corrupt" ? "{" : "x".repeat(65537));
  });
  it("retains a failed publication, denies ordinary admission and explicitly recovers exact bytes", () => {
    const store = new HostedReadonlyEpochStore(), revoked = { ...store.readEpoch(), revoked: true };
    fixture.failRename = true;
    expect(() => store.serialized(() => store.publishEpoch(revoked))).toThrow("rename failure");
    expect(() => store.readEpoch()).toThrow("publication_recovery_required");
    expect(JSON.parse(readFileSync(local(readonlyEpochPath), "utf8")).revoked).toBe(false);
    expect(JSON.parse(readFileSync(join(fixture.root, "readonly-epoch.next"), "utf8")).revoked).toBe(true);
    fixture.failRename = false;
    expect(() => store.serialized(() => store.publishEpoch(initial()))).toThrow("publication_recovery_required");
    store.recoverSerialized(() => {
      expect(store.readEpoch().phase).toBe(HostedCustodyPhase.Closed);
      expect(store.readEpoch().revoked).toBe(true);
    });
    expect(new HostedReadonlyEpochStore().readEpoch().revoked).toBe(true);
  });
  it("cannot un-revoke, change enrollment identity or reset/increment the enrolled generation", () => {
    const store = new HostedReadonlyEpochStore();
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), revoked: true }));
    for (const mutation of [{ revoked: false }, { generation: 1 }, { generation: 4 }, { hostId: "other" },
      { identity: { ...initial().identity, workspacePath: "/other" } }]) {
      expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), ...mutation })))
        .toThrow("replacement_denied");
    }
  });
  it("never forgets a unit, reuses a terminal start, or changes its creator", () => {
    const store = new HostedReadonlyEpochStore();
    const record = { startId: "A", unit: "unit-A", creatorId: "creator-A", state: HostedCustodyReservationState.Terminal };
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), reservations: [record] }));
    for (const reservations of [[], [{ ...record, creatorId: "other" }],
      [{ ...record, state: HostedCustodyReservationState.Reserved }]]) {
      expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), reservations })))
        .toThrow("replacement_denied");
    }
  });
  it("explicit first enrollment persists immutable identity before a CLOSED generation 1", () => {
    rmSync(local(readonlyEpochPath)); rmSync(local(readonlyEnrollmentPath));
    const store = new HostedReadonlyEpochStore(), { identity, hostId, bootId, supervisorId } = initial();
    const epoch = store.enroll(identity, { hostId, bootId, supervisorId });
    expect(epoch.phase).toBe(HostedCustodyPhase.Closed);
    expect(epoch.generation).toBe(1);
    expect(epoch.reservations).toEqual([]);
    expect(fixture.synced.indexOf(readonlyEnrollmentPath)).toBeLessThan(fixture.synced.indexOf(readonlyEpochPath));
    expect(new HostedReadonlyEpochStore().readEpoch()).toEqual(epoch);
  });
  it("identical explicit enrollment cannot reset generation, reservations or revocation", () => {
    const store = new HostedReadonlyEpochStore(), { identity, hostId, bootId, supervisorId } = initial();
    expect(store.enroll(identity, { hostId, bootId, supervisorId }).generation).toBe(3);
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), revoked: true }));
    expect(() => store.enroll(identity, { hostId, bootId, supervisorId })).toThrow("enrollment_mismatch");
    expect(store.readEpoch().revoked).toBe(true);
    expect(() => store.enroll({ ...identity, jobId: "other" }, { hostId, bootId, supervisorId })).toThrow();
  });
  it.each(["missing", "corrupt", "foreign"])("%s immutable enrollment cannot authenticate a mutable epoch", fault => {
    if (fault === "missing") rmSync(local(readonlyEnrollmentPath));
    else writeFileSync(local(readonlyEnrollmentPath), fault === "corrupt" ? "{" : JSON.stringify({ ...initial(), generation: 1, hostId: "foreign" }));
    expect(() => new HostedReadonlyEpochStore().readEpoch()).toThrow();
    expect(JSON.parse(readFileSync(local(readonlyEpochPath), "utf8")).generation).toBe(3);
  });
  it("interrupted enrollment retains its birth record and never reconstructs unknown history", () => {
    rmSync(local(readonlyEpochPath)); rmSync(local(readonlyEnrollmentPath));
    const store = new HostedReadonlyEpochStore(), { identity, hostId, bootId, supervisorId } = initial();
    fixture.failEnrollment = true;
    expect(() => store.enroll(identity, { hostId, bootId, supervisorId })).toThrow("interrupted enrollment");
    expect(JSON.parse(readFileSync(local(readonlyEnrollmentPath), "utf8")).phase).toBe(HostedCustodyPhase.Closed);
    fixture.failEnrollment = false;
    expect(() => store.enroll(identity, { hostId, bootId, supervisorId })).toThrow("durable_authority_required");
    expect(() => store.serialized(() => {})).toThrow("durable_authority_required");
    expect(() => readFileSync(local(readonlyEpochPath))).toThrow();
  });
  it("only an otherwise identical CLOSED epoch can issue the next generation", () => {
    const store = new HostedReadonlyEpochStore();
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), generation: 4 }));
    expect(new HostedReadonlyEpochStore().readEpoch().generation).toBe(4);
    for (const mutation of [{ generation: 3 }, { generation: 6 }, { generation: 5, bootId: "different" },
      { generation: 5, phase: HostedCustodyPhase.Ready }, { generation: 5, revoked: true }]) {
      expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), ...mutation }))).toThrow("replacement_denied");
    }
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready }));
    expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), generation: 5 }))).toThrow("replacement_denied");
  });

  it("recovers a pending reservation without erasing the start or exposing READY to the recovery action", () => {
    const store = new HostedReadonlyEpochStore();
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready }));
    const record = { startId: "A", unit: "unit-A", creatorId: "creator-A", state: HostedCustodyReservationState.Reserved };
    fixture.failRename = true;
    expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), reservations: [record] }))).toThrow();
    fixture.failRename = false;
    expect(() => new HostedReadonlyEpochStore().serialized(() => {})).toThrow("publication_recovery_required");
    new HostedReadonlyEpochStore().recoverSerialized(() => {
      expect(store.readEpoch().phase).toBe(HostedCustodyPhase.Closed);
      expect(store.readEpoch().reservations).toEqual([record]);
    });
    expect(store.readEpoch().reservations).toEqual([record]);
  });
  it.each(["bootId", "supervisorId"] as const)("retained %s changes cannot bypass unresolved creator fencing", field => {
    const store = new HostedReadonlyEpochStore();
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready }));
    const record = { startId: "A", unit: "unit-A", creatorId: "creator-A", state: HostedCustodyReservationState.Reserved };
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), reservations: [record] }));
    const prior = readFileSync(local(readonlyEpochPath));
    const pending = JSON.stringify({ ...store.readEpoch(), [field]: "other-session" }) + "\n";
    writeFileSync(join(fixture.root, "readonly-epoch.next"), pending);
    const recovery = vi.fn();
    expect(() => store.recoverSerialized(recovery)).toThrow("replacement_denied");
    expect(recovery).not.toHaveBeenCalled();
    expect(readFileSync(local(readonlyEpochPath))).toEqual(prior);
    expect(readFileSync(join(fixture.root, "readonly-epoch.next"), "utf8")).toBe(pending);
  });
  it("replays an interrupted valid final session publication while keeping recovery CLOSED", () => {
    const store = new HostedReadonlyEpochStore();
    fixture.failRename = true;
    expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(),
      phase: HostedCustodyPhase.Ready, bootId: "boot-B", supervisorId: "supervisor-B" }))).toThrow("rename failure");
    fixture.failRename = false;
    store.recoverSerialized(() => {
      expect(store.readEpoch().bootId).toBe("boot-B");
      expect(store.readEpoch().supervisorId).toBe("supervisor-B");
      expect(store.readEpoch().phase).toBe(HostedCustodyPhase.Closed);
      expect(store.readEpoch().reservations).toEqual([]);
    });
  });
  it("only terminal CLOSED recovery can publish a new session, without combining other changes", () => {
    const store = new HostedReadonlyEpochStore();
    const ready = { ...store.readEpoch(), phase: HostedCustodyPhase.Ready,
      bootId: "boot-B", supervisorId: "supervisor-B" };
    expect(() => store.serialized(() => store.publishEpoch({ ...ready, generation: 4 }))).toThrow("replacement_denied");
    const reservation = { startId: "A", unit: "unit-A", creatorId: "creator-A", state: HostedCustodyReservationState.Reserved };
    expect(() => store.serialized(() => store.publishEpoch({ ...ready, reservations: [reservation] }))).toThrow("replacement_denied");
    store.serialized(() => store.publishEpoch(ready));
    expect(store.readEpoch().bootId).toBe("boot-B");
    expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), supervisorId: "supervisor-C" })))
      .toThrow("replacement_denied");
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), reservations: [reservation] }));
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Closed }));
    expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready })))
      .toThrow("replacement_denied");
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), reservations: [{ ...reservation, state: HostedCustodyReservationState.Terminal }] }));
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready, supervisorId: "supervisor-C" }));
    expect(store.readEpoch().supervisorId).toBe("supervisor-C");
  });

  it.each(["malformed", "foreign", "unrevoke", "skip-generation"])("retains %s pending state rather than overwriting it", kind => {
    const store = new HostedReadonlyEpochStore();
    if (kind === "unrevoke") store.serialized(() => store.publishEpoch({ ...store.readEpoch(), revoked: true }));
    const prior = readFileSync(local(readonlyEpochPath));
    const pending = kind === "malformed" ? "{" : JSON.stringify({ ...initial(),
      ...(kind === "foreign" ? { identity: { ...initial().identity, jobId: "other" } } : {}),
      ...(kind === "skip-generation" ? { generation: 5 } : {}),
    }) + "\n";
    writeFileSync(join(fixture.root, "readonly-epoch.next"), pending);
    let called = false;
    expect(() => store.recoverSerialized(() => { called = true; })).toThrow();
    expect(called).toBe(false);
    expect(readFileSync(local(readonlyEpochPath))).toEqual(prior);
    expect(readFileSync(join(fixture.root, "readonly-epoch.next"), "utf8")).toBe(pending);
  });

});

it("outer reservations persist before submission and cannot clear, replace or reopen while unresolved", () => {
  fixture.root = mkdtempSync(join(tmpdir(), "readonly-outer-store-"));
  fixture.failRename = false; fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; seed();
  try {
    const store = new HostedReadonlyEpochStore();
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready }));
    const outer = { startId: "outer-A", creatorId: "outer-A", unit: "outer-unit-A", generation: 3, state: HostedCustodyReservationState.Reserved };
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), outerRuntime: outer }));
    expect(new HostedReadonlyEpochStore().readEpoch().outerRuntime).toEqual(outer);
    for (const changed of [null, { ...outer, unit: "outer-unit-B" }, { ...outer, generation: 2 }]) {
      expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), outerRuntime: changed }))).toThrow("replacement_denied");
    }
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Closed }));
    expect(() => store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready }))).toThrow("replacement_denied");
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), outerRuntime: { ...outer, state: HostedCustodyReservationState.Terminal } }));
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), generation: 4 }));
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), phase: HostedCustodyPhase.Ready }));
    store.serialized(() => store.publishEpoch({ ...store.readEpoch(), outerRuntime: { ...outer, startId: "outer-B", creatorId: "outer-B", unit: "outer-unit-B", generation: 4 } }));
    expect(store.readEpoch().outerRuntime!.startId).toBe("outer-B");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
