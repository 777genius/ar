import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DependencyInstallProofKind as Install, DependencyPreservationKind as Preserve, DependencyReceiptState as State,
  type DependencyReceipt, type DependencyWorkspaceIdentity,
} from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { dependencyReceiptStorageName, DependencyReceiptStorageFailure as Failure, LocalDependencyReceiptStore as Store } from "../local-dependency-receipt-store";

const run = promisify(execFile);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function fixture(options: { maxRecordBytes?: number; maxHistorySteps?: number } = {}) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dependency-receipt-TEST-")));
  const rootPath = join(path, "protected"), workspacePath = join(path, "workspace");
  await mkdir(rootPath, { mode: 0o700 }); await mkdir(workspacePath);
  await writeFile(join(workspacePath, "sentinel"), "source original bytes");
  const stat = await lstat(workspacePath, { bigint: true });
  const workspace = { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) };
  const store = Store.open({ rootPath, maxRecordBytes: 16384, maxHistorySteps: 16, ...options });
  const file = join(rootPath, dependencyReceiptStorageName(workspace)), mutex = file.replace(/\.json$/, ".lock");
  return { path, rootPath, workspace, store, file, mutex,
    cleanup: async () => { store.close(); await rm(path, { recursive: true, force: true }); } };
}
function initial(workspace: DependencyWorkspaceIdentity): DependencyReceipt {
  return { version: 1, revision: 1, generation: "TEST-generation", workspace, coverageRevision: "TEST-coverage",
    state: State.Installing, operationId: "TEST-install", requestedKey: "a".repeat(64), preservation: {
      kind: Preserve.KnownFreshAbsence, generation: "TEST-generation", workspace, coverageRevision: "TEST-coverage",
      operationId: "TEST-install", absenceEvidenceId: "TEST-never-materialized" } };
}
function lifecycle(workspace: DependencyWorkspaceIdentity): DependencyReceipt[] {
  const first = initial(workspace), tree = { dev: workspace.dev, ino: "987654321" };
  const binding = { generation: first.generation, workspace, coverageRevision: first.coverageRevision,
    installKey: "a".repeat(64), tree, manifestDigest: "b".repeat(64) };
  const ready: DependencyReceipt = { version: 1, revision: 2, generation: first.generation, workspace,
    coverageRevision: first.coverageRevision, state: State.Ready, installKey: binding.installKey, tree, manifestDigest: binding.manifestDigest,
    provenance: { ...binding, kind: Install.CompletedInstall, operationId: "TEST-install",
      verificationEvidenceId: "TEST-verified", installerDrainEvidenceId: "TEST-drained" } };
  const trash = { operationId: "TEST-evict", originalTree: tree,
    destinationParent: { canonicalPath: join(workspace.canonicalPath, "../protected-trash"), dev: workspace.dev, ino: "987654322" },
    destinationName: "TEST-owned-trash" };
  // Synthetic logical store transaction, not an installation, filesystem
  // rename, runtime or authority fixture.
  const eviction: DependencyReceipt = { version: 1, revision: 3, generation: first.generation, workspace,
    coverageRevision: first.coverageRevision, state: State.Evicting, operationId: trash.operationId,
    installKey: binding.installKey, tree, manifestDigest: binding.manifestDigest, trash };
  const absent: DependencyReceipt = { version: 1, revision: 4, generation: first.generation, workspace,
    coverageRevision: first.coverageRevision, state: State.Absent, operationId: trash.operationId, installKey: binding.installKey,
    evictionCommit: { ...binding, operationId: trash.operationId, trash, commitEvidenceId: "TEST-rename-committed" } };
  return [first, ready, eviction, absent];
}
function rejected(action: () => unknown): string {
  try { action(); } catch (error) {
    if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") return error.reason;
    throw error;
  }
  throw new Error("TEST expected rejection");
}
function publish(store: Store, workspace: DependencyWorkspaceIdentity): void {
  for (const record of lifecycle(workspace)) store.compareAndSwap(workspace, record.revision === 1 ? null : record.revision - 1, record);
}
async function child(rootPath: string, workspace: DependencyWorkspaceIdentity, mode = "read", next?: DependencyReceipt) {
  const helper = fileURLToPath(new URL("./fixtures/dependency-receipt-store-process.ts", import.meta.url));
  return run(process.execPath, ["--experimental-strip-types", helper,
    resolve("dist/store-local-file/dependency-environment/local-dependency-receipt-store.js"), rootPath,
    JSON.stringify(workspace), mode, ...(next ? [JSON.stringify(next)] : [])], { timeout: 5000, maxBuffer: 4096 });
}

// New TEST-only filesystem records. The red regression is stale/corrupt CAS,
// unlocked reads of uncertain publication, or unauthenticated historical bytes.
describe.skipIf(process.platform !== "linux")("protected dependency receipts", () => {
  it("durably publishes linked states and returns immutable canonical Absent bytes", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      expect(f.store.read(f.workspace)).toBeNull(); publish(f.store, f.workspace);
      const committed = f.store.getCommittedAbsent(f.workspace, 4);
      const before = await readFile(committed.reference.path);
      expect(hash(before)).toBe(committed.reference.sha256);
      expect(JSON.parse(before.toString())).toEqual(committed.receipt);
      expect((await lstat(committed.reference.path, { bigint: true })).ino.toString()).toBe(committed.reference.identity.ino);
      expect((await readdir(f.rootPath)).filter(name => name.endsWith(".receipt.json"))).toHaveLength(4);
      f.store.close(); reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
      expect(reopened.getCommittedAbsent(f.workspace, 4)).toEqual(committed);
      expect(JSON.parse((await child(f.rootPath, f.workspace)).stdout)).toMatchObject({ status: "present", revision: 4, state: State.Absent });
      expect(await readFile(join(f.workspace.canonicalPath, "sentinel"), "utf8")).toBe("source original bytes");
    } finally { reopened?.close(); await f.cleanup(); }
  });

  it("rejects stale CAS, canonical aliases and mismatched transitions without replacing history", async () => {
    const f = await fixture();
    try {
      const [first, ready] = lifecycle(f.workspace);
      if (!first || !ready || ready.state !== State.Ready) throw new Error("TEST fixture");
      f.store.compareAndSwap(f.workspace, null, first); const before = await readFile(f.file), names = await readdir(f.rootPath);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, null, ready))).toBe(Failure.StaleRevision);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, 1, { ...ready, installKey: "c".repeat(64),
        provenance: { ...ready.provenance, installKey: "c".repeat(64) } }))).toBe(Failure.InvalidTransition);
      const alias = { ...f.workspace, canonicalPath: join(f.path, "alias") };
      expect(rejected(() => f.store.read(alias))).toBe(Failure.WorkspaceChanged);
      expect(await readFile(f.file)).toEqual(before); expect(await readdir(f.rootPath)).toEqual(names);
    } finally { await f.cleanup(); }
  });

  it("allows one cross-process publisher and never treats committed absence as fresh", async () => {
    const f = await fixture();
    try {
      const first = initial(f.workspace);
      const outputs = await Promise.all([child(f.rootPath, f.workspace, "cas", first), child(f.rootPath, f.workspace, "cas", first)]);
      const rows = outputs.map(output => JSON.parse(output.stdout));
      expect(rows.filter(row => row.status === "published")).toHaveLength(1);
      expect(rows.filter(row => row.status === "rejected")).toHaveLength(1);
      expect([Failure.Busy, Failure.StaleRevision]).toContain(rows.find(row => row.status === "rejected")?.reason);
      for (const next of lifecycle(f.workspace).slice(1)) f.store.compareAndSwap(f.workspace, next.revision - 1, next);
      const old = f.store.getCommittedAbsent(f.workspace, 4), bytes = await readFile(old.reference.path);
      const restore = initial(f.workspace);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, 4, { ...restore, revision: 5, generation: "TEST-restored" }))).toBe(Failure.InvalidReceipt);
      if (restore.state !== State.Installing) throw new Error("TEST fixture");
      expect(rejected(() => f.store.compareAndSwap(f.workspace, 4, { ...restore, revision: 5 }))).toBe(Failure.InvalidTransition);
      expect(await readFile(old.reference.path)).toEqual(bytes);
    } finally { await f.cleanup(); }
  });

  it("vetoes reads/history and CAS under a retained interrupted intent without reaping", async () => {
    const f = await fixture();
    try {
      publish(f.store, f.workspace); const original = await readFile(f.file);
      const intent = Buffer.from('{"version":1,"expectedRevision":4,"TEST":"uncertain"}\n');
      await writeFile(f.mutex, intent, { mode: 0o600 });
      await writeFile(join(f.rootPath, "TEST-partial-evidence"), "partial", { mode: 0o600 });
      expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.Busy);
      expect(rejected(() => f.store.getCommittedAbsent(f.workspace, 4))).toBe(Failure.Busy);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, null, initial(f.workspace)))).toBe(Failure.Busy);
      expect(await readFile(f.mutex)).toEqual(intent); expect(await readFile(f.file)).toEqual(original);
    } finally { await f.cleanup(); }
  });

  it("never persists a known credential signature masquerading as an evidence ID", async () => {
    const f = await fixture();
    try {
      const first = initial(f.workspace);
      if (first.state !== State.Installing || first.preservation.kind !== Preserve.KnownFreshAbsence) throw new Error("TEST fixture");
      const preservation = first.preservation;
      expect(rejected(() => f.store.compareAndSwap(f.workspace, null, { ...first,
        preservation: { ...preservation, absenceEvidenceId: `sk-${"A".repeat(24)}` } }))).toBe(Failure.InvalidReceipt);
      expect(await readdir(f.rootPath)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it.each(["corrupt", "identity", "missing"])("rejects %s historical Absent without changing protected evidence", async (kind) => {
    const f = await fixture();
    try {
      publish(f.store, f.workspace); const reference = f.store.getCommittedAbsent(f.workspace, 4).reference;
      const bytes = await readFile(reference.path);
      if (kind === "corrupt") await writeFile(reference.path, bytes.toString().replace("TEST-rename-committed", "TEST-rename-corrupted"));
      if (kind === "identity") { await rename(reference.path, reference.path + ".original"); await writeFile(reference.path, bytes, { mode: 0o600 }); }
      if (kind === "missing") await rename(reference.path, reference.path + ".original");
      expect(rejected(() => f.store.getCommittedAbsent(f.workspace, 4))).toBe(Failure.Corrupt);
      expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.Corrupt);
      expect(await readFile(join(f.workspace.canonicalPath, "sentinel"), "utf8")).toBe("source original bytes");
    } finally { await f.cleanup(); }
  });

  it("holds a genuine mid-publication conflict and never publishes an orphan as committed", async () => {
    const f = await fixture();
    try {
      const first = initial(f.workspace), bytes = Buffer.from(JSON.stringify(first) + "\n");
      const collision = join(f.rootPath, `${f.workspace.dev}-${f.workspace.ino}.r1-${hash(bytes)}.receipt.json`);
      await writeFile(collision, "independent existing bytes", { mode: 0o600 });
      expect(() => f.store.compareAndSwap(f.workspace, null, first)).toThrow();
      expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.Busy);
      expect(await readFile(collision, "utf8")).toBe("independent existing bytes");
      expect((await readdir(f.rootPath)).some(name => name.endsWith(".lock"))).toBe(true);
      expect(await readFile(join(f.workspace.canonicalPath, "sentinel"), "utf8")).toBe("source original bytes");
    } finally { await f.cleanup(); }
  });

  it("does not reset immutable history when the current head disappears", async () => {
    const f = await fixture();
    try {
      publish(f.store, f.workspace); const names = await readdir(f.rootPath);
      await rename(f.file, f.file + ".retained");
      expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.Corrupt);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, null, initial(f.workspace)))).toBe(Failure.Corrupt);
      expect((await readdir(f.rootPath)).filter(name => name.endsWith(".receipt.json")))
        .toEqual(names.filter(name => name.endsWith(".receipt.json")));
      expect(await readFile(join(f.workspace.canonicalPath, "sentinel"), "utf8")).toBe("source original bytes");
    } finally { await f.cleanup(); }
  });

  it("authenticates predecessor bytes instead of trusting historical filenames", async () => {
    const f = await fixture();
    try {
      publish(f.store, f.workspace);
      const predecessor = (await readdir(f.rootPath)).find(name => name.includes(".r1-") && name.endsWith(".receipt.json"));
      if (!predecessor) throw new Error("TEST missing predecessor");
      const file = join(f.rootPath, predecessor), bytes = await readFile(file);
      await writeFile(file, bytes.toString().replace("TEST-never-materialized", "TEST-fabricated-evidence"));
      expect(rejected(() => f.store.getCommittedAbsent(f.workspace, 1))).toBe(Failure.Corrupt);
      expect(f.store.read(f.workspace)?.state).toBe(State.Absent);
      expect(await readFile(file)).not.toEqual(bytes);
    } finally { await f.cleanup(); }
  });

  it.each(["malformed", "unknown-field", "fifo"])("refuses %s head without a null fallback or overwrite", async (kind) => {
    const f = await fixture();
    try {
      if (kind === "fifo") await run("mkfifo", ["-m", "600", f.file], { timeout: 1000 });
      else await writeFile(f.file, kind === "malformed" ? '{"version":1' : '{"version":1,"workerAuthority":true}\n', { mode: 0o600 });
      const before = kind === "fifo" ? null : await readFile(f.file);
      if (kind === "fifo") {
        // A blocking-open regression stays in a killable child; the parent's
        // execFile timeout bounds each operation independently of Vitest timers.
        expect(JSON.parse((await child(f.rootPath, f.workspace)).stdout)).toMatchObject({ status: "rejected", reason: Failure.UnsafeStore });
        expect((await lstat(f.file)).isFIFO()).toBe(true);
        expect(JSON.parse((await child(f.rootPath, f.workspace, "cas", initial(f.workspace))).stdout))
          .toMatchObject({ status: "rejected", reason: Failure.UnsafeStore });
      } else {
        expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.Corrupt);
        expect(rejected(() => f.store.compareAndSwap(f.workspace, null, initial(f.workspace)))).toBe(Failure.Corrupt);
      }
      if (before) expect(await readFile(f.file)).toEqual(before);
      else expect((await lstat(f.file)).isFIFO()).toBe(true);
    } finally { await f.cleanup(); }
  }, 15000);

  it("rejects symlink/hardlink head and root substitution without touching external sentinels", async () => {
    const f = await fixture();
    try {
      const sentinel = join(f.path, "outside"); await writeFile(sentinel, "outside bytes", { mode: 0o600 });
      await symlink(sentinel, f.file); expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.UnsafeStore);
      await rm(f.file); await link(sentinel, f.file); expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.UnsafeStore);
      await rm(f.file); await rename(f.rootPath, f.rootPath + "-retained"); await mkdir(f.rootPath, { mode: 0o700 });
      expect(rejected(() => f.store.compareAndSwap(f.workspace, null, initial(f.workspace)))).toBe(Failure.UnsafeRoot);
      expect(await readdir(f.rootPath)).toEqual([]); expect(await readFile(sentinel, "utf8")).toBe("outside bytes");
    } finally { await f.cleanup(); }
  });

  it("enforces explicit byte and history-walk bounds without reset/pruning", async () => {
    const f = await fixture(); let limited: Store | undefined;
    try {
      publish(f.store, f.workspace);
      limited = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 1 });
      expect(rejected(() => limited?.getCommittedAbsent(f.workspace, 1))).toBe(Failure.Bounds);
      limited.close(); limited = Store.open({ rootPath: f.rootPath, maxRecordBytes: 32, maxHistorySteps: 16 });
      expect(rejected(() => limited?.read(f.workspace))).toBe(Failure.Bounds);
      expect((await readdir(f.rootPath)).filter(name => name.endsWith(".receipt.json"))).toHaveLength(4);
      await chmod(f.rootPath, 0o755); expect(rejected(() => f.store.read(f.workspace))).toBe(Failure.UnsafeRoot);
    } finally { limited?.close(); await f.cleanup(); }
  });
});
