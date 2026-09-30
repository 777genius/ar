import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { KeyedLaunchLedgerStore } from "../hosted-controller/keyed-launch-ledger-store";
import { DispatchEligibility, KeyedChildLedger, KeyedChildProfile as Profile, KeyedChildState as State,
  NoEffectProofKind, type ReviewedChildAuthority } from "../../worker-core/project-control/domain/keyed-child-launch";

// Existing private-FS seam: real TEST files, no-follow opens, links, rename and
// fsync; only fixed path/host ownership and kernel namespace metadata are mapped.
// Production common fence issues and expires real validated capabilities.
const fixture = vi.hoisted(() => ({ root: "", fail: "", renamed: false, reads: 0,
  handles: new Map<number, string>(), synced: [] as string[] }));
const prefix = "/var/lib/subscription-runtime-host-policy";
function local(path: string): string {
  if (fixture.root && path.startsWith(fixture.root + "/")) return path;
  if (["/", "/var", "/var/lib", prefix].includes(path)) return fixture.root;
  if (path.startsWith(prefix + "/")) return join(fixture.root, path.slice(prefix.length + 1));
  throw new Error("unexpected TEST filesystem path");
}
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real,
    readFileSync: (path: string, options: Parameters<typeof real.readFileSync>[1]) =>
      path === "/proc/sys/kernel/random/boot_id" ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n" :
        path === "/proc/self/uid_map" ? "0 0 4294967295\n" : real.readFileSync(path, options),
    readlinkSync: (path: string) => path.startsWith("/proc/") ? "namespace:TEST" : real.readlinkSync(path),
    lstatSync: (path: string) => Object.assign(real.lstatSync(local(path)), { uid: 0 }),
    fstatSync: (fd: number) => Object.assign(real.fstatSync(fd), { uid: 0 }),
    mkdirSync: (path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), options),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
    openSync: (path: string, flags: number, mode: number) => {
      fixture.reads++;
      const fd = real.openSync(local(path), flags, mode); fixture.handles.set(fd, path); return fd;
    },
    closeSync: (fd: number) => { fixture.handles.delete(fd); real.closeSync(fd); },
    renameSync: (from: string, to: string) => {
      if (fixture.fail === "rename") throw new Error("TEST rename failure");
      real.renameSync(local(from), local(to)); fixture.renamed = true;
    },
    writeFileSync: (fd: number | string, bytes: Parameters<typeof real.writeFileSync>[1], options: Parameters<typeof real.writeFileSync>[2]) => {
      if (typeof fd === "number" && fixture.fail === "partial-write" && fixture.handles.get(fd)?.endsWith(".next")) {
        real.writeFileSync(fd, Buffer.from(bytes as Buffer).subarray(0, 8)); throw new Error("TEST partial write failure");
      }
      return real.writeFileSync(fd, bytes, options);
    },
    fsyncSync: (fd: number) => {
      const path = fixture.handles.get(fd)!; fixture.synced.push(path);
      if ((fixture.fail === "file" && path.endsWith(".next")) ||
          (fixture.fail === "dir-before" && path.endsWith("keyed-child-ledgers") &&
            fixture.synced.some(p => p.endsWith(".next"))) ||
          (fixture.fail === "dir-after" && fixture.renamed && path.endsWith("keyed-child-ledgers"))) {
        throw new Error("TEST fsync failure");
      }
      real.fsyncSync(fd);
    },
  };
});
const scope = { projectId: "TEST-project", workstreamId: "TEST-work", controllerId: "TEST-controller" };
const authority: ReviewedChildAuthority = { ...scope, grantDigest: "a".repeat(64), reviewedSnapshotDigest: "b".repeat(64),
  accountId: "TEST-reviewed-account", sourceSha: "c".repeat(40), artifactSha: "d".repeat(64),
  absoluteDeadline: 1000, maxGoalTurns: 3, effectiveOptionDigest: "e".repeat(64) };
const slots = [1, 2].map(n => ({ slotId: `slot-${n}`, requestId: `request-${n}`, operationId: `operation-${n}`,
  childHandle: `child-${n}`, startId: `start-${n}`, unitCorrelation: `unit-${n}`, profile: Profile.IsolatedWrite }));
const initial = () => KeyedChildLedger.create(authority, slots);
const fresh = () => new KeyedLaunchLedgerStore(authority, slots);
const request = () => ({ key: "TEST-key", task: "bounded TEST task 😀", profile: Profile.IsolatedWrite });
const name = createHash("sha256").update(JSON.stringify(["keyed-child-scope", 1,
  scope.projectId, scope.workstreamId, scope.controllerId])).digest("hex");
const ledgerDir = () => join(fixture.root, "keyed-child-ledgers");
const path = (suffix = ".json") => join(ledgerDir(), name + suffix);
const transact = (store: KeyedLaunchLedgerStore, generation: number, callback: (l: KeyedChildLedger) => KeyedChildLedger) =>
  store.transact(scope, initial().authorityDigest, generation, callback);
const enroll = (store = fresh()) => { withHostedActivationFence(f => store.initialize(f)); return store; };
const accept = (store: KeyedLaunchLedgerStore) => transact(store, 0, l => l.accept(0, request(), 10));
const view = (l: KeyedChildLedger) => l.observe(scope, "child-1");

beforeEach(async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  fixture.root = real.mkdtempSync(join(tmpdir(), "TEST-keyed-ledger-"));
  real.mkdirSync(ledgerDir(), { mode: 0o700 });
  fixture.fail = ""; fixture.renamed = false; fixture.reads = 0; fixture.synced = []; fixture.handles.clear();
  vi.spyOn(process, "getuid").mockReturnValue(0);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture.root, { recursive: true, force: true }); });

describe("bounded private durable keyed store", () => {
  it("requires an actual live common fence for explicit initialization", () => {
    const store = fresh();
    expect(() => store.initialize({ held: true })).toThrow("common_fence_required");
    let token!: Parameters<typeof store.initialize>[0];
    withHostedActivationFence(f => { token = f; store.initialize(f); });
    expect(() => store.initialize(token)).toThrow("common_fence_required");
    expect(readFileSync(path(), "utf8")).toBe(initial().serialize());
  });
  it("reconstructs terminal replay from request values, permanently retaining key and handles", async () => {
    const store = enroll(); await accept(store);
    const terminal = await transact(store, 1, l => l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
      correlation: view(l), evidenceDigest: "f".repeat(64) }));
    const before = readFileSync(path()); fixture.synced = [];
    const replay = await transact(fresh(), 2, l => l.accept(2, { ...request() }, 9999));
    expect(view(replay)).toEqual(view(terminal)); expect(replay.remainingAllowance).toBe(1);
    expect(readFileSync(path())).toEqual(before);
    expect(fixture.synced.some(p => p.endsWith(".json"))).toBe(true);
    expect(fixture.synced.at(-1)).toBe(prefix + "/keyed-child-ledgers");
    await expect(transact(fresh(), 2, l => l.accept(2, { ...request(), task: "changed" }, 10))).rejects.toThrow("conflict");
    expect(readFileSync(path())).toEqual(before);
    const second = await transact(fresh(), 2, l => l.accept(2, { ...request(), key: "second" }, 20));
    expect(second.observe(scope, "child-2").startId).toBe("start-2"); expect(second.remainingAllowance).toBe(0);
  });
  it("validated hydration cannot replace or forget accepted terminal history", async () => {
    const store = enroll(); await accept(store);
    await transact(store, 1, c => c.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
      correlation: view(c), evidenceDigest: "f".repeat(64) }));
    const before = readFileSync(path());
    let other = initial().accept(0, { ...request(), key: "rewritten" }, 10);
    other = other.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
      correlation: view(other), evidenceDigest: "f".repeat(64) });
    for (const candidate of [initial(), KeyedChildLedger.restore(other.serialize(), initial())]) {
      await expect(transact(store, 2, () => candidate)).rejects.toThrow("invalid ledger successor");
    }
    expect(readFileSync(path())).toEqual(before);
  });
  it("two stores using the same generation have exactly one durable winner", async () => {
    const store = enroll();
    const outcomes = await Promise.allSettled([accept(store), accept(fresh())]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(JSON.parse(readFileSync(path(), "utf8")).accepted).toHaveLength(1);
  });
  it("independent stores cannot enter while another callback holds the common host fence", async () => {
    const store = enroll(); let contender!: Promise<KeyedChildLedger>;
    const winner = await transact(store, 0, c => {
      contender = accept(fresh()); return c.accept(0, request(), 10);
    });
    await expect(contender).rejects.toThrow();
    expect(winner.generation).toBe(1);
    expect(JSON.parse(readFileSync(path(), "utf8")).accepted).toHaveLength(1);
  });
  it("restarted uncertain intent remains occupied and cannot acquire dispatch eligibility", async () => {
    const store = enroll(); let l = await accept(store);
    for (const state of [State.Materializing, State.Prepared, State.DispatchIntent]) {
      l = await transact(store, l.generation, c => c.advance(view(c), state, 20));
    }
    l = await transact(store, l.generation, c => c.markUncertain(view(c)));
    const replay = await transact(fresh(), l.generation, c => c.accept(c.generation, request(), 9999));
    expect(view(replay)).toMatchObject({ state: State.Uncertain, dispatchIntent: { generation: 4 },
      eligibility: DispatchEligibility.HeldAfterIntent }); expect(replay.occupied).toBe(true);
    await expect(transact(store, replay.generation, c => c.accept(c.generation, { ...request(), key: "replacement" }, 30)))
      .rejects.toThrow("occupied");
  });
  it.each(["file", "rename", "dir-before"])("%s failure retains exact intent publication and fences updates", async fail => {
    const store = enroll(); let l = await accept(store);
    for (const state of [State.Materializing, State.Prepared]) l = await transact(store, l.generation, c => c.advance(view(c), state, 20));
    const before = readFileSync(path()); fixture.fail = fail; fixture.renamed = false; fixture.synced = [];
    await expect(transact(store, 3, c => c.advance(view(c), State.DispatchIntent, 20))).rejects.toThrow();
    expect(readFileSync(path())).toEqual(before);
    const pending = readFileSync(path(".next"));
    expect(KeyedChildLedger.restore(pending.toString(), initial()).occupied).toBe(true);
    expect(JSON.parse(pending.toString()).accepted[0].dispatchIntent).toEqual({ generation: 4 });
    fixture.fail = "";
    await expect(transact(fresh(), 3, c => c)).rejects.toThrow("pending_publication");
    expect(() => withHostedActivationFence(f => store.initialize(f))).toThrow("pending_publication");
    expect(readFileSync(path(".next"))).toEqual(pending);
  });
  it("post-rename dirfsync failure retains intent and reconfirms durability on restart", async () => {
    const store = enroll(); let l = await accept(store);
    for (const state of [State.Materializing, State.Prepared]) l = await transact(store, l.generation, c => c.advance(view(c), state, 20));
    fixture.fail = "dir-after"; fixture.renamed = false;
    await expect(transact(store, 3, c => c.advance(view(c), State.DispatchIntent, 20))).rejects.toThrow("fsync failure");
    expect(JSON.parse(readFileSync(path(), "utf8")).generation).toBe(4);
    fixture.fail = ""; fixture.synced = [];
    const replay = await transact(fresh(), 4, c => c.accept(4, request(), 10));
    expect(replay.occupied).toBe(true); expect(replay.remainingAllowance).toBe(1);
    expect(view(replay)).toMatchObject({ dispatchIntent: { generation: 4 }, eligibility: DispatchEligibility.HeldAfterIntent });
    expect(fixture.synced.at(-1)).toBe(prefix + "/keyed-child-ledgers");
    await expect(transact(store, 3, c => c)).rejects.toThrow("stale_generation");
  });
  it("an interrupted write retains partial bytes and cannot be replayed as an empty slot", async () => {
    const store = enroll(), before = readFileSync(path()); fixture.fail = "partial-write";
    await expect(accept(store)).rejects.toThrow("partial write failure");
    expect(readFileSync(path())).toEqual(before); expect(readFileSync(path(".next"))).toHaveLength(8);
    fixture.fail = "";
    await expect(accept(fresh())).rejects.toThrow("pending_publication");
    expect(readFileSync(path(".next"))).toHaveLength(8);
  });
  it("a replaced target inside a callback is never overwritten by publication", async () => {
    const store = enroll();
    const foreign = KeyedChildLedger.create({ ...authority, maxGoalTurns: 4 }, slots).serialize();
    await expect(transact(store, 0, c => {
      writeFileSync(path(), foreign); return c.accept(0, request(), 10);
    })).rejects.toThrow("file_changed");
    expect(readFileSync(path(), "utf8")).toBe(foreign);
    expect(JSON.parse(readFileSync(path(".next"), "utf8")).generation).toBe(1);
    await expect(transact(fresh(), 0, c => c)).rejects.toThrow("pending_publication");
  });
  it("invalid UTF-8 cannot be parsed or normalized into stored authority", async () => {
    const store = enroll(), bytes = Buffer.from([0xc3, 0x28]); writeFileSync(path(), bytes);
    await expect(transact(store, 0, c => c)).rejects.toThrow();
    expect(readFileSync(path())).toEqual(bytes);
  });
  it.each(["partial", "empty", "incompatible"])("%s pending file is retained without callback or clobber", async kind => {
    const store = enroll(), before = readFileSync(path());
    const pending = kind === "partial" ? "{" : kind === "empty" ? "" : initial().serialize();
    writeFileSync(path(".next"), pending, { mode: 0o600 }); const callback = vi.fn(c => c);
    await expect(transact(store, 0, callback)).rejects.toThrow("pending_publication");
    expect(callback).not.toHaveBeenCalled(); expect(readFileSync(path())).toEqual(before);
    expect(readFileSync(path(".next"), "utf8")).toBe(pending);
  });
  it.each(["missing", "corrupt"])("%s committed ledger never auto-initializes from birth", async kind => {
    const store = enroll(); await accept(store);
    if (kind === "missing") rmSync(path()); else writeFileSync(path(), "{");
    await expect(transact(store, 0, c => c)).rejects.toThrow();
    expect(() => withHostedActivationFence(f => store.initialize(f))).toThrow();
    if (kind === "corrupt") expect(readFileSync(path(), "utf8")).toBe("{");
    else expect(() => readFileSync(path())).toThrow();
  });
  it("rejects foreign scope and digest before any fence/target reads", async () => {
    const store = enroll(); fixture.reads = 0;
    await expect(store.transact({ ...scope, controllerId: "foreign" }, initial().authorityDigest, 0, c => c)).rejects.toThrow("foreign_authority");
    await expect(store.transact(scope, "f".repeat(64), 0, c => c)).rejects.toThrow("foreign_authority");
    expect(fixture.reads).toBe(0);
  });
  it("thenables, skipped generations, restored fabricated successors and changed allocations never publish", async () => {
    const store = enroll(), before = readFileSync(path());
    const thenable = (() => ({ then() {} })) as unknown as (c: KeyedChildLedger) => KeyedChildLedger;
    await expect(transact(store, 0, thenable)).rejects.toThrow("synchronous_callback_required");
    await expect(transact(store, 0, c => c.accept(0, request(), 10).stop(view(c.accept(0, request(), 10)))))
      .rejects.toThrow("invalid ledger successor");
    await expect(transact(store, 0, () => KeyedChildLedger.restore(initial().accept(0, request(), 10).serialize(), initial())))
      .rejects.toThrow("invalid ledger successor");
    await expect(transact(store, 0, () => KeyedChildLedger.create(authority, [{ ...slots[0]!, startId: "changed" }]).accept(0, request(), 10)))
      .rejects.toThrow("invalid ledger successor");
    expect(readFileSync(path())).toEqual(before); expect(() => readFileSync(path(".next"))).toThrow();
  });
  it.each(["symlink", "nonprivate", "executable", "hardlink"])("%s committed file is denied without overwrite", async kind => {
    const store = enroll(), before = readFileSync(path());
    if (kind === "symlink") { renameSync(path(), path(".other")); symlinkSync(path(".other"), path()); }
    else if (kind === "nonprivate") chmodSync(path(), 0o640);
    else if (kind === "executable") chmodSync(path(), 0o700);
    else linkSync(path(), path(".other"));
    await expect(accept(store)).rejects.toThrow(); expect(readFileSync(path())).toEqual(before);
  });
  it("parent symlink, nonprivate parent and parent replacement during callback are denied", async () => {
    const store = enroll(), before = readFileSync(path());
    await expect(transact(store, 0, c => {
      renameSync(ledgerDir(), ledgerDir() + "-old");
      mkdirSync(prefix + "/keyed-child-ledgers", { mode: 0o700 }); return c.accept(0, request(), 10);
    })).rejects.toThrow("parent_changed");
    expect(readFileSync(join(ledgerDir() + "-old", name + ".json"))).toEqual(before);
    rmSync(ledgerDir(), { recursive: true }); symlinkSync(ledgerDir() + "-old", ledgerDir());
    expect(() => fresh()).toThrow(); rmSync(ledgerDir());
    renameSync(ledgerDir() + "-old", ledgerDir()); chmodSync(ledgerDir(), 0o750);
    expect(() => fresh()).toThrow();
  });
});
