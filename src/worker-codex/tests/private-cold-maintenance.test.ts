import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePrivateColdMaintenance, verifyPrivateColdMaintenance,
  type ColdFileIdentity } from "../cold-maintenance/private-cold-capture";
import type { ColdSourceObservation } from "../cold-maintenance/private-cold-source-observation";
import { encryptedDisposableTestColdRestore } from "../cold-maintenance/private-test-restic-restore";

const run = promisify(execFile);
vi.mock("../cold-maintenance/private-cold-source-observation", () => ({
  observeColdReadOnlySource: vi.fn(async (_path: string, expected: ColdSourceObservation) => expected),
}));
const expectedSource: ColdSourceObservation = { bootId: "synthetic", mountPoint: "/synthetic",
  mountRoot: "/", mountSource: "/dev/synthetic", device: "1:1", filesystem: "ext4" };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function identity(path: string): Promise<ColdFileIdentity> {
  const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
  return { bytes: bytes.length, sha256: sha(bytes), dev: info.dev, ino: info.ino };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "test-cold-maintenance-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const selectedJobRoot = join(sourceRoot, "test-job");
  await mkdir(selectedJobRoot, { recursive: true });
  const db = join(selectedJobRoot, "state.db");
  const script = `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute('CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT)')
c.execute("INSERT INTO records VALUES ('selected', 'committed-wal-only')")
c.commit(); os._exit(0)`;
  await run("python3", ["-c", script, db]);
  const wal = `${db}-wal`;
  const shm = `${db}-shm`;
  const registry = join(selectedJobRoot, "registry.json");
  await writeFile(registry, '{"job":"test-job"}\n');
  const source = { role: "state_5", kind: "sqlite" as const, path: db,
    identity: await identity(db), sidecars: { wal: await identity(wal), shm: await identity(shm) },
    probe: { table: "records", keyColumn: "id", key: "selected",
      valueColumn: "value", value: "committed-wal-only" } };
  const artifact = { role: "registry", kind: "artifact" as const,
    path: registry, identity: await identity(registry) };
  return { root, sourceRoot, selectedJobRoot, db, wal, shm, registry, source, artifact,
    destination: join(root, "cold-maintenance-1") };
}

describe("private cold maintenance", () => {
  it("preserves WAL-only commit through staging and refuses changed source or payload", async () => {
    const f = await fixture();
    const before = await Promise.all([f.db, f.wal, f.shm, f.registry].map((path) => readFile(path)));
    const captured = await capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job", sources: [f.source, f.artifact],
      destination: f.destination });
    expect((await verifyPrivateColdMaintenance(f.destination, captured.manifestSha256)).files)
      .toHaveLength(2);
    expect(await Promise.all([f.db, f.wal, f.shm, f.registry].map((path) => readFile(path)))).toEqual(before);
    await writeFile(join(f.destination, "payload", "registry.data"), "tampered");
    await expect(verifyPrivateColdMaintenance(f.destination, captured.manifestSha256))
      .rejects.toThrow("payload_tampered");
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job", sources: [f.source],
      destination: f.destination })).rejects.toThrow("output_exists");
  });

  it("keeps the raw inventory unchanged when SQLite creates a missing SHM on its working copy", async () => {
    const f = await fixture();
    await rm(f.shm);
    const source = { ...f.source, sidecars: { wal: f.source.sidecars.wal } };
    const captured = await capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot,
      selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [source], destination: f.destination });
    const manifest = await verifyPrivateColdMaintenance(f.destination, captured.manifestSha256);
    expect(manifest.rawFiles.map((file) => file.name)).toEqual(["state_5", "state_5-wal"]);
    expect((await readdir(join(f.destination, "raw"))).sort()).toEqual(["state_5", "state_5-wal"]);
    expect(await readdir(f.destination)).not.toContain("working");
    const receipt = JSON.parse(await readFile(join(f.destination, "maintenance-receipt.json"), "utf8"));
    expect(receipt).toMatchObject({ currentSelectedJobOnly: true, historicalTreesExcluded: true });
  });

  it("rejects oversized declarations before source reads and oversized payloads before allocation", async () => {
    const f = await fixture();
    const oversized = { ...f.artifact, identity: { ...f.artifact.identity, bytes: 128 * 1024 * 1024 } };
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot,
      selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [oversized, f.source], destination: f.destination })).rejects.toThrow("limit_exceeded");
    const captured = await capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot,
      selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [f.artifact], destination: f.destination });
    await truncate(join(f.destination, "payload", "registry.data"), 1024 * 1024 * 1024);
    await expect(verifyPrivateColdMaintenance(f.destination, captured.manifestSha256))
      .rejects.toThrow("limit_exceeded");
    await writeFile(join(f.destination, "payload", "registry.data"), await readFile(f.registry));
    await truncate(join(f.destination, "raw", "registry"), 1024 * 1024 * 1024);
    await expect(verifyPrivateColdMaintenance(f.destination, captured.manifestSha256))
      .rejects.toThrow("limit_exceeded");
  });

  it("excludes historical and project trees from the selected job", async () => {
    const f = await fixture();
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot,
      selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [{ ...f.artifact, path: join(f.sourceRoot, "other-job", "registry.json") }],
      destination: f.destination })).rejects.toThrow("path_invalid");
    for (const name of ["archive", "history_2025", "worktrees", "project-1"]) {
      const tree = join(f.selectedJobRoot, name);
      await mkdir(tree);
      const path = join(tree, "registry.json");
      await writeFile(path, "synthetic");
      await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot,
        selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
        sources: [{ ...f.artifact, path, identity: await identity(path) }],
        destination: f.destination })).rejects.toThrow("path_invalid");
    }
  });

  it("checks a partition parent and partition-backed stacked device without a partition slaves directory", async () => {
    const actual = await vi.importActual<typeof import("../cold-maintenance/private-cold-source-observation")>(
      "../cold-maintenance/private-cold-source-observation");
    const root = await mkdtemp(join(tmpdir(), "test-cold-sysfs-"));
    roots.push(root);
    const devices = join(root, "devices");
    const disk = join(devices, "nvme0n1");
    const partition = join(disk, "nvme0n1p1");
    const stacked = join(devices, "dm-0");
    const block = join(root, "dev", "block");
    await mkdir(partition, { recursive: true });
    await mkdir(join(stacked, "slaves", "nvme0n1p1"), { recursive: true });
    await mkdir(join(disk, "slaves"));
    await mkdir(block, { recursive: true });
    for (const [path, dev] of [[disk, "259:0"], [partition, "259:1"], [stacked, "253:0"]]) {
      await writeFile(join(path, "ro"), "1\n");
      await writeFile(join(path, "dev"), `${dev}\n`);
      await symlink(path, join(block, dev));
    }
    await writeFile(join(partition, "partition"), "1\n");
    await writeFile(join(stacked, "slaves", "nvme0n1p1", "dev"), "259:1\n");
    await actual.checkReadOnlyBlockDevice("253:0", block);
    await writeFile(join(disk, "ro"), "0\n");
    await expect(actual.checkReadOnlyBlockDevice("253:0", block)).rejects.toThrow();
  });

  it("rejects writable source observation and credential or alias entries", async () => {
    const f = await fixture();
    const actual = await vi.importActual<typeof import("../cold-maintenance/private-cold-source-observation")>(
      "../cold-maintenance/private-cold-source-observation");
    await expect(actual.observeColdReadOnlySource(f.sourceRoot, { bootId: "wrong",
      mountPoint: f.sourceRoot, mountRoot: "/", mountSource: "/dev/wrong",
      device: "1:1", filesystem: "ext4" })).rejects.toThrow();
    const bootId = "a".repeat(36);
    const expected = { ...expectedSource, bootId, mountPoint: f.sourceRoot };
    const mount = { point: f.sourceRoot, root: "/", source: "/dev/test",
      device: "1:1", filesystem: "ext4", options: ["ro"], superOptions: ["ro"] };
    expect(actual.matchesColdMountFacts(mount, bootId,
      { ...expected, mountSource: "/dev/test" })).toBe(true);
    expect(actual.matchesColdMountFacts({ ...mount, options: ["rw"] }, bootId,
      { ...expected, mountSource: "/dev/test" })).toBe(false);
    expect(actual.matchesColdMountFacts({ ...mount, superOptions: ["rw"] }, bootId,
      { ...expected, mountSource: "/dev/test" })).toBe(false);
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [f.artifact, { ...f.artifact, role: "result" }], destination: f.destination }))
      .rejects.toThrow("duplicate_alias");
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [{ ...f.artifact, path: join(f.sourceRoot, "credential.json") }],
      destination: f.destination })).rejects.toThrow("path_invalid");
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource,
      selectedJobId: "test-job", sources: [{ ...f.artifact,
        path: `${f.sourceRoot}/../source/registry.json` }], destination: f.destination }))
      .rejects.toThrow("path_invalid");
  });

  it("rejects symlink inputs and an incomplete receipt", async () => {
    const f = await fixture();
    const linked = join(f.sourceRoot, "linked.json");
    await symlink(f.registry, linked);
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job",
      sources: [{ ...f.artifact, path: linked }], destination: f.destination }))
      .rejects.toThrow("path_invalid");
    await mkdir(f.destination);
    await expect(verifyPrivateColdMaintenance(f.destination, "0".repeat(64)))
      .rejects.toThrow("unexpected_payload");
    const linkedDestination = join(f.root, "cold-maintenance-linked");
    await symlink(f.destination, linkedDestination);
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource,
      selectedJobId: "test-job", sources: [f.artifact], destination: linkedDestination }))
      .rejects.toThrow("output_exists");
  });

  it("rejects changed source identity and extra payload entries", async () => {
    const f = await fixture();
    await writeFile(f.registry, "changed");
    await expect(capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource,
      selectedJobId: "test-job", sources: [f.artifact], destination: f.destination }))
      .rejects.toThrow("source_identity_changed");
    const current = { ...f.artifact, identity: await identity(f.registry) };
    const captured = await capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource,
      selectedJobId: "test-job", sources: [f.source, current], destination: f.destination });
    await writeFile(join(f.destination, "payload", "unexpected.data"), "x");
    await expect(verifyPrivateColdMaintenance(f.destination, captured.manifestSha256))
      .rejects.toThrow("unexpected_payload");
    expect(await readdir(join(f.destination, "raw"))).toContain("state_5-wal");
  });

  it("verifies an encrypted disposable restore and rejects a wrong password", async () => {
    const f = await fixture();
    const captured = await capturePrivateColdMaintenance({ sourceRoot: f.sourceRoot, selectedJobRoot: f.selectedJobRoot, expectedSource, selectedJobId: "test-job", sources: [f.source],
      destination: f.destination });
    const password = randomBytes(32).toString("hex");
    const base = { testRoot: f.root, captureDirectory: f.destination,
      expectedManifestSha256: captured.manifestSha256, generatedTestPassword: password };
    await expect(encryptedDisposableTestColdRestore({ ...base, restorePassword: "wrong",
      repositoryDirectory: join(f.root, "repo-wrong"),
      destination: join(f.root, "test-cold-restored-wrong"),
      receiptPath: join(f.root, "wrong-receipt.json") })).rejects.toThrow();
    const restored = await encryptedDisposableTestColdRestore({ ...base,
      repositoryDirectory: join(f.root, "repo-good"),
      destination: join(f.root, "test-cold-restored-good"),
      receiptPath: join(f.root, "good-receipt.json") });
    expect(restored.routingDisabled).toBe(true);
  });
});
