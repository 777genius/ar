import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DependencyInstallProofKind as Install, DependencyPreservationKind as Preserve, DependencyReceiptState as State,
  type DependencyReceipt, type DependencyWorkspaceIdentity,
} from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import {
  parseDependencyReceipt, DependencyReceiptParseStatus as ParseStatus,
} from "../../../worker-core/dependency-environment/domain/parse-dependency-receipt";
import {
  DependencyTreeObservationStatus as ObservationStatus, type DependencyCapturedTreeObservation,
} from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import {
  LocalDependencyReceiptStore as Store, DependencyReceiptStorageError, DependencyReceiptStorageFailure as Failure,
  dependencyReceiptStorageName,
} from "../../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { observeDependencyTree } from "../observe-dependency-tree";

type Installing = Extract<DependencyReceipt, { state: State.Installing }>;
type Ready = Extract<DependencyReceipt, { state: State.Ready }>;
type Complete = Extract<DependencyCapturedTreeObservation, { status: ObservationStatus.Complete }>;
const limits = { maxEntries: 16, maxTotalBytes: 4096, maxManifestBytes: 8192, maxDurationMs: 10000 };
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dependency-measurement-TEST-")));
  const workspacePath = join(path, "workspace"), rootPath = join(path, "protected");
  await mkdir(workspacePath, { mode: 0o700 }); await mkdir(rootPath, { mode: 0o700 });
  const stat = await lstat(workspacePath, { bigint: true });
  const workspace = { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) };
  const store = Store.open({ rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
  return { path, rootPath, workspace, store,
    observe: () => observeDependencyTree({ workspacePath, expectedWorkspace: workspace, treeName: "node_modules", limits }),
    cleanup: async () => { store.close(); await rm(path, { recursive: true, force: true }); } };
}
function installing(workspace: DependencyWorkspaceIdentity): Installing {
  return { version: 1, revision: 1, generation: "TEST-measurement-generation", workspace,
    coverageRevision: "TEST-measurement-coverage", state: State.Installing, operationId: "TEST-measurement-install",
    requestedKey: "a".repeat(64), preservation: { kind: Preserve.KnownFreshAbsence,
      generation: "TEST-measurement-generation", workspace, coverageRevision: "TEST-measurement-coverage",
      operationId: "TEST-measurement-install", absenceEvidenceId: "TEST-new-empty-root" } };
}
async function authoredTree(workspace: DependencyWorkspaceIdentity): Promise<void> {
  const tree = join(workspace.canonicalPath, "node_modules");
  await mkdir(tree); await mkdir(join(tree, "TEST-pkg"));
  await writeFile(join(tree, "TEST-pkg/index.js"), "export const TEST_VALUE = 7;\n");
  await symlink("TEST-pkg/index.js", join(tree, "TEST-link"));
}
function complete(observation: DependencyCapturedTreeObservation): Complete {
  expect(observation.status).toBe(ObservationStatus.Complete);
  if (observation.status !== ObservationStatus.Complete) throw new Error("TEST expected actual tree observation");
  return observation;
}
function ready(first: Installing, observation: Complete, measured: boolean): Ready {
  const binding = { generation: first.generation, workspace: first.workspace, coverageRevision: first.coverageRevision,
    installKey: first.requestedKey, tree: observation.tree, manifestDigest: observation.digest };
  return { version: 1, revision: 2, state: State.Ready, ...binding,
    provenance: { ...binding, kind: Install.CompletedInstall, operationId: first.operationId,
      verificationEvidenceId: observation.digest, installerDrainEvidenceId: "TEST-store-domain-drain" },
    ...(measured ? { treeMeasurement: observation.measurement } : {}) };
}
function rejection(action: () => unknown): Failure {
  try { action(); } catch (error) {
    if (error instanceof DependencyReceiptStorageError) return error.reason;
    throw error;
  }
  throw new Error("TEST expected protected store rejection");
}
async function snapshot(rootPath: string) {
  const names = (await readdir(rootPath)).sort();
  return await Promise.all(names.map(async name => ({ name, bytes: await readFile(join(rootPath, name)) })));
}

// Only newly created isolated TEST filesystem roots. Observation/storage are real;
// install-proof IDs are logical store fixtures, not host admission or native install proof.
// Red regressions: dropped measurement on readback, malformed metadata normalized
// into legacy Ready, or stale metadata publication changing protected head/history.
describe.skipIf(process.platform !== "linux")("protected Ready tree measurement", () => {
  it("keeps legacy Ready unmeasured through parsing and protected reopen", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      const first = installing(f.workspace); f.store.compareAndSwap(f.workspace, null, first);
      await authoredTree(f.workspace); const observed = complete(await f.observe()), legacy = ready(first, observed, false);
      const parsed = parseDependencyReceipt(legacy);
      expect(parsed.status).toBe(ParseStatus.Valid);
      if (parsed.status !== ParseStatus.Valid) throw new Error("TEST legacy Ready refused");
      expect(Object.hasOwn(parsed.receipt, "treeMeasurement")).toBe(false);
      f.store.compareAndSwap(f.workspace, first.revision, legacy); f.store.close();
      reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
      const retained = reopened.read(f.workspace);
      expect(retained).toEqual(legacy);
      expect(Object.hasOwn(retained!, "treeMeasurement")).toBe(false);
    } finally { reopened?.close(); await f.cleanup(); }
  });

  it("authenticates real observer measurement in Installing-to-Ready CAS and reopen without changing tree identity", async () => {
    const f = await fixture(); let reopened: Store | undefined;
    try {
      const first = installing(f.workspace); f.store.compareAndSwap(f.workspace, null, first);
      await authoredTree(f.workspace); const observed = complete(await f.observe()), measured = ready(first, observed, true);
      expect(Object.keys(JSON.parse(Buffer.from(observed.canonicalBytes).toString())).sort()).toEqual(["entries", "version"]);
      expect(f.store.compareAndSwap(f.workspace, first.revision, measured)).toEqual(measured);
      const head = JSON.parse((await readFile(join(f.rootPath, dependencyReceiptStorageName(f.workspace)))).toString()) as
        { commit: { name: string; sha256: string } };
      const commitBytes = await readFile(join(f.rootPath, head.commit.name));
      expect(hash(commitBytes)).toBe(head.commit.sha256);
      const commit = JSON.parse(commitBytes.toString()) as { receipt: { name: string; sha256: string } };
      const receiptBytes = await readFile(join(f.rootPath, commit.receipt.name));
      expect(hash(receiptBytes)).toBe(commit.receipt.sha256);
      expect(JSON.parse(receiptBytes.toString())).toEqual(measured);
      expect(receiptBytes).toEqual(Buffer.from(JSON.stringify(measured) + "\n"));
      f.store.close(); reopened = Store.open({ rootPath: f.rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
      expect(reopened.read(f.workspace)).toEqual(measured);
      const after = complete(await f.observe());
      expect(after.canonicalBytes).toEqual(observed.canonicalBytes);
      expect(after.digest).toBe(observed.digest);
      expect(hash(after.canonicalBytes)).toBe(measured.manifestDigest);
      expect(await readFile(join(f.workspace.canonicalPath, "node_modules/TEST-pkg/index.js"), "utf8"))
        .toBe("export const TEST_VALUE = 7;\n");
    } finally { reopened?.close(); await f.cleanup(); }
  });

  it("refuses present invalid metadata before publication, preserving all head/history bytes", async () => {
    const f = await fixture();
    try {
      const first = installing(f.workspace); f.store.compareAndSwap(f.workspace, null, first);
      await authoredTree(f.workspace); const observed = complete(await f.observe()), measured = ready(first, observed, true);
      const hidden = { ...observed.measurement };
      Object.defineProperty(hidden, "TEST-hidden", { value: true });
      const invalid: unknown[] = [null, undefined, [],
        { ...observed.measurement, allocatedBytesEstimate: String(BigInt(observed.measurement.allocatedBytesEstimate) + 512n) },
        { ...observed.measurement, observedScanDurationMs: "01" },
        { ...observed.measurement, allocationBasis: "logical_file_size" },
        { ...observed.measurement, guaranteedReclaimedBytes: "0" },
        { ...observed.measurement, allocationByKind: { ...observed.measurement.allocationByKind, device: {} } },
        { ...observed.measurement, [Symbol("TEST-extra")]: true }, hidden];
      const before = await snapshot(f.rootPath);
      for (const metadata of invalid) {
        const malformed = { ...measured, treeMeasurement: metadata };
        expect(parseDependencyReceipt(malformed).status).toBe(ParseStatus.Invalid);
        // Deliberately cross the typed API with malformed unknown caller data.
        expect(rejection(() => f.store.compareAndSwap(f.workspace, first.revision, malformed as DependencyReceipt)))
          .toBe(Failure.InvalidReceipt);
        expect(await snapshot(f.rootPath)).toEqual(before);
        expect(f.store.read(f.workspace)).toEqual(first);
      }
      expect(parseDependencyReceipt({ ...first, treeMeasurement: observed.measurement }).status).toBe(ParseStatus.Invalid);
      const inherited = Object.assign(Object.create({ treeMeasurement: observed.measurement }), ready(first, observed, false)) as DependencyReceipt;
      expect(parseDependencyReceipt(inherited).status).toBe(ParseStatus.Invalid);
      expect(rejection(() => f.store.compareAndSwap(f.workspace, first.revision, inherited))).toBe(Failure.InvalidReceipt);
      expect(await snapshot(f.rootPath)).toEqual(before);
      expect(f.store.compareAndSwap(f.workspace, first.revision, measured)).toEqual(measured);
    } finally { await f.cleanup(); }
  });

  it("cannot attach measurement through stale revision, another generation or Ready-to-Ready refresh", async () => {
    const f = await fixture();
    try {
      const first = installing(f.workspace); f.store.compareAndSwap(f.workspace, null, first);
      await authoredTree(f.workspace); const observed = complete(await f.observe()), measured = ready(first, observed, true);
      const otherGeneration: Ready = { ...measured, generation: "TEST-other-generation",
        provenance: { ...measured.provenance, generation: "TEST-other-generation" } };
      expect(parseDependencyReceipt(otherGeneration).status).toBe(ParseStatus.Valid);
      const before = await snapshot(f.rootPath);
      expect(rejection(() => f.store.compareAndSwap(f.workspace, null, measured))).toBe(Failure.StaleRevision);
      expect(rejection(() => f.store.compareAndSwap(f.workspace, first.revision, otherGeneration))).toBe(Failure.InvalidTransition);
      expect(await snapshot(f.rootPath)).toEqual(before);
      f.store.compareAndSwap(f.workspace, first.revision, measured);
      const committed = await snapshot(f.rootPath), refresh: Ready = { ...measured, revision: 3,
        treeMeasurement: { ...observed.measurement, observedScanDurationMs: "0" } };
      expect(rejection(() => f.store.compareAndSwap(f.workspace, first.revision, refresh))).toBe(Failure.StaleRevision);
      expect(rejection(() => f.store.compareAndSwap(f.workspace, measured.revision, refresh))).toBe(Failure.InvalidTransition);
      expect(await snapshot(f.rootPath)).toEqual(committed);
      expect(f.store.read(f.workspace)).toEqual(measured);
    } finally { await f.cleanup(); }
  });
});
