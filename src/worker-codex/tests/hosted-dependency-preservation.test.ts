import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, expect, it, vi } from "vitest";
import { DependencyPreservationKind, DependencyReceiptState, DependencyUnverifiedReason } from "@vioxen/subscription-runtime/worker-core";
import type { HostedDependencyBinding } from "../hosted-dependency-workspace";
const f = vi.hoisted(() => ({ files: new Map<string, Buffer>(), old: undefined as unknown, committed: undefined as unknown,
  parent: { dev: "7", ino: "10" }, tree: { dev: "7", ino: "11" }, sourceExists: false }));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
vi.mock("../hosted-dependency-receipts", () => ({ dependencyCoverageRevision: () => "c".repeat(64),
  readHostedDependencyCommittedUnverified: () => f.committed }));
vi.mock("../hosted-readonly-inputs", () => ({ readHostedPrivateBytes: (path: string) => f.files.get(path) ?? null }));
vi.mock("../hosted-dependency-legacy-reference-records", () => ({ pinReferenceFile: (path: string) => {
  const bytes = f.files.get(path); if (!bytes) throw new Error("TEST missing protected record");
  return { bytes, reference: { path, identity: { dev: "7", ino: "25" }, sha256: hash(bytes) } };
} }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, lstatSync(path: string) {
    if (path.endsWith("/node_modules")) { if (f.sourceExists) return {}; throw Object.assign(new Error("TEST absent"), { code: "ENOENT" }); }
    const id = path.endsWith("/dependency-quarantine") ? f.parent : f.tree;
    return { ...id, uid: 0n, mode: 0o700n, isDirectory: () => true };
  } };
});
import { hostedDependencyPreservationPath, hostedDependencyQuarantineRoot, readHostedDependencyCommittedPreservation,
  readHostedDependencyPreparedPreservation, hostedDependencyPreservationCommit, type HostedDependencyPreparedPreservation } from "../hosted-dependency-preservation";
const binding = { version: 2, jobId: "TEST-explicit-preservation", jobRootDir: "/TEST/job",
  workspace: { canonicalPath: "/TEST/job/workspace", dev: "7", ino: "9" }, installationId: "00000000-0000-4000-8000-000000000001",
  runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64) } as HostedDependencyBinding;
const previous = { version: 1 as const, revision: 1, generation: "TEST-old", workspace: binding.workspace,
  coverageRevision: "c".repeat(64), state: DependencyReceiptState.Unverified as const, tree: { dev: "7", ino: "11" }, reason: DependencyUnverifiedReason.BaselineMissing };
let header: HostedDependencyPreparedPreservation, prefix: string;
function prepare() {
  const operationId = randomUUID(), oldReference = { path: "/protected/old.json", identity: { dev: "7", ino: "24" }, sha256: hash(encode(previous)) },
    inventoryPath = `${hostedDependencyQuarantineRoot}/${operationId}.inventory.json.gz`, inventory = encode({ version: 1, entries: ["TEST complete opaque inventory"] }), compressed = gzipSync(inventory);
  f.files.set(inventoryPath, compressed);
  header = { version: 1, binding, attempt: { operationId, epoch: 2, host: { installationId: binding.installationId,
    bootId: randomUUID(), supervisorId: "123:456", runtimeSha: binding.runtimeSha, inventoryDigest: "d".repeat(64), grantDigest: binding.grantDigest } },
    previous: { receipt: previous, reference: oldReference }, trash: { operationId, originalTree: previous.tree,
      destinationParent: { canonicalPath: hostedDependencyQuarantineRoot, dev: "7", ino: "10" }, destinationName: `dependency-${operationId}` },
    inventory: { reference: { path: inventoryPath, identity: { dev: "7", ino: "25" }, sha256: hash(compressed) }, digest: hash(inventory), logicalBytes: "256", entries: 1 } };
  f.committed = header.previous; prefix = hostedDependencyPreservationPath(binding, 1); f.files.set(prefix + ".prepared.json", encode(header));
}
function commit() { f.files.set(prefix + ".committed.json", encode(hostedDependencyPreservationCommit(readHostedDependencyPreparedPreservation(binding, previous)))); }
beforeEach(() => { f.files.clear(); f.parent = { dev: "7", ino: "10" }; f.tree = { dev: "7", ino: "11" }; f.sourceExists = false; prepare(); });
// Structural/history composition only: projected immutable-record and root-UID
// facts are not an original operator, real Linux preservation or native grant.
it("requires prepared AND durable committed mapping before producing the next install proof", () => {
  expect(() => readHostedDependencyCommittedPreservation(binding, previous, "TEST-new")).toThrow();
  commit();
  expect(readHostedDependencyCommittedPreservation(binding, previous, "TEST-new")).toMatchObject({ kind: DependencyPreservationKind.CommittedPreservation,
    generation: "TEST-new", operationId: "TEST-new", originalTree: previous.tree, preservedTree: previous.tree, mappingDigest: hash(encode(header)) });
});
it.each(["old-reference", "mapping", "inventory", "commit", "tree", "parent", "source"])("refuses forged or raced %s without issuing an install proof", change => {
  commit();
  if (change === "old-reference") f.committed = { ...header.previous, reference: { ...header.previous.reference, sha256: "f".repeat(64) } };
  if (change === "mapping") { header = { ...header, trash: { ...header.trash, destinationName: "different-name" } }; f.files.set(prefix + ".prepared.json", encode(header)); }
  if (change === "inventory") f.files.set(header.inventory.reference.path, gzipSync(encode({ changed: true })));
  if (change === "commit") f.files.set(prefix + ".committed.json", encode({ version: 1, committed: true }));
  if (change === "tree") f.tree.ino = "12";
  if (change === "parent") f.parent.ino = "12";
  if (change === "source") f.sourceExists = true;
  expect(() => readHostedDependencyCommittedPreservation(binding, previous, "TEST-new")).toThrow();
});
it("accepts only factual absence of both intent files, and holds an orphan commit", () => {
  f.files.delete(prefix + ".prepared.json"); expect(readHostedDependencyCommittedPreservation(binding, previous, "TEST-new")).toBeUndefined();
  f.files.set(prefix + ".committed.json", encode({ version: 1 }));
  expect(() => readHostedDependencyCommittedPreservation(binding, previous, "TEST-new")).toThrow();
});
