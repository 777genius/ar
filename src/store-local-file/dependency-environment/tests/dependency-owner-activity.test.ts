import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerPhase as Phase,
  DependencyOwnerKind as Kind, parseDependencyOwner, type DependencyOwnerRecord as Record,
  type DependencyLaunchBinding } from "../../../core/dependency-environment/dependency-owner";
import { claimDependencyConsumer, markDependencyConsumerRunning, fenceDependencyConsumer } from
  "../../../worker-core/dependency-environment/application/dependency-consumer-ownership";
import { claimDependencyMaintenance, releaseDependencyMaintenance } from
  "../../../worker-core/dependency-environment/application/dependency-maintenance-ownership";
import { LocalDependencyOwnerStore as Store, dependencyOwnerStorageName } from "../local-dependency-owner-store";

const launch: DependencyLaunchBinding = {
  installationId: "00000000-0000-4000-8000-000000000001", bootId: "00000000-0000-4000-8000-000000000002",
  startId: "00000000-0000-4000-8000-000000000003", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64),
  unit: "subscription-runtime-ordinary-00000000-0000-4000-8000-000000000003.service",
};
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dependency-activity-TEST-")));
  const rootPath = join(path, "protected"), workspacePath = join(path, "workspace");
  await mkdir(rootPath, { mode: 0o700 }); await mkdir(workspacePath, { mode: 0o700 });
  const stat = await lstat(workspacePath, { bigint: true });
  const workspace = { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) };
  const store = Store.open({ rootPath, maxRecordBytes: 4096 });
  const file = join(rootPath, dependencyOwnerStorageName(workspace));
  return { path, rootPath, workspace, store, file,
    cleanup: async () => { store.close(); await rm(path, { recursive: true, force: true }); } };
}
function reason(action: () => unknown): Failure {
  try { action(); } catch (error) { if (error instanceof DependencyAdmissionError) return error.reason; throw error; }
  throw new Error("TEST expected refusal");
}
async function snapshot(rootPath: string) {
  return Promise.all((await readdir(rootPath)).sort().map(async name => ({ name, bytes: await readFile(join(rootPath, name)) })));
}
function releaseRecord(current: Record, atMs: string | null): Record {
  const entry = current.activity?.lastEntry;
  if (!entry || entry.epoch !== current.epoch) throw new Error("TEST requires known matching Running entry");
  return { ...current, revision: current.revision + 1, owner: null,
    activity: { lastEntry: entry, lastRelease: { epoch: current.epoch, atMs } } };
}

// NEW isolated TEST filesystem only; real store/CAS/reopen, no host processes.
// A release record is a storage-contract fixture, not forged native drain proof.
// Red regressions: claims drop history, arbitrary metadata refresh bypasses actual
// edges, or stale/uncertain CAS changes the protected entry/release facts.
describe.skipIf(process.platform !== "linux")("protected dependency owner activity", () => {
  it("reads legacy absent activity as unknown, including reopen without invented timestamps", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      const legacy: Record = { version: 1, workspace: f.workspace, revision: 1, epoch: 1, owner: null };
      expect(Object.hasOwn(parseDependencyOwner(legacy), "activity")).toBe(false);
      f.store.compareAndSwap(f.workspace, null, legacy); f.store.close();
      reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 4096 });
      expect(reopened.read(f.workspace)).toEqual(legacy);
      expect(Object.hasOwn(reopened.read(f.workspace)!, "activity")).toBe(false);
    } finally { reopened?.close(); await f.cleanup(); }
  });

  it("records entry only on Running and matching release in the same owner-null CAS", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      const attempt = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      expect(Object.hasOwn(f.store.read(f.workspace)!, "activity")).toBe(false);
      markDependencyConsumerRunning(f.store, f.workspace, attempt, "1720000000123");
      expect(f.store.read(f.workspace)?.activity).toEqual({ lastEntry: { epoch: 1, atMs: "1720000000123" }, lastRelease: null });
      fenceDependencyConsumer(f.store, f.workspace, attempt);
      const fenced = f.store.read(f.workspace)!;
      const committed = f.store.compareAndSwap(f.workspace, fenced.revision, releaseRecord(fenced, "1720000000456"));
      expect(committed.owner).toBeNull();
      expect(committed.activity).toEqual({ lastEntry: { epoch: 1, atMs: "1720000000123" },
        lastRelease: { epoch: 1, atMs: "1720000000456" } });
      expect(JSON.parse((await readFile(f.file)).toString())).toEqual(committed);
      f.store.close(); reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 4096 });
      expect(reopened.read(f.workspace)).toEqual(committed);
    } finally { reopened?.close(); await f.cleanup(); }
  });

  it("carries real activity through maintenance, new claim and pre-Running release", async () => {
    const f = await fixture();
    try {
      const first = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      markDependencyConsumerRunning(f.store, f.workspace, first, "100"); fenceDependencyConsumer(f.store, f.workspace, first);
      const fenced = f.store.read(f.workspace)!;
      const idle = f.store.compareAndSwap(f.workspace, fenced.revision, releaseRecord(fenced, "200"));
      const maintenance = claimDependencyMaintenance(f.store, f.workspace, { installationId: launch.installationId,
        bootId: launch.bootId, runtimeSha: launch.runtimeSha, grantDigest: launch.grantDigest,
        inventoryDigest: "c".repeat(64), supervisorId: "123:456" }, randomUUID());
      expect(f.store.read(f.workspace)?.activity).toEqual(idle.activity);
      releaseDependencyMaintenance(f.store, f.workspace, maintenance);
      expect(f.store.read(f.workspace)?.activity).toEqual(idle.activity);
      const second = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      expect(second.epoch).toBe(3); expect(f.store.read(f.workspace)?.activity).toEqual(idle.activity);
      fenceDependencyConsumer(f.store, f.workspace, second);
      const aborted = f.store.read(f.workspace)!;
      f.store.compareAndSwap(f.workspace, aborted.revision, { ...aborted, revision: aborted.revision + 1, owner: null });
      expect(f.store.read(f.workspace)?.activity).toEqual(idle.activity);
      const third = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      const exclusive = f.store.read(f.workspace)!, beforeEntry = await snapshot(f.rootPath);
      const regressed: Record = { ...exclusive, revision: exclusive.revision + 1,
        owner: { kind: Kind.Consumer, phase: Phase.Running, attempt: third }, activity: idle.activity! };
      expect(parseDependencyOwner(regressed)).toEqual(regressed);
      expect(reason(() => f.store.compareAndSwap(f.workspace, exclusive.revision, regressed))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(beforeEntry);
      markDependencyConsumerRunning(f.store, f.workspace, third, "300");
      expect(f.store.read(f.workspace)?.activity).toEqual({ lastEntry: { epoch: 4, atMs: "300" }, lastRelease: { epoch: 1, atMs: "200" } });
    } finally { await f.cleanup(); }
  });

  it("keeps unknown clock facts nullable and permits observed wall-clock rollback without TTL meaning", async () => {
    const f = await fixture();
    try {
      const attempt = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      markDependencyConsumerRunning(f.store, f.workspace, attempt);
      expect(f.store.read(f.workspace)?.activity?.lastEntry).toEqual({ epoch: 1, atMs: null });
      fenceDependencyConsumer(f.store, f.workspace, attempt); let current = f.store.read(f.workspace)!;
      f.store.compareAndSwap(f.workspace, current.revision, releaseRecord(current, null));
      const next = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      markDependencyConsumerRunning(f.store, f.workspace, next, "900"); fenceDependencyConsumer(f.store, f.workspace, next);
      current = f.store.read(f.workspace)!;
      f.store.compareAndSwap(f.workspace, current.revision, releaseRecord(current, "800"));
      expect(f.store.read(f.workspace)?.activity?.lastRelease).toEqual({ epoch: 2, atMs: "800" });
    } finally { await f.cleanup(); }
  });

  it("rejects malformed presence and epoch/clock shape before any protected publication", async () => {
    const f = await fixture();
    try {
      const attempt = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID()), current = f.store.read(f.workspace)!;
      const entry = { epoch: 1, atMs: "100" }, activity = { lastEntry: entry, lastRelease: null };
      const hidden = { ...activity }; Object.defineProperty(hidden, "TEST-hidden", { value: true });
      const invalid: unknown[] = [undefined, null, [], { lastEntry: entry }, { ...activity, extra: true }, hidden,
        { ...activity, [Symbol("TEST-extra")]: true }, { lastEntry: { ...entry, epoch: 0 }, lastRelease: null },
        { lastEntry: { ...entry, epoch: 2 }, lastRelease: null }, { lastEntry: { ...entry, atMs: "01" }, lastRelease: null },
        { lastEntry: { ...entry, epoch: 1.5 }, lastRelease: null }, { lastEntry: { ...entry, atMs: 100 }, lastRelease: null },
        { lastEntry: { ...entry, extra: true }, lastRelease: null },
        { lastEntry: { ...entry, atMs: "-1" }, lastRelease: null }, { lastEntry: { ...entry, atMs: "9".repeat(129) }, lastRelease: null },
        { lastEntry: null, lastRelease: entry }];
      const before = await snapshot(f.rootPath);
      for (const value of invalid) {
        const malformed = { ...current, revision: current.revision + 1, owner: { kind: Kind.Consumer, phase: Phase.Running, attempt }, activity: value };
        expect(reason(() => parseDependencyOwner(malformed))).toBe(Failure.InvalidRecord);
        expect(reason(() => f.store.compareAndSwap(f.workspace, current.revision, malformed as Record))).toBe(Failure.InvalidRecord);
        expect(await snapshot(f.rootPath)).toEqual(before);
      }
      const inherited = Object.assign(Object.create({ activity }), current) as Record;
      expect(reason(() => parseDependencyOwner(inherited))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(before);
    } finally { await f.cleanup(); }
  });

  it("rejects drop, refresh, wrong-edge release and duplicate Running without modifying head bytes", async () => {
    const f = await fixture();
    try {
      const attempt = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      markDependencyConsumerRunning(f.store, f.workspace, attempt, "100");
      const current = f.store.read(f.workspace)!, before = await snapshot(f.rootPath);
      const { activity: _activity, ...without } = current;
      const invalid: Record[] = [{ ...without, revision: current.revision + 1 },
        { ...current, revision: current.revision + 1, owner: null },
        { ...current, revision: current.revision + 1, activity: { lastEntry: { epoch: 1, atMs: "200" }, lastRelease: null } },
        releaseRecord(current, "200")];
      for (const next of invalid) {
        expect(reason(() => f.store.compareAndSwap(f.workspace, current.revision, next))).toBe(Failure.InvalidRecord);
        expect(await snapshot(f.rootPath)).toEqual(before);
      }
      expect(reason(() => markDependencyConsumerRunning(f.store, f.workspace, attempt, "200"))).toBe(Failure.StaleAttempt);
      expect(await snapshot(f.rootPath)).toEqual(before);
      fenceDependencyConsumer(f.store, f.workspace, attempt); const fenced = f.store.read(f.workspace)!;
      const idle = f.store.compareAndSwap(f.workspace, fenced.revision, releaseRecord(fenced, "200"));
      const idleBytes = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, idle.revision, { ...idle, revision: idle.revision + 1,
        activity: { ...idle.activity!, lastRelease: { epoch: 1, atMs: "300" } } }))).toBe(Failure.InvalidRecord);
      const legacy: Record = { ...without, version: 1, revision: idle.revision + 1, owner: null };
      expect(reason(() => f.store.compareAndSwap(f.workspace, idle.revision, legacy))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(idleBytes);
    } finally { await f.cleanup(); }
  });

  it("refuses stale, rewritten-entry and interrupted release while preserving all evidence", async () => {
    const f = await fixture();
    try {
      const attempt = claimDependencyConsumer(f.store, f.workspace, launch, randomUUID());
      markDependencyConsumerRunning(f.store, f.workspace, attempt, "100"); fenceDependencyConsumer(f.store, f.workspace, attempt);
      const fenced = f.store.read(f.workspace)!, released = releaseRecord(fenced, "200"), before = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, fenced.revision - 1, released))).toBe(Failure.StaleAttempt);
      const changed: Record = { ...released, activity: { lastEntry: { epoch: 1, atMs: "99" }, lastRelease: { epoch: 1, atMs: "200" } } };
      expect(reason(() => f.store.compareAndSwap(f.workspace, fenced.revision, changed))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(before);
      const mutex = f.file.replace(/\.json$/, ".lock"), pending = join(f.rootPath, "TEST-retained-partial");
      await writeFile(mutex, '{"version":1,"operationId":"TEST-uncertain-release"}\n', { mode: 0o600 });
      await writeFile(pending, '{"activity":', { mode: 0o600 }); const held = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, fenced.revision, released))).toBe(Failure.Busy);
      expect(reason(() => f.store.read(f.workspace))).toBe(Failure.Busy);
      expect(await snapshot(f.rootPath)).toEqual(held);
    } finally { await f.cleanup(); }
  });
});
