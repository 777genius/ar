import { readFileSync, lstatSync } from "node:fs";
import { DependencyUnverifiedReason } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import type { DependencyLegacyComparisonVerifier, DependencyLegacyComparedReady } from "../../../worker-core/dependency-environment/ports/dependency-legacy-comparison";
import { execFile, spawn } from "node:child_process";
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
import type { DependencyCommittedAbsentReceipt } from "../../../worker-core/dependency-environment/ports/dependency-receipt-store";

const run = promisify(execFile);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function fixture(options: { maxRecordBytes?: number; maxHistorySteps?: number; legacyComparisonVerifier?: DependencyLegacyComparisonVerifier } = {}) {
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
function restoration(committed: DependencyCommittedAbsentReceipt): Extract<DependencyReceipt, { state: State.Installing }> {
  const old = committed.receipt, generation = "TEST-restored", operationId = "TEST-restore-install";
  return { version: 1, revision: old.revision + 1, generation, workspace: old.workspace, coverageRevision: old.coverageRevision,
    state: State.Installing, operationId, requestedKey: "c".repeat(64), preservation: {
      kind: Preserve.CommittedAbsence, generation, workspace: old.workspace, coverageRevision: old.coverageRevision, operationId,
      prior: { generation: old.generation, revision: old.revision, operationId: old.operationId, installKey: old.installKey,
        tree: old.evictionCommit.tree, manifestDigest: old.evictionCommit.manifestDigest,
        commitEvidenceId: old.evictionCommit.commitEvidenceId, receipt: committed.reference } } };
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

  it("accepts unchanged root custody when a real publisher changes its entries between open observations", async () => {
    const f = await fixture();
    try {
      const helper = fileURLToPath(new URL("./fixtures/dependency-receipt-root-open-process.ts", import.meta.url));
      const result = await run(process.execPath, ["--experimental-strip-types", helper,
        resolve("dist/store-local-file/dependency-environment/local-dependency-receipt-store.js"), f.rootPath,
        JSON.stringify(f.workspace), JSON.stringify(initial(f.workspace))], { timeout: 5000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toEqual({ status: "root_open_valid", custodyUnchanged: true,
        directoryMetadataChanged: true, publishedRevision: 1 });
      expect(f.store.read(f.workspace)).toEqual(initial(f.workspace));
      expect(await readFile(join(f.workspace.canonicalPath, "sentinel"), "utf8")).toBe("source original bytes");
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

  it("preserves retained private roots across cross-process directory metadata changes", async () => {
    const f = await fixture();
    const helper = fileURLToPath(new URL("./fixtures/dependency-receipt-store-process.ts", import.meta.url));
    const writer = spawn(process.execPath, ["--experimental-strip-types", helper,
      resolve("dist/store-local-file/dependency-environment/local-dependency-receipt-store.js"), f.rootPath,
      JSON.stringify(f.workspace), "root-churn"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderrBytes = 0, invalid = false;
    let wake: (() => void) | undefined, expected = "READY\n";
    const waitFor = (frame: string): Promise<void> => {
      expected = frame;
      return new Promise(resolveFrame => { wake = resolveFrame; if (output === expected || invalid) wake(); });
    };
    const readyPromise = waitFor(expected);
    const ended = new Promise<boolean>(resolveEnded => {
      writer.once("error", () => { invalid = true; wake?.(); resolveEnded(false); });
      writer.once("close", (code, signal) => { wake?.(); resolveEnded(code === 0 && signal === null); });
    });
    const deadline = setTimeout(() => { invalid = true; writer.kill("SIGKILL"); }, 10_000);
    writer.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4096) { invalid = true; writer.kill("SIGKILL"); }
      if (output === expected) wake?.();
    });
    writer.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4096) { invalid = true; writer.kill("SIGKILL"); }
    });
    try {
      await readyPromise;
      expect(invalid).toBe(false); expect(output).toBe("READY\n");
      const before = await lstat(f.rootPath, { bigint: true });
      let overlap = false;
      for (let round = 0; round < 100; round++) {
        for (let i = 0; i < 10; i++) {
          const opened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
          try { expect(opened.read(f.workspace)).toBeNull(); } finally { opened.close(); }
        }
        const previous = lstatSync(f.rootPath, { bigint: true });
        const prefix = "READY\n" + "CHANGED\n".repeat(round);
        expect(output).toBe(prefix);
        const changed = waitFor(prefix + "CHANGED\n");
        writer.stdin.write("MUTATE\n");
        await changed;
        expect(invalid).toBe(false); expect(output).toBe(prefix + "CHANGED\n");
        // Retained custody tolerates genuine changes, while physical identity stays strict.
        expect(f.store.read(f.workspace)).toBeNull();
        const current = lstatSync(f.rootPath, { bigint: true });
        expect([current.dev, current.ino, current.uid, current.mode]).toEqual([before.dev, before.ino, before.uid, before.mode]);
        expect(current.mtimeNs).toBe(BigInt(946684800 + (round + 1) * 2) * 1_000_000_000n);
        const transition = current.mtimeNs !== previous.mtimeNs || current.ctimeNs !== previous.ctimeNs;
        expect(transition).toBe(true); overlap ||= transition;
      }
      writer.stdin.end("STOP\n");
      expect(await ended).toBe(true); expect(invalid).toBe(false); expect(stderrBytes).toBe(0);
      expect(output).toBe('READY\n' + 'CHANGED\n'.repeat(100) + '{"status":"churned","mutations":4000}');
      expect(overlap).toBe(true);
      const after = await lstat(f.rootPath, { bigint: true });
      expect([after.dev, after.ino, after.uid, after.mode]).toEqual([before.dev, before.ino, before.uid, before.mode]);
      expect(await readdir(f.rootPath)).toEqual([]);
    } finally {
      clearTimeout(deadline);
      if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
      await ended; await f.cleanup();
    }
  }, 15_000);

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

  it("restores through authenticated committed absence and preserves original receipt history", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      publish(f.store, f.workspace); const committed = f.store.getCommittedAbsent(f.workspace, 4);
      const retained = await Promise.all((await readdir(f.rootPath)).filter(name => name.endsWith(".receipt.json")).map(async name => {
        const path = join(f.rootPath, name); return { path, bytes: await readFile(path), stat: await lstat(path, { bigint: true }) };
      }));
      const restore = restoration(committed);
      expect(f.store.compareAndSwap(f.workspace, 4, restore)).toEqual(restore);
      expect(f.store.getCommittedAbsent(f.workspace, 4)).toEqual(committed);
      const originalReady = lifecycle(f.workspace)[1];
      if (!originalReady || originalReady.state !== State.Ready || originalReady.provenance.kind !== Install.CompletedInstall) throw new Error("TEST fixture");
      const ready: DependencyReceipt = { ...originalReady, revision: 6, generation: restore.generation, installKey: restore.requestedKey,
        provenance: { ...originalReady.provenance, generation: restore.generation, installKey: restore.requestedKey, operationId: restore.operationId } };
      expect(f.store.compareAndSwap(f.workspace, 5, ready)).toEqual(ready);
      f.store.close(); reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
      expect(reopened.read(f.workspace)).toEqual(ready);
      expect(reopened.getCommittedAbsent(f.workspace, 4)).toEqual(committed);
      for (const old of retained) {
        expect(await readFile(old.path)).toEqual(old.bytes);
        const stat = await lstat(old.path, { bigint: true }); expect([stat.dev, stat.ino]).toEqual([old.stat.dev, old.stat.ino]);
      }
      const absentBytes = await readFile(committed.reference.path);
      await rename(committed.reference.path, committed.reference.path + ".retained");
      await writeFile(committed.reference.path, absentBytes, { mode: 0o600 });
      expect(rejected(() => reopened?.getCommittedAbsent(f.workspace, 4))).toBe(Failure.Corrupt);
      expect(reopened.read(f.workspace)).toEqual(ready);
      expect(await readFile(committed.reference.path + ".retained")).toEqual(absentBytes);
      expect(await readFile(join(f.workspace.canonicalPath, "sentinel"), "utf8")).toBe("source original bytes");
    } finally { reopened?.close(); await f.cleanup(); }
  });

  it("rejects forged prior bindings and receipt references before publishing restoration", async () => {
    const f = await fixture();
    try {
      publish(f.store, f.workspace); const committed = f.store.getCommittedAbsent(f.workspace, 4), restore = restoration(committed);
      const preservation = restore.preservation;
      if (preservation.kind !== Preserve.CommittedAbsence) throw new Error("TEST fixture");
      const prior = preservation.prior, bytes = await readFile(f.file), names = await readdir(f.rootPath);
      const candidates = [
        { ...prior, generation: "TEST-other-generation" }, { ...prior, operationId: "TEST-other-eviction" },
        { ...prior, installKey: "d".repeat(64) }, { ...prior, tree: { ...prior.tree, ino: "123456789" } },
        { ...prior, manifestDigest: "e".repeat(64) }, { ...prior, commitEvidenceId: "TEST-other-commit" },
        { ...prior, receipt: { ...prior.receipt, path: prior.receipt.path + ".uncommitted" } },
        { ...prior, receipt: { ...prior.receipt, identity: { ...prior.receipt.identity, dev: "123456789" } } },
        { ...prior, receipt: { ...prior.receipt, identity: { ...prior.receipt.identity, ino: "123456789" } } },
        { ...prior, receipt: { ...prior.receipt, sha256: "f".repeat(64) } },
      ];
      for (const forged of candidates) {
        expect(rejected(() => f.store.compareAndSwap(f.workspace, 4, { ...restore, preservation: { ...preservation, prior: forged } })))
          .toBe(Failure.InvalidTransition);
        expect(await readFile(f.file)).toEqual(bytes); expect(await readdir(f.rootPath)).toEqual(names);
      }
      expect(f.store.getCommittedAbsent(f.workspace, 4)).toEqual(committed);
      await writeFile(f.mutex, "TEST-retained-intent", { mode: 0o600 });
      expect(rejected(() => f.store.compareAndSwap(f.workspace, 4, restore))).toBe(Failure.Busy);
      expect(await readFile(f.mutex, "utf8")).toBe("TEST-retained-intent");
      expect(await readFile(f.file)).toEqual(bytes);
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

// Storage-boundary regression: production hosted-chain authentication has its
// own native gate. This TEST verifier reads a protected immutable evidence leaf
// and its original actual receipt bytes/inode; it does not manufacture runtime
// provenance or assert that synthetic TEST trees were independently installed.
describe.skipIf(process.platform !== "linux")("legacy comparison predecessor CAS", () => {
  function unverified(workspace: DependencyWorkspaceIdentity): Extract<DependencyReceipt, { state: State.Unverified }> {
    return { version: 1, revision: 1, generation: "TEST-legacy", coverageRevision: "TEST-coverage", workspace,
      state: State.Unverified, tree: { dev: workspace.dev, ino: "987654321" }, reason: DependencyUnverifiedReason.BaselineMissing };
  }
  function ready(old: Extract<DependencyReceipt, { state: State.Unverified }>, revision = 2): DependencyLegacyComparedReady {
    const binding = { generation: old.generation, workspace: old.workspace, coverageRevision: old.coverageRevision,
      tree: old.tree, installKey: "a".repeat(64), manifestDigest: "b".repeat(64) };
    return { version: 1, revision, state: State.Ready, ...binding, provenance: { ...binding,
      kind: Install.LegacyCompared, referenceInstallationId: "TEST-reference-install", comparisonEvidenceId: "TEST-comparison" } };
  }
  it("denies missing verifier before creating receipt, commit or head bytes", async () => {
    const f = await fixture();
    try {
      const old = unverified(f.workspace); f.store.compareAndSwap(f.workspace, null, old);
      const before = await readdir(f.rootPath), head = await readFile(f.file);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, 1, ready(old)))).toBe(Failure.InvalidTransition);
      expect(await readdir(f.rootPath)).toEqual(before);
      expect(await readFile(f.file)).toEqual(head);
      expect(f.store.read(f.workspace)).toEqual(old);
    } finally { await f.cleanup(); }
  });
  it("denies an asynchronous verifier before publishing", async () => {
    const f = await fixture({ legacyComparisonVerifier: { async assertLegacyComparison() {} } });
    try {
      const old = unverified(f.workspace); f.store.compareAndSwap(f.workspace, null, old);
      const before = await readdir(f.rootPath), head = await readFile(f.file);
      expect(rejected(() => f.store.compareAndSwap(f.workspace, 1, ready(old)))).toBe(Failure.InvalidTransition);
      expect(await readdir(f.rootPath)).toEqual(before);
      expect(await readFile(f.file)).toEqual(head);
    } finally { await f.cleanup(); }
  });
  it("pins actual predecessor reference and rejects r1 replay after genuine r3 publication", async () => {
    const f = await fixture(); let secured: Store | undefined;
    try {
      const old = unverified(f.workspace); f.store.compareAndSwap(f.workspace, null, old);
      const committed = f.store.getCommittedUnverified(f.workspace, 1);
      const evidencePath = join(f.rootPath, "TEST-comparison-evidence.json");
      await writeFile(evidencePath, JSON.stringify(committed) + "\n", { mode: 0o600, flag: "wx" });
      const verifier: DependencyLegacyComparisonVerifier = { assertLegacyComparison(input) {
        const evidence: typeof committed = JSON.parse(readFileSync(evidencePath, "utf8"));
        const stat = lstatSync(evidence.reference.path, { bigint: true });
        if (stat.dev.toString() !== evidence.reference.identity.dev || stat.ino.toString() !== evidence.reference.identity.ino ||
          hash(readFileSync(evidence.reference.path)) !== evidence.reference.sha256 ||
          JSON.stringify(evidence.receipt) !== JSON.stringify(input.previousUnverified) ||
          JSON.stringify(evidence.reference) !== JSON.stringify(input.previousReference)) throw new Error("TEST predecessor mismatch");
      } };
      f.store.close(); secured = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 16, legacyComparisonVerifier: verifier });
      // Same authentic bytes copied to a different inode/path must not replace
      // storage's actual immutable predecessor reference.
      const substitutedPath = join(f.rootPath, "TEST-substituted-receipt.json");
      await writeFile(substitutedPath, await readFile(committed.reference.path), { mode: 0o600, flag: "wx" });
      const substituteStat = await lstat(substitutedPath, { bigint: true });
      await writeFile(evidencePath, JSON.stringify({ ...committed, reference: { ...committed.reference, path: substitutedPath,
        identity: { dev: String(substituteStat.dev), ino: String(substituteStat.ino) } } }) + "\n");
      const beforeSubstitution = await readFile(f.file);
      expect(rejected(() => secured!.compareAndSwap(f.workspace, 1, ready(old)))).toBe(Failure.InvalidTransition);
      expect(await readFile(f.file)).toEqual(beforeSubstitution);
      await writeFile(evidencePath, JSON.stringify(committed) + "\n");
      expect(secured.compareAndSwap(f.workspace, 1, ready(old)).revision).toBe(2);
      const committedReady = secured.getCommittedReady(f.workspace, 2);
      expect(hash(await readFile(committedReady.reference.path))).toBe(committedReady.reference.sha256);
      expect(committedReady.receipt).toEqual(ready(old));
      const stale = { ...old, revision: 3, reason: DependencyUnverifiedReason.InputsChanged };
      secured.compareAndSwap(f.workspace, 2, stale);
      const current = secured.getCommittedUnverified(f.workspace, 3), beforeReplay = await readdir(f.rootPath), head = await readFile(f.file);
      expect(current.reference).not.toEqual(committed.reference);
      expect(secured.getCommittedUnverified(f.workspace, 1)).toEqual(committed);
      expect(secured.getCommittedReady(f.workspace, 2)).toEqual(committedReady);
      expect(rejected(() => secured!.compareAndSwap(f.workspace, 3, ready(stale, 4)))).toBe(Failure.InvalidTransition);
      expect(await readdir(f.rootPath)).toEqual(beforeReplay);
      expect(await readFile(f.file)).toEqual(head);
      expect(secured.read(f.workspace)).toEqual(stale);
      expect(await readFile(committed.reference.path)).toEqual(Buffer.from(JSON.stringify(committed.receipt) + "\n"));
    } finally { secured?.close(); await f.cleanup(); }
  });
});
