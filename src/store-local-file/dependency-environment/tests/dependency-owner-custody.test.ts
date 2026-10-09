import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerKind as Kind, DependencyOwnerPhase as Phase,
  parseDependencyOwner, type DependencyOwnerRecord } from "../../../core/dependency-environment/dependency-owner";
import { type DependencyProtectedReference } from "../../../core/dependency-environment/dependency-custody-evidence";
import { claimDependencyConsumer, markDependencyConsumerRunning, fenceDependencyConsumer } from "../../../worker-core/dependency-environment/application/dependency-consumer-ownership";
import { LocalDependencyOwnerStore as Store, dependencyOwnerStorageName } from "../local-dependency-owner-store";
const id = "00000000-0000-4000-8000-000000000001";
const association: DependencyProtectedReference = { path: "/TEST-protected/association.json", identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) };
const launch = { installationId: id, bootId: id, runtimeSha: "b".repeat(40), grantDigest: "c".repeat(64), startId: id,
  unit: "subscription-runtime-ordinary-" + id + ".service" };
async function fixture(legacy = false, workspaceName = "workspace") {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dependency-custody-TEST-")));
  const rootPath = join(path, "protected"), workspacePath = join(path, workspaceName);
  await mkdir(rootPath, { mode: 0o700 }); await mkdir(workspacePath, { mode: 0o700 });
  const stat = await lstat(workspacePath, { bigint: true });
  const workspace = { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) };
  const store = Store.open({ rootPath, maxRecordBytes: 16384 });
  const file = join(rootPath, dependencyOwnerStorageName(workspace));
  let current: DependencyOwnerRecord;
  if (legacy) {
    const initial: DependencyOwnerRecord = { version: 1, workspace, revision: 1, epoch: 1, owner: null };
    store.compareAndSwap(workspace, null, initial);
    current = store.compareAndSwap(workspace, 1, { ...initial, epoch: 2, revision: 2 });
  } else {
    // Exercise real storage edges to obtain history; null->invented activity is
    // correctly denied by the existing store and is not a valid fixture setup.
    const attempt = claimDependencyConsumer(store, workspace, launch, randomUUID());
    markDependencyConsumerRunning(store, workspace, attempt, "100"); fenceDependencyConsumer(store, workspace, attempt);
    const fenced = store.read(workspace);
    if (!fenced || !fenced.activity?.lastEntry) throw new Error("TEST requires retained entry");
    const released = store.compareAndSwap(workspace, fenced.revision, { ...fenced, revision: fenced.revision + 1, owner: null,
      activity: { lastEntry: fenced.activity.lastEntry, lastRelease: { epoch: fenced.epoch, atMs: "200" } } });
    current = store.compareAndSwap(workspace, released.revision, { ...released, epoch: released.epoch + 1, revision: released.revision + 1 });
  }
  return { path, rootPath, workspace, store, file, current,
    cleanup: async () => { store.close(); await rm(path, { recursive: true, force: true }); } };
}
function modern(current: DependencyOwnerRecord): DependencyOwnerRecord & { readonly version: 3; readonly custodyBinding: DependencyProtectedReference } {
  return { ...current, version: 3, custodyBinding: association, revision: current.revision + 1 };
}
function reason(action: () => unknown): Failure {
  try { action(); } catch (error) { if (error instanceof DependencyAdmissionError) return error.reason; throw error; }
  throw new Error("TEST expected refusal");
}
async function snapshot(root: string) { return Promise.all((await readdir(root)).sort().map(async name => ({ name, bytes: await readFile(join(root, name)) }))); }
// Fresh TEST roots and real store/CAS/reopen only. These leaf references are
// syntax fixtures, NOT authenticated adoption/drain/Ready or launch permits.
// Red if active migration, drift/downgrade or legacy admission changes originals.
describe.skipIf(process.platform !== "linux")("idle-only protected owner custody migration", () => {
  it("preserves exact v2 bytes, revision+1, epoch/activity and survives reopen while legacy admission remains closed", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      const original = Buffer.from(JSON.stringify(f.current, null, 2) + "\n");
      await writeFile(f.file, original, { mode: 0o600 });
      const next = f.store.compareAndSwap(f.workspace, f.current.revision, modern(f.current));
      expect(next.version).toBe(3); expect(next.revision).toBe(f.current.revision + 1);
      expect(next.epoch).toBe(f.current.epoch); expect(next.activity).toEqual(f.current.activity); expect(next.owner).toBeNull();
      const digest = createHash("sha256").update(original).digest("hex");
      const preservedName = dependencyOwnerStorageName(f.workspace).replace(/\.json$/, ".v2-" + digest + ".json");
      expect(await readFile(join(f.rootPath, preservedName))).toEqual(original);
      expect((await lstat(join(f.rootPath, preservedName))).mode & 0o7777).toBe(0o600);
      f.store.close(); reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384 });
      expect(reopened.read(f.workspace)).toEqual(next);
      const before = await snapshot(f.rootPath);
      expect(reason(() => claimDependencyConsumer(reopened!, f.workspace, launch, randomUUID()))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(before);
    } finally { reopened?.close(); await f.cleanup(); }
  });
  it.each(["sk-AAAAAAAAAAAAAAAA", "Bearer token", "line\nbreak", "delete\x7f"])(
    "rejects unsafe idle-v2 workspace %j before mutex/publication without changing retained bytes or key", async workspaceName => {
      const f = await fixture(false, workspaceName);
      try {
        expect(f.current.version).toBe(2);
        const key = dependencyOwnerStorageName(f.workspace), original = await readFile(f.file);
        const before = await snapshot(f.rootPath), next = modern(f.current);
        expect(reason(() => f.store.compareAndSwap(f.workspace, f.current.revision, next))).toBe(Failure.InvalidRecord);
        expect(await snapshot(f.rootPath)).toEqual(before);
        expect(await readFile(f.file)).toEqual(original);
        expect(dependencyOwnerStorageName(f.workspace)).toBe(key);
        expect(f.store.read(f.workspace)).toEqual(f.current);
        // Existing mutex would yield Busy if the v3 parser reached acquisition.
        await writeFile(f.file.replace(/\.json$/, ".lock"), '{"version":1,"TEST":"retained-lock"}\n', { mode: 0o600 });
        const held = await snapshot(f.rootPath);
        expect(reason(() => f.store.compareAndSwap(f.workspace, f.current.revision, next))).toBe(Failure.InvalidRecord);
        expect(await snapshot(f.rootPath)).toEqual(held);
      } finally { await f.cleanup(); }
    },
  );
  it("rejects stale/nonincrementing revision, activity/epoch drift and nonidle proposed migration without effects", async () => {
    const f = await fixture();
    try {
      const good = modern(f.current), before = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, 1, good))).toBe(Failure.StaleAttempt);
      const bad: DependencyOwnerRecord[] = [ { ...good, revision: f.current.revision }, { ...good, revision: good.revision + 1 },
        { ...good, epoch: f.current.epoch + 1 }, { ...good, activity: { lastEntry: null, lastRelease: null } },
        parseDependencyOwner({ ...good, owner: { kind: Kind.Maintenance, phase: Phase.ExclusiveMutation,
          attempt: { operationId: id, epoch: f.current.epoch, host: { installationId: id, bootId: id, runtimeSha: launch.runtimeSha, grantDigest: launch.grantDigest,
            inventoryDigest: "d".repeat(64), supervisorId: "1:2" } } } }) ];
      for (const next of bad.slice(0, 4)) {
        expect(reason(() => f.store.compareAndSwap(f.workspace, f.current.revision, next))).toBe(Failure.InvalidRecord);
        expect(await snapshot(f.rootPath)).toEqual(before);
      }
      expect(reason(() => f.store.compareAndSwap(f.workspace, f.current.revision, bad[4]!))).toBe(Failure.Busy);
      expect(await snapshot(f.rootPath)).toEqual(before);
    } finally { await f.cleanup(); }
  });
  it.each([Phase.ExclusiveMutation, Phase.Running, Phase.Fenced])("holds an actual stored %s consumer during upgrade", async phase => {
    const f = await fixture();
    try {
      const current = f.store.compareAndSwap(f.workspace, f.current.revision, { ...f.current, revision: f.current.revision + 1,
        epoch: f.current.epoch + 1, owner: { kind: Kind.Consumer, phase, attempt: { attemptId: id, epoch: f.current.epoch + 1, launch } } });
      const before = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, current.revision, { ...modern(current), owner: null }))).toBe(Failure.Busy);
      expect(await snapshot(f.rootPath)).toEqual(before);
    } finally { await f.cleanup(); }
  });
  it("requires preserved v2 predecessor, refusing absent and v1 direct enrollment", async () => {
    const f = await fixture(true); let empty: Store | undefined;
    try {
      const before = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, f.current.revision, modern(f.current)))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(before);
      const root = join(f.path, "empty-protected"); await mkdir(root, { mode: 0o700 });
      empty = Store.open({ rootPath: root, maxRecordBytes: 16384 });
      expect(reason(() => empty!.compareAndSwap(f.workspace, null, modern(f.current)))).toBe(Failure.InvalidRecord);
      expect(await readdir(root)).toEqual([]);
    } finally { empty?.close(); await f.cleanup(); }
  });
  it("denies v3 downgrade and custody replacement pending genuine B-D transfer verifier", async () => {
    const f = await fixture();
    try {
      const current = f.store.compareAndSwap(f.workspace, f.current.revision, modern(f.current));
      const before = await snapshot(f.rootPath);
      for (const version of [1, 2] as const) {
        const { custodyBinding: _binding, ...old } = modern(current);
        const next: DependencyOwnerRecord = version === 1 ? { version, workspace: f.workspace, revision: current.revision + 1,
          epoch: current.epoch, owner: null } : { ...old, version, revision: current.revision + 1 };
        expect(parseDependencyOwner(next)).toEqual(next);
        expect(reason(() => f.store.compareAndSwap(f.workspace, current.revision, next))).toBe(Failure.InvalidRecord);
      }
      if (current.version !== 3) throw new Error("TEST expected v3");
      expect(reason(() => f.store.compareAndSwap(f.workspace, current.revision, { ...current, revision: current.revision + 1,
        custodyBinding: { ...current.custodyBinding, sha256: "f".repeat(64) } }))).toBe(Failure.InvalidRecord);
      expect(await snapshot(f.rootPath)).toEqual(before);
    } finally { await f.cleanup(); }
  });
  it("retains interrupted mutex/partial evidence instead of authorizing another upgrade", async () => {
    const f = await fixture();
    try {
      await writeFile(f.file.replace(/\.json$/, ".lock"), '{"version":1,"TEST":"uncertain"}\n', { mode: 0o600 });
      await writeFile(join(f.rootPath, "TEST-pending"), '{"version":3,', { mode: 0o600 });
      const held = await snapshot(f.rootPath);
      expect(reason(() => f.store.compareAndSwap(f.workspace, f.current.revision, modern(f.current)))).toBe(Failure.Busy);
      expect(reason(() => f.store.read(f.workspace))).toBe(Failure.Busy);
      expect(await snapshot(f.rootPath)).toEqual(held);
    } finally { await f.cleanup(); }
  });
});
