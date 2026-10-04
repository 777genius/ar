import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDependencyConsumer, claimDependencyConsumer, DependencyAdmissionFailure as AdmissionFailure, DependencyOwnerPhase,
  markDependencyConsumerRunning, type DependencyLaunchBinding, type DependencyOwnerRecord,
} from "@vioxen/subscription-runtime/worker-core";
import {
  dependencyOwnerStorageName, DependencyOwnerStorageFailure as StorageFailure,
  LocalDependencyOwnerStore as Store,
} from "../local-dependency-owner-store";

const runFile = promisify(execFile);
const launch: DependencyLaunchBinding = {
  installationId: "00000000-0000-4000-8000-000000000001", bootId: "00000000-0000-4000-8000-000000000002",
  startId: "00000000-0000-4000-8000-000000000003", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64),
  unit: "subscription-runtime-ordinary-00000000-0000-4000-8000-000000000003.service",
};

// All records, processes and paths are new synthetic TEST filesystem data.
async function fixture(maxRecordBytes = 4096) {
  const testRoot = await realpath(await mkdtemp(join(tmpdir(), "dependency-owner-TEST-")));
  const rootPath = join(testRoot, "protected");
  const workspacePath = join(testRoot, "workspace");
  await mkdir(rootPath, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  const identity = await lstat(workspacePath, { bigint: true });
  const workspace = { canonicalPath: workspacePath, dev: String(identity.dev), ino: String(identity.ino) };
  const store = Store.open({ rootPath, maxRecordBytes });
  const file = join(rootPath, dependencyOwnerStorageName(workspace));
  const mutex = file.replace(/\.json$/, ".lock");
  return { testRoot, rootPath, workspace, store, file, mutex,
    async cleanup() { store.close(); await rm(testRoot, { recursive: true, force: true }); } };
}
function initial(workspace: DependencyOwnerRecord["workspace"]): DependencyOwnerRecord {
  return { version: 1, workspace, revision: 1, epoch: 1, owner: null };
}
function reason(operation: () => unknown): string {
  try { operation(); } catch (error) {
    if (typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string") return error.reason;
    throw error;
  }
  throw new Error("expected refusal");
}
async function childRead(rootPath: string, workspace: DependencyOwnerRecord["workspace"]) {
  const helper = fileURLToPath(new URL("./fixtures/dependency-owner-store-read-process.ts", import.meta.url));
  const modulePath = resolve("dist/store-local-file/dependency-environment/local-dependency-owner-store.js");
  return runFile(process.execPath, ["--experimental-strip-types", helper, modulePath,
    rootPath, JSON.stringify(workspace)], { timeout: 3000, maxBuffer: 4096 });
}

describe.skipIf(process.platform !== "linux")("durable dependency consumer owner store", () => {
  it("retains an exclusive owner across handle disposal and refuses a new attempt", async () => {
    const sample = await fixture();
    let reopened: Store | undefined;
    try {
      expect(sample.store.read(sample.workspace)).toBeNull();
      const attempt = claimDependencyConsumer(sample.store, sample.workspace, launch, randomUUID());
      const originalBytes = await readFile(sample.file);
      sample.store.close();
      expect(JSON.parse((await childRead(sample.rootPath, sample.workspace)).stdout))
        .toEqual({ status: "present", revision: 1, phase: DependencyOwnerPhase.ExclusiveMutation });
      reopened = Store.open({ rootPath: sample.rootPath, maxRecordBytes: 4096 });
      expect(reopened.read(sample.workspace)?.owner).toEqual({ phase: DependencyOwnerPhase.ExclusiveMutation, attempt });
      expect(reason(() => claimDependencyConsumer(reopened!, sample.workspace, launch, randomUUID()))).toBe(AdmissionFailure.Busy);
      markDependencyConsumerRunning(reopened, sample.workspace, attempt);
      expect(reopened.read(sample.workspace)?.owner?.phase).toBe(DependencyOwnerPhase.Running);
      expect(await readFile(sample.file)).not.toEqual(originalBytes);
      expect((await lstat(sample.file)).mode & 0o7777).toBe(0o600);
      expect(await readdir(sample.rootPath)).toEqual([dependencyOwnerStorageName(sample.workspace)]);
    } finally { reopened?.close(); await sample.cleanup(); }
  });

  it("uses one physical key for aliases and refuses canonical rebinding", async () => {
    const sample = await fixture();
    const second = Store.open({ rootPath: sample.rootPath, maxRecordBytes: 4096 });
    try {
      sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace));
      const alias = { ...sample.workspace, canonicalPath: join(sample.testRoot, "alias") };
      expect(dependencyOwnerStorageName(alias)).toBe(dependencyOwnerStorageName(sample.workspace));
      const before = await readFile(sample.file);
      expect(reason(() => second.read(alias))).toBe(AdmissionFailure.WorkspaceChanged);
      expect(reason(() => second.compareAndSwap(alias, null, initial(alias)))).toBe(AdmissionFailure.WorkspaceChanged);
      expect(await readFile(sample.file)).toEqual(before);
      expect(await readdir(sample.rootPath)).toEqual([dependencyOwnerStorageName(sample.workspace)]);
    } finally { second.close(); await sample.cleanup(); }
  });

  it("stale revisions and same-epoch owner replacement preserve the current owner", async () => {
    const sample = await fixture();
    try {
      claimDependencyConsumer(sample.store, sample.workspace, launch, randomUUID());
      const current = sample.store.read(sample.workspace)!;
      const before = await readFile(sample.file);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, null, current))).toBe(AdmissionFailure.StaleAttempt);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, current.revision,
        { ...current, revision: current.revision + 2 }))).toBe(AdmissionFailure.InvalidRecord);
      const attempt = { ...current.owner!.attempt, attemptId: randomUUID() };
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, current.revision,
        { ...current, revision: current.revision + 1, owner: { phase: DependencyOwnerPhase.Running, attempt } })))
        .toBe(AdmissionFailure.StaleAttempt);
      expect(await readFile(sample.file)).toEqual(before);
      expect(await readdir(sample.rootPath)).toEqual([dependencyOwnerStorageName(sample.workspace)]);
    } finally { await sample.cleanup(); }
  });

  it("holds interrupted publication lock and partial evidence without PID or age takeover", async () => {
    const sample = await fixture();
    try {
      const current = sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace));
      const pending = join(sample.rootPath, `${sample.workspace.dev}-${sample.workspace.ino}.pending-${randomUUID()}`);
      const original = await readFile(sample.file);
      const intent = Buffer.from('{"version":1,"operationId":"TEST-interrupted","expectedRevision":1}\n');
      const partial = Buffer.from('{"version":1,"workspace":');
      await writeFile(sample.mutex, intent, { mode: 0o600 });
      await writeFile(pending, partial, { mode: 0o600 });
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, 1, { ...current, revision: 2 }))).toBe(AdmissionFailure.Busy);
      expect(await readFile(sample.mutex)).toEqual(intent);
      expect(await readFile(pending)).toEqual(partial);
      expect(await readFile(sample.file)).toEqual(original);
    } finally { await sample.cleanup(); }
  });

  it("blocks reads and consumer assertions when a Running publication still has a persisted mutex", async () => {
    const sample = await fixture();
    try {
      const attempt = claimDependencyConsumer(sample.store, sample.workspace, launch, randomUUID());
      markDependencyConsumerRunning(sample.store, sample.workspace, attempt);
      const original = await readFile(sample.file);
      const intent = Buffer.from('{"version":1,"operationId":"TEST-after-rename-before-commit"}\n');
      const pending = join(sample.rootPath, `${sample.workspace.dev}-${sample.workspace.ino}.pending-${randomUUID()}`);
      const partial = Buffer.from('{"version":1,"owner":');
      await writeFile(sample.mutex, intent, { mode: 0o600 });
      await writeFile(pending, partial, { mode: 0o600 });
      expect(reason(() => sample.store.read(sample.workspace))).toBe(AdmissionFailure.Busy);
      expect(reason(() => assertDependencyConsumer(sample.store, sample.workspace, attempt, DependencyOwnerPhase.Running)))
        .toBe(AdmissionFailure.Busy);
      expect(await readFile(sample.file)).toEqual(original);
      expect(await readFile(sample.mutex)).toEqual(intent);
      expect(await readFile(pending)).toEqual(partial);
    } finally { await sample.cleanup(); }
  });

  it.each(["malformed", "unknown_field", "oversized"] as const)("preserves %s records on read and CAS refusal", async (kind) => {
    const sample = await fixture();
    try {
      const bytes = kind === "malformed" ? Buffer.from('{"version":1') : kind === "oversized" ? Buffer.alloc(4097, 65)
        : Buffer.from(JSON.stringify({ ...initial(sample.workspace), forgedAuthority: true }));
      await writeFile(sample.file, bytes, { mode: 0o600 });
      expect(reason(() => sample.store.read(sample.workspace))).toBe(AdmissionFailure.InvalidRecord);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace)))).toBe(AdmissionFailure.InvalidRecord);
      expect(await readFile(sample.file)).toEqual(bytes);
    } finally { await sample.cleanup(); }
  });

  it("rejects symlink and external hardlink records without changing either sentinel", async () => {
    const sample = await fixture();
    try {
      const external = join(sample.testRoot, "external-sentinel");
      const bytes = Buffer.from(JSON.stringify(initial(sample.workspace)));
      await writeFile(external, bytes, { mode: 0o600 });
      await symlink(external, sample.file);
      expect(reason(() => sample.store.read(sample.workspace))).toBe(StorageFailure.UnsafeStore);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace)))).toBe(StorageFailure.UnsafeStore);
      expect((await lstat(sample.file)).isSymbolicLink()).toBe(true);
      expect(await readFile(external)).toEqual(bytes);
      await rm(sample.file);
      await link(external, sample.file);
      expect(reason(() => sample.store.read(sample.workspace))).toBe(StorageFailure.UnsafeStore);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace)))).toBe(StorageFailure.UnsafeStore);
      expect(await readFile(sample.file)).toEqual(bytes);
      expect(await readFile(external)).toEqual(bytes);
      expect((await lstat(external)).nlink).toBe(2);
    } finally { await sample.cleanup(); }
  });

  it("rejects a FIFO promptly in a bounded child and preserves its identity", async () => {
    const sample = await fixture();
    try {
      await runFile("mkfifo", ["-m", "600", sample.file], { timeout: 1000 });
      const before = await lstat(sample.file, { bigint: true });
      const result = await childRead(sample.rootPath, sample.workspace);
      expect(JSON.parse(result.stdout)).toEqual({ status: "rejected", reason: StorageFailure.UnsafeStore });
      const after = await lstat(sample.file, { bigint: true });
      expect(after.isFIFO()).toBe(true);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    } finally { await sample.cleanup(); }
  });

  it("refuses a readable-by-others record without repairing its permissions or bytes", async () => {
    const sample = await fixture();
    try {
      sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace));
      const before = await readFile(sample.file);
      await chmod(sample.file, 0o644);
      expect(reason(() => sample.store.read(sample.workspace))).toBe(StorageFailure.UnsafeStore);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, 1,
        { ...initial(sample.workspace), revision: 2 }))).toBe(StorageFailure.UnsafeStore);
      expect(await readFile(sample.file)).toEqual(before);
      expect((await lstat(sample.file)).mode & 0o7777).toBe(0o644);
    } finally { await sample.cleanup(); }
  });

  it("vetoes insecure permissions, root replacement and closed handles", async () => {
    const sample = await fixture();
    try {
      await chmod(sample.rootPath, 0o755);
      expect(reason(() => sample.store.read(sample.workspace))).toBe(StorageFailure.UnsafeRoot);
      expect(reason(() => Store.open({ rootPath: sample.rootPath, maxRecordBytes: 4096 }))).toBe(StorageFailure.UnsafeRoot);
      await chmod(sample.rootPath, 0o700);
      await rename(sample.rootPath, join(sample.testRoot, "retained-root"));
      await mkdir(sample.rootPath, { mode: 0o700 });
      const sentinel = join(sample.rootPath, "sentinel");
      await writeFile(sentinel, "TEST-independent-replacement");
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace)))).toBe(StorageFailure.UnsafeRoot);
      expect(await readFile(sentinel, "utf8")).toBe("TEST-independent-replacement");
      expect(await readdir(join(sample.testRoot, "retained-root"))).toEqual([]);
      sample.store.close();
      expect(reason(() => sample.store.read(sample.workspace))).toBe(StorageFailure.Closed);
      expect(reason(() => sample.store.compareAndSwap(sample.workspace, null, initial(sample.workspace)))).toBe(StorageFailure.Closed);
    } finally { await sample.cleanup(); }
  });
});
