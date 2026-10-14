import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { DependencyInstallProfile } from "../../../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyInstallProofKind, DependencyReceiptState, type DependencySourceBindingReference } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { assertDependencyLocalOutputEvidence, assertDependencySourceBindingRecord } from "../../../worker-core/dependency-environment/domain/dependency-source-binding-record";
import type { DependencyCompletedLocalReady, DependencyLocalOutputEvidence, DependencySourceBindingRecord, DependencySourceBindingRecordV2 } from "../../../worker-core/dependency-environment/ports/dependency-source-binding";
import { DependencyTreeObservationFailure, DependencyTreeObservationStatus } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { NpmInputCaptureStatus } from "../capture-npm-install-inputs";
import { captureNpmLocalClosure, NpmLocalPinKind } from "../capture-npm-local-closure";
import { assertDependencyLocalOutputBinding, capturedDependencySourceBindingOutputBody, closeDependencySourceLinkSession,
  dependencySourceLinkProof, LocalDependencySourceBindingStore, openCapturedDependencySourceLinks, readDependencyProtectedReference, readDependencySourceLinkSession } from "../dependency-source-binding";
import { observeDependencyTree } from "../observe-dependency-tree";

const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function identity(path: string) { const stat = await lstat(path, { bigint: true }); return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) }; }
async function retainedRecord(path: string, bytes: Buffer): Promise<DependencySourceBindingReference> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); const { dev, ino } = await identity(path);
  return { path, identity: { dev, ino }, sha256: hash(bytes) };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-local-output-reference-"))), workspace = join(root, "workspace"),
    policy = join(root, "policy"), sourceRoot = join(policy, "dependency-source-bindings");
  await mkdir(join(workspace, "packages/a"), { recursive: true }); await mkdir(policy, { mode: 0o700 }); await mkdir(sourceRoot, { mode: 0o700 });
  const pkg = { name: "test-output-root", version: "1.0.0", private: true, workspaces: ["packages/a"], dependencies: { a: "*" } };
  const localBytes = encode({ name: "a", version: "1.0.0", main: "index.js" });
  await writeFile(join(workspace, "package.json"), encode(pkg), { mode: 0o644 });
  await writeFile(join(workspace, "package-lock.json"), encode({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { "": { name: pkg.name, version: pkg.version, workspaces: pkg.workspaces, dependencies: pkg.dependencies },
      "packages/a": { name: "a", version: "1.0.0" }, "node_modules/a": { resolved: "packages/a", link: true } } }), { mode: 0o644 });
  await writeFile(join(workspace, "packages/a/package.json"), localBytes, { mode: 0o644 });
  await writeFile(join(workspace, "packages/a/index.js"), "module.exports = 'TEST preserved source';\n", { mode: 0o644 });
  const capture = await captureNpmLocalClosure({ workspacePath: workspace, maxInputBytes: 1048576, maxEntries: 2048, maxPackages: 16, maxDurationMs: 10000 });
  if (capture.status !== NpmInputCaptureStatus.Qualified) throw new Error(`TEST capture:${capture.reason}`);
  await mkdir(join(workspace, "node_modules")); await symlink("../packages/a", join(workspace, "node_modules/a"));
  const session = openCapturedDependencySourceLinks(capture);
  // Shared tmp ancestors can change between async lstat/open in parallel TEST
  // files. Retry only pre-publication observations, never recapture inputs.
  const tree = await identity(join(workspace, "node_modules"));
  const ownedPaths = [...new Set([root, policy, sourceRoot, ...capture.pins.map(pin => join(workspace, pin.path)),
    join(workspace, "node_modules"), join(workspace, "node_modules/a")])];
  const statPin = async (path: string) => {
    const { dev, ino, mode, uid, gid, size, nlink, blocks, mtimeNs, ctimeNs } = await lstat(path, { bigint: true });
    return { dev, ino, mode, uid, gid, size, nlink, blocks, mtimeNs, ctimeNs };
  };
  const originalPins = await Promise.all(ownedPaths.map(statPin)), deadline = performance.now() + 30000;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error("TEST observation:original budget exhausted");
    return ms;
  };
  const assertOriginal = async () => {
    remaining();
    readDependencySourceLinkSession(session, capture.workspace, "node_modules");
    expect(await Promise.all(ownedPaths.map(statPin))).toEqual(originalPins);
    remaining();
  };
  const observeOriginal = async () => {
    await assertOriginal();
    const result = await observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", sourceLinkSession: session,
      expectedWorkspace: capture.workspace, expectedTree: { dev: tree.dev, ino: tree.ino },
      limits: { maxEntries: 128, maxTotalBytes: 65536, maxManifestBytes: 65536, maxDurationMs: remaining() } });
    await assertOriginal();
    return result;
  };
  let observed = await observeOriginal();
  for (let attempt = 1; attempt < 3 && observed.status === DependencyTreeObservationStatus.Incomplete &&
      observed.reason === DependencyTreeObservationFailure.IdentityChanged; attempt++) observed = await observeOriginal();
  if (observed.status !== DependencyTreeObservationStatus.Complete) throw new Error(`TEST observation:${observed.reason}`);
  const generation = randomUUID(), directory = join(policy, generation); await mkdir(directory, { mode: 0o700 });
  const start = await retainedRecord(join(directory, "start.json"), encode({ TEST: "immutable start", generation })),
    creator = await retainedRecord(join(directory, "creator.json"), encode({ TEST: "immutable creator", generation })),
    completion = await retainedRecord(join(directory, "creator-completion.json"), encode({ TEST: "immutable completion", generation, startSha256: start.sha256, creatorSha256: creator.sha256 })),
    terminal = await retainedRecord(join(directory, "terminal.json"), encode({ TEST: "immutable terminal", generation, tree: observed.tree }));
  const binding = { generation, workspace: capture.workspace, coverageRevision: "TEST-output-coverage", installKey: "a".repeat(64), tree: observed.tree, manifestDigest: observed.digest };
  // Independent protocol oracle from actual capture/observation, before any
  // claimed record. Explicit coordinates are this fixture's known physical link.
  const independentBody = { version: 2, profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1, generation,
    workspace: capture.workspace, coverageRevision: binding.coverageRevision, installKey: binding.installKey, tree: observed.tree,
    manifestDigest: observed.digest, operationId: generation, installerCompletionSha256: completion.sha256, closureDigest: capture.closureDigest,
    sourceLinks: [{ path: [Buffer.from("a").toString("base64")], target: Buffer.from("../packages/a").toString("base64"), sourcePath: "packages/a",
      packageManifestSha256: hash(localBytes), closureDigest: capture.closureDigest }],
    directories: capture.pins.filter(pin => pin.kind === NpmLocalPinKind.Directory).map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    ancestors: capture.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })) };
  const evidence: DependencyLocalOutputEvidence = { version: 1, profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1, generation,
    operationId: generation, workspace: capture.workspace, coverageRevision: binding.coverageRevision, installKey: binding.installKey, closureDigest: capture.closureDigest,
    inputSha256: hash(Buffer.concat([Buffer.from(capture.packageBytes), Buffer.from(capture.lockBytes)])), profileSha256: "b".repeat(64), start, creator, completion, terminal,
    tree: observed.tree, manifestVersion: 2, manifestDigest: observed.digest, manifestPlacementRevision: "c".repeat(64), verifiedBindingSha256: hash(encode(independentBody)) };
  const outputBytes = encode(evidence), outputReference = await retainedRecord(join(directory, "verified-local-output.json"), outputBytes), custody = await identity(policy), uid = BigInt(process.geteuid!());
  // TEST byte/reference qualification only. These files are not runtime records
  // and this composition does not claim creator/cgroup/G1/Ready host authority.
  const completionVerifier = { assertInstallerCompletion(record: DependencySourceBindingRecord): void {
    readDependencyProtectedReference(start, custody, uid); readDependencyProtectedReference(creator, custody, uid);
    readDependencyProtectedReference(completion, custody, uid);
    if (record.generation !== generation || record.installerCompletionSha256 !== completion.sha256) throw new Error("TEST completion binding");
  } };
  const outputVerifier = { assertVerifiedOutput(record: DependencySourceBindingRecord): void {
    if (record.version !== 2 || record.outputReference.path !== outputReference.path) throw new Error("TEST V2 required");
    const value: unknown = JSON.parse(readDependencyProtectedReference(record.outputReference, custody, uid).toString("utf8"));
    assertDependencyLocalOutputEvidence(value);
    for (const ref of [value.start, value.creator, value.completion, value.terminal]) readDependencyProtectedReference(ref, custody, uid);
    assertDependencyLocalOutputBinding(record, value);
  } };
  const body = capturedDependencySourceBindingOutputBody(capture, binding, completion.sha256), record: DependencySourceBindingRecordV2 = { ...body, outputReference };
  const store = new LocalDependencySourceBindingStore(sourceRoot, completionVerifier, outputVerifier);
  const ready = (reference: DependencySourceBindingReference): DependencyCompletedLocalReady => ({ version: 1, revision: 2, generation, workspace: binding.workspace,
    coverageRevision: binding.coverageRevision, state: DependencyReceiptState.Ready, installKey: binding.installKey, tree: binding.tree, manifestDigest: binding.manifestDigest,
    provenance: { ...binding, kind: DependencyInstallProofKind.CompletedLocalInstallV1, operationId: generation,
      verificationEvidenceId: binding.manifestDigest, installerDrainEvidenceId: completion.sha256, sourceBinding: reference } });
  return { root, workspace, policy, sourceRoot, custody, uid, evidence, outputBytes, outputReference, record, body, store, ready, completionVerifier,
    cleanup: async () => { closeDependencySourceLinkSession(session); await rm(root, { recursive: true, force: true }); } };
}

// Red risks: omitted V2 body fields let a fabricated mapping authenticate;
// immutable evidence can be replaced with identical bytes; legacy/missing
// output refs inherit authority; or record symlinks/hardlinks evade no-follow.
describe.skipIf(process.platform !== "linux")("actual TEST protected output references", () => {
  it("authenticates the complete independent observed binding and rejects mutable claims before a source leaf", async () => {
    const f = await fixture();
    try {
      for (const record of [{ ...f.record, sourceLinks: [] }, { ...f.record, tree: { ...f.record.tree, ino: "999999" } },
        { ...f.record, manifestDigest: "d".repeat(64) }, { ...f.record, coverageRevision: "TEST different coverage" },
        { ...f.record, installKey: "e".repeat(64) },
        { ...f.record, directories: f.record.directories.map(pin => pin.path === "packages/a" ? { ...pin, ino: "999998" } : pin) },
        { ...f.record, ancestors: f.record.ancestors.map((pin, index) => index === 0 ? { ...pin, ino: "999997" } : pin) }]) {
        f.completionVerifier.assertInstallerCompletion(record);
        expect(() => f.store.publish(record)).toThrow();
        expect(await readdir(f.sourceRoot)).toEqual([]);
      }
      const reference = f.store.publish(f.record), opened = f.store.open(f.ready(reference));
      try { expect(dependencySourceLinkProof(opened).reference).toEqual(reference); }
      finally { closeDependencySourceLinkSession(opened); }
      expect(await readFile(join(f.workspace, "node_modules/a/index.js"), "utf8")).toContain("TEST preserved source");
    } finally { await f.cleanup(); }
  });

  it("denies missing, undefined, extra and legacy output reference shapes without publication", async () => {
    const f = await fixture();
    try {
      for (const value of [{ ...f.body }, { ...f.record, outputReference: undefined }, { ...f.record, ignored: true },
        { ...f.record, outputReference: { ...f.outputReference, ignored: true } }]) expect(() => assertDependencySourceBindingRecord(value)).toThrow();
      const legacy = { ...f.body, version: 1 as const };
      assertDependencySourceBindingRecord(legacy);
      expect(() => f.store.publish(legacy)).toThrow(); expect(await readdir(f.sourceRoot)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("rechecks output identity on active sessions and refuses identical bytes at a substituted inode", async () => {
    const f = await fixture();
    try {
      const reference = f.store.publish(f.record), opened = f.store.open(f.ready(reference));
      try {
        await rename(f.outputReference.path, f.outputReference.path + ".held"); await writeFile(f.outputReference.path, f.outputBytes, { mode: 0o600 });
        expect(() => dependencySourceLinkProof(opened)).toThrow();
        expect(await readFile(reference.path)).toEqual(encode(f.record));
        expect(await readFile(join(f.workspace, "packages/a/index.js"), "utf8")).toContain("TEST preserved source");
      } finally { closeDependencySourceLinkSession(opened); }
    } finally { await f.cleanup(); }
  });

  it.each(["symlink", "hardlink", "content"])("denies protected %s substitution without touching source", async kind => {
    const f = await fixture();
    try {
      if (kind === "hardlink") await link(f.outputReference.path, f.outputReference.path + ".alias");
      else if (kind === "symlink") { await rename(f.outputReference.path, f.outputReference.path + ".held"); await symlink(f.outputReference.path + ".held", f.outputReference.path); }
      else await writeFile(f.outputReference.path, encode({ ...f.evidence, manifestDigest: "e".repeat(64) }));
      expect(() => f.store.publish(f.record)).toThrow(); expect(await readdir(f.sourceRoot)).toEqual([]);
      expect(await readFile(join(f.workspace, "packages/a/index.js"), "utf8")).toContain("TEST preserved source");
    } finally { await f.cleanup(); }
  });
});
