import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DependencyUnverifiedReason, DependencyInstallProofKind as Proof, DependencyPreservationKind as Preserve, DependencyReceiptState as State,
  type DependencyProofBinding, type DependencyReceipt, type DependencyWorkspaceIdentity } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyReceiptParseStatus as Parsed, parseDependencyReceipt } from "../../../worker-core/dependency-environment/domain/parse-dependency-receipt";
import { DependencyTreeObservationStatus as Observed, DependencyTreeObservationFailure as Failure } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { DependencyLegacyLocalSourceBindingKind, type DependencyLegacyLocalSourceBindingRecord, type DependencyCompletedLocalReady, type DependencySourceBindingRecord } from "../../../worker-core/dependency-environment/ports/dependency-source-binding";
import { LocalDependencyReceiptStore, DependencyReceiptStorageFailure } from "../../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { NpmInputCaptureStatus } from "../capture-npm-install-inputs";
import { captureNpmLocalClosure, NpmLocalPinKind } from "../capture-npm-local-closure";
import { capturedDependencySourceBinding, closeDependencySourceLinkSession, dependencySourceLinkProof,
  LocalDependencySourceBindingStore, openCapturedDependencySourceLinks } from "../dependency-source-binding";
import { DependencySourceBindingFailure } from "../dependency-source-binding";
import { openCommittedDependencyTrashRemoval, openDependencyTreeRename, type DependencyTreeEffectInput } from "../dependency-tree-effects";
import { observeDependencyDirectoryRoot, observeDependencyTree } from "../observe-dependency-tree";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const limits = { maxEntries: 128, maxTotalBytes: 65536, maxManifestBytes: 65536, maxDurationMs: 30000 };
const run = promisify(execFile);
async function identity(path: string): Promise<DependencyWorkspaceIdentity> {
  const stat = await lstat(path, { bigint: true }); return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) };
}
function readTestEvidence(path: string, expected: DependencyWorkspaceIdentity, bytes: Buffer): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(bytes.length) || bytes.length > 1024 * 1024 ||
        String(before.dev) !== expected.dev || String(before.ino) !== expected.ino || (before.mode & 0o7777n) !== 0o600n) throw new Error("TEST evidence identity");
    const buffer = Buffer.alloc(bytes.length + 1); let offset = 0;
    while (offset < buffer.length) { const read = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!read) break; offset += read; }
    const observed = buffer.subarray(0, offset), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!observed.equals(bytes) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink ||
        before.mode !== after.mode || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || named.dev !== before.dev || named.ino !== before.ino || named.nlink !== 1n) throw new Error("TEST evidence changed");
    return observed;
  } finally { closeSync(fd); }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-dependency-source-binding-")));
  const workspacePath = join(root, "owned/workspace"), policy = join(root, "policy"), sourceRoot = join(policy, "dependency-source-bindings");
  await mkdir(join(workspacePath, "packages/a"), { recursive: true });
  await mkdir(policy, { mode: 0o700 }); await mkdir(sourceRoot, { mode: 0o700 });
  const pkg = { name: "test-local-root", version: "1.0.0", private: true, workspaces: ["packages/a"], dependencies: { a: "*" } };
  await writeFile(join(workspacePath, "package.json"), encode(pkg), { mode: 0o644 });
  await writeFile(join(workspacePath, "package-lock.json"), encode({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { "": { name: pkg.name, version: pkg.version, workspaces: pkg.workspaces, dependencies: pkg.dependencies },
      "packages/a": { name: "a", version: "1.0.0" }, "node_modules/a": { resolved: "packages/a", link: true } } }), { mode: 0o644 });
  await writeFile(join(workspacePath, "packages/a/package.json"), encode({ name: "a", version: "1.0.0", main: "code.js" }), { mode: 0o644 });
  await writeFile(join(workspacePath, "packages/a/code.js"), "TEST original source", { mode: 0o644 });
  const captured = await captureNpmLocalClosure({ workspacePath, maxInputBytes: 1024 * 1024, maxEntries: 2048, maxPackages: 16, maxDurationMs: 10000 });
  if (captured.status !== NpmInputCaptureStatus.Qualified) throw new Error("TEST local capture refused");
  // Physical synthetic output, not npm install, provider admission or G1 proof.
  await mkdir(join(workspacePath, "node_modules")); await symlink("../packages/a", join(workspacePath, "node_modules/a"));
  const captureSession = openCapturedDependencySourceLinks(captured);
  const observed = await observeDependencyTree({ workspacePath, treeName: "node_modules", limits, sourceLinkSession: captureSession });
  if (observed.status !== Observed.Complete) throw new Error(`TEST linked observation:${observed.reason}`);
  const generation = randomUUID(), binding: DependencyProofBinding = { generation, workspace: captured.workspace, coverageRevision: "TEST-coverage",
    installKey: "a".repeat(64), tree: observed.tree, manifestDigest: observed.digest };
  // The test composition authenticates a real immutable TEST completion file.
  // This explicitly does not substitute for the hosted installer/drain verifier.
  const completionPath = join(policy, "TEST-completion.json"), completionBytes = encode({ version: 1, generation,
    installKey: binding.installKey, closureDigest: captured.closureDigest });
  await writeFile(completionPath, completionBytes, { mode: 0o600, flag: "wx" });
  const completionIdentity = await identity(completionPath);
  const completionVerifier = { assertInstallerCompletion(record: DependencySourceBindingRecord): void {
    const bytes = readTestEvidence(completionPath, completionIdentity, completionBytes);
    if (hash(bytes) !== record.installerCompletionSha256 || record.generation !== generation ||
        record.installKey !== binding.installKey || record.closureDigest !== captured.closureDigest) throw new Error("TEST completion mismatch");
  } };
  // Independent TEST output evidence is created from the actual observer/capture
  // before the caller's record exists, never by serializing that claimed record.
  const output = { version: 1, generation, workspace: observed.workspace, tree: observed.tree, coverageRevision: binding.coverageRevision,
    installKey: binding.installKey, closureDigest: captured.closureDigest, installerCompletionSha256: hash(completionBytes),
    manifestDigest: observed.digest, canonicalManifest: Buffer.from(observed.canonicalBytes).toString("base64"),
    directories: captured.pins.filter(pin => pin.kind === NpmLocalPinKind.Directory).map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    ancestors: captured.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })) };
  const outputPath = join(policy, "TEST-verified-output.json"), outputBytes = encode(output);
  await writeFile(outputPath, outputBytes, { mode: 0o600, flag: "wx" }); const outputIdentity = await identity(outputPath);
  const outputVerifier = { assertVerifiedOutput(record: DependencySourceBindingRecord): void {
    const authenticated = JSON.parse(readTestEvidence(outputPath, outputIdentity, outputBytes).toString("utf8")) as typeof output;
    const canonical = Buffer.from(authenticated.canonicalManifest, "base64"), manifest = JSON.parse(canonical.toString("utf8")) as { sourceLinks: unknown };
    completionVerifier.assertInstallerCompletion(record);
    if (authenticated.generation !== record.generation || JSON.stringify(authenticated.workspace) !== JSON.stringify(record.workspace) ||
        JSON.stringify(authenticated.tree) !== JSON.stringify(record.tree) || authenticated.coverageRevision !== record.coverageRevision ||
        authenticated.installKey !== record.installKey || authenticated.closureDigest !== record.closureDigest ||
        authenticated.installerCompletionSha256 !== record.installerCompletionSha256 || authenticated.manifestDigest !== record.manifestDigest ||
        hash(canonical) !== record.manifestDigest || JSON.stringify(manifest.sourceLinks) !== JSON.stringify(record.sourceLinks) ||
        JSON.stringify(authenticated.directories) !== JSON.stringify(record.directories) || JSON.stringify(authenticated.ancestors) !== JSON.stringify(record.ancestors)) throw new Error("TEST output binding mismatch");
  } };
  const sourceStore = new LocalDependencySourceBindingStore(sourceRoot, completionVerifier, outputVerifier);
  const record = capturedDependencySourceBinding(captured, binding, hash(completionBytes));
  const reference = sourceStore.publish(record);
  const ready: DependencyCompletedLocalReady = { version: 1, revision: 2, generation, workspace: binding.workspace,
    coverageRevision: binding.coverageRevision, state: State.Ready, installKey: binding.installKey, tree: binding.tree, manifestDigest: binding.manifestDigest,
    provenance: { ...binding, kind: Proof.CompletedLocalInstallV1, operationId: generation, verificationEvidenceId: binding.manifestDigest,
      installerDrainEvidenceId: hash(completionBytes), sourceBinding: reference } };
  const trashPath = join(policy, "trash"); await mkdir(trashPath, { mode: 0o700 });
  const operationId = randomUUID(), trash = { operationId, originalTree: observed.tree, destinationParent: await identity(trashPath), destinationName: `dependency-${operationId}` };
  const effectInput = (sourceLinkSession = sourceStore.open(ready)): DependencyTreeEffectInput => ({ workspace: binding.workspace, trash,
    manifestCanonicalBytes: observed.canonicalBytes, manifestDigest: binding.manifestDigest, limits, sourceLinkSession });
  return { root, workspacePath, policy, sourceRoot, capture: captured, captureSession, observed, binding, sourceStore, record, reference, ready, trash,
    completionVerifier, outputVerifier, effectInput, completionPath, completionBytes, outputPath, outputBytes, target: join(trashPath, trash.destinationName),
    cleanup: async () => { closeDependencySourceLinkSession(captureSession); await rm(root, { recursive: true, force: true }); } };
}
function reason(action: () => unknown): string {
  try { action(); } catch (error) { if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") return error.reason; throw error; }
  throw new Error("TEST expected rejection");
}
async function commitAbsent(f: Awaited<ReturnType<typeof fixture>>) {
  const absent: Extract<DependencyReceipt, { state: State.Absent }> = { version: 1, revision: 4, generation: f.ready.generation,
    workspace: f.ready.workspace, coverageRevision: f.ready.coverageRevision, state: State.Absent, operationId: f.trash.operationId,
    installKey: f.ready.installKey, evictionCommit: { ...f.binding, operationId: f.trash.operationId, trash: f.trash, commitEvidenceId: "TEST committed rename" } };
  const path = join(f.policy, "TEST-absent.json"), bytes = encode(absent); await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { bytes, reference: { path, identity: await identity(path), sha256: hash(bytes) } };
}

// Red risks: a captured claim mints Ready/effects; physical substitution keeps a
// valid logical key; a trash-relative source link is resolved/followed on unlink;
// or the current Ready accidentally supplies authority for an older generation.
describe.skipIf(process.platform !== "linux")("protected source links in fresh TEST filesystems", () => {
  it("rejects substituted capture digests before deriving links or a publication record", async () => {
    const f = await fixture();
    try {
      const forged = { ...f.capture, closureDigest: "e".repeat(64) };
      expect(() => openCapturedDependencySourceLinks(forged)).toThrow();
      expect(() => capturedDependencySourceBinding(forged, f.binding, hash(f.completionBytes))).toThrow();
      expect(await readFile(f.reference.path)).toEqual(encode(f.record));
      expect(await readFile(join(f.workspacePath, "node_modules/a/code.js"), "utf8")).toBe("TEST original source");
    } finally { await f.cleanup(); }
  });

  it("requires independently authenticated output despite a genuine completion and creates no unbound source record", async () => {
    const f = await fixture(), parent = join(f.policy, "unbound"), rootPath = join(parent, "dependency-source-bindings");
    await mkdir(parent, { mode: 0o700 }); await mkdir(rootPath, { mode: 0o700 });
    try {
      const completionOnly = new LocalDependencySourceBindingStore(rootPath, f.completionVerifier);
      f.completionVerifier.assertInstallerCompletion(f.record);
      expect(reason(() => completionOnly.publish(f.record))).toBe(DependencySourceBindingFailure.OutputProof);
      expect(await readdir(rootPath)).toEqual([]);
      const verified = new LocalDependencySourceBindingStore(rootPath, f.completionVerifier, f.outputVerifier);
      for (const forged of [{ ...f.record, tree: { ...f.record.tree, ino: "999999999999" } },
        { ...f.record, manifestDigest: "e".repeat(64) }, { ...f.record, sourceLinks: [] }]) {
        f.completionVerifier.assertInstallerCompletion(forged);
        expect(reason(() => verified.publish(forged))).toBe(DependencySourceBindingFailure.OutputProof);
        expect(await readdir(rootPath)).toEqual([]);
      }
      const reopenedWithoutOutput = new LocalDependencySourceBindingStore(f.sourceRoot, f.completionVerifier);
      expect(reason(() => reopenedWithoutOutput.open(f.ready))).toBe(DependencySourceBindingFailure.OutputProof);
      const session = f.sourceStore.open(f.ready);
      try {
        await rename(f.outputPath, f.outputPath + ".held"); await writeFile(f.outputPath, f.outputBytes, { mode: 0o600 });
        expect(reason(() => dependencySourceLinkProof(session))).toBe(DependencySourceBindingFailure.OutputProof);
        expect(await readFile(f.reference.path)).toEqual(encode(f.record));
        expect(await readFile(join(f.workspacePath, "node_modules/a/code.js"), "utf8")).toBe("TEST original source");
      } finally { closeDependencySourceLinkSession(session); }
    } finally { await f.cleanup(); }
  });

  it("keeps registry v1 closed and linked source bytes live without counting them in the target", async () => {
    const f = await fixture();
    try {
      expect(await observeDependencyTree({ workspacePath: f.workspacePath, treeName: "node_modules", limits }))
        .toEqual({ status: Observed.Incomplete, reason: Failure.ExternalSymlink });
      expect(await observeDependencyTree({ workspacePath: f.workspacePath, treeName: "node_modules", limits, sourceLinkSession: { ...f.captureSession } }))
        .toEqual({ status: Observed.Incomplete, reason: Failure.SourceBinding });
      expect(JSON.parse(Buffer.from(f.observed.canonicalBytes).toString())).toMatchObject({ version: 2, sourceLinks: [{ sourcePath: "packages/a" }] });
      expect(f.observed.entries.map(entry => entry.path)).toEqual([[], [Buffer.from("a").toString("base64")]]);
      expect(f.observed.measurement.allocationByKind.file.inodeCount).toBe("0");
      await writeFile(join(f.workspacePath, "packages/a/code.js"), "TEST code edit remains live");
      const current = await observeDependencyTree({ workspacePath: f.workspacePath, treeName: "node_modules", limits, sourceLinkSession: f.captureSession });
      expect(current.status).toBe(Observed.Complete);
      if (current.status === Observed.Complete) expect(current.digest).toBe(f.observed.digest);
      expect(await readFile(join(f.workspacePath, "node_modules/a/code.js"), "utf8")).toBe("TEST code edit remains live");
      expect(() => dependencySourceLinkProof(f.captureSession)).toThrow();
      const forged = { ...f.capture, closure: { ...f.capture.closure,
        edges: f.capture.closure.edges.map((edge, index) => index === 0 ? { ...edge, installedPaths: ["node_modules/forged"] } : edge) } };
      expect(() => openCapturedDependencySourceLinks(forged)).toThrow();
      await expect(openDependencyTreeRename(f.effectInput(f.captureSession))).rejects.toThrow();
      expect((await lstat(join(f.workspacePath, "node_modules/a"))).isSymbolicLink()).toBe(true);
    } finally { await f.cleanup(); }
  });

  it.each(["source", "ancestor"])("observes stage identities independently and refuses a replaced stage %s", async change => {
    const f = await fixture();
    try {
      const stageParent = join(f.root, "stage"), stage = join(stageParent, "workspace"); await mkdir(stageParent);
      await cp(f.workspacePath, stage, { recursive: true, verbatimSymlinks: true });
      const stageIdentity = await identity(stage), staged = openCapturedDependencySourceLinks(f.capture, stageIdentity);
      try {
        const before = await observeDependencyTree({ workspacePath: stage, treeName: "node_modules", limits, sourceLinkSession: staged });
        expect(before.status).toBe(Observed.Complete);
        if (change === "source") { await rename(join(stage, "packages/a"), join(stage, "held-a")); await cp(join(stage, "held-a"), join(stage, "packages/a"), { recursive: true }); }
        else { await rename(stageParent, stageParent + ".held"); await mkdir(stageParent); await rename(join(stageParent + ".held", "workspace"), stage);
          expect(await identity(stage)).toEqual(stageIdentity); }
        expect((await observeDependencyTree({ workspacePath: stage, treeName: "node_modules", limits, sourceLinkSession: staged })).status).toBe(Observed.Incomplete);
        expect(await readFile(join(stage, change === "source" ? "held-a/code.js" : "packages/a/code.js"), "utf8")).toBe("TEST original source");
      } finally { closeDependencySourceLinkSession(staged); }
    } finally { await f.cleanup(); }
  });

  it.each(["source", "ancestor", "link target"])("denies %s substitution before rename and preserves external bytes", async change => {
    const f = await fixture(), input = f.effectInput(), op = await openDependencyTreeRename(input);
    try {
      const foreign = join(f.root, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "sentinel"), "TEST external bytes");
      if (change === "source") { await rename(join(f.workspacePath, "packages/a"), join(f.root, "held-a")); await cp(join(f.root, "held-a"), join(f.workspacePath, "packages/a"), { recursive: true }); }
      if (change === "ancestor") { await rename(join(f.workspacePath, "packages"), join(f.workspacePath, "held-packages")); await symlink(foreign, join(f.workspacePath, "packages")); }
      if (change === "link target") { await rm(join(f.workspacePath, "node_modules/a")); await symlink(foreign, join(f.workspacePath, "node_modules/a")); }
      await expect(op.rename()).rejects.toThrow();
      expect((await lstat(join(f.workspacePath, "node_modules"))).isDirectory()).toBe(true);
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("TEST external bytes");
    } finally { await op.close(); if (input.sourceLinkSession) closeDependencySourceLinkSession(input.sourceLinkSession); await f.cleanup(); }
  });

  // Enabled only by the existing Linux TEST user/mount namespace CI lane.
  it.skipIf(process.env.SUBSCRIPTION_RUNTIME_TEST_MOUNT_NAMESPACE !== "1")("vetoes same-inode source bind substitution by mount identity", async () => {
    const f = await fixture(), input = f.effectInput(), op = await openDependencyTreeRename(input), target = join(f.workspacePath, "packages/a");
    try {
      const before = await identity(target); await run("mount", ["--bind", target, target]);
      expect(await identity(target)).toEqual(before);
      await expect(op.rename()).rejects.toThrow();
      expect(await readFile(join(target, "code.js"), "utf8")).toBe("TEST original source");
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await run("umount", [target]).catch(() => undefined); await op.close(); if (input.sourceLinkSession) closeDependencySourceLinkSession(input.sourceLinkSession); await f.cleanup(); }
  });

  it("requires an authenticated immutable completion chain before Ready publication", async () => {
    const f = await fixture(), history = join(f.policy, "receipts"); await mkdir(history, { mode: 0o700 });
    let store = LocalDependencyReceiptStore.open({ rootPath: history, maxRecordBytes: 16384, maxHistorySteps: 16 });
    try {
      const installing: DependencyReceipt = { version: 1, revision: 1, generation: f.binding.generation, workspace: f.binding.workspace,
        coverageRevision: f.binding.coverageRevision, state: State.Installing, operationId: f.binding.generation, requestedKey: f.binding.installKey,
        preservation: { kind: Preserve.KnownFreshAbsence, generation: f.binding.generation, workspace: f.binding.workspace,
          coverageRevision: f.binding.coverageRevision, operationId: f.binding.generation, absenceEvidenceId: "TEST fresh synthetic output" } };
      expect(parseDependencyReceipt(f.ready).status).toBe(Parsed.Valid);
      store.compareAndSwap(f.binding.workspace, null, installing);
      expect(reason(() => store.compareAndSwap(f.binding.workspace, 1, f.ready))).toBe(DependencyReceiptStorageFailure.InvalidTransition);
      expect(store.read(f.binding.workspace)).toEqual(installing);
      store.close(); store = LocalDependencyReceiptStore.open({ rootPath: history, maxRecordBytes: 16384, maxHistorySteps: 16,
        localInstallVerifier: new LocalDependencySourceBindingStore(f.sourceRoot, f.completionVerifier) });
      expect(reason(() => store.compareAndSwap(f.binding.workspace, 1, f.ready))).toBe(DependencyReceiptStorageFailure.InvalidTransition);
      expect(store.read(f.binding.workspace)).toEqual(installing);
      store.close(); store = LocalDependencyReceiptStore.open({ rootPath: history, maxRecordBytes: 16384, maxHistorySteps: 16, localInstallVerifier: f.sourceStore });
      await rename(f.completionPath, f.completionPath + ".held"); await writeFile(f.completionPath, f.completionBytes, { mode: 0o600 });
      expect(reason(() => store.compareAndSwap(f.binding.workspace, 1, f.ready))).toBe(DependencyReceiptStorageFailure.InvalidTransition);
      expect(store.read(f.binding.workspace)).toEqual(installing);
      await rm(f.completionPath); await rename(f.completionPath + ".held", f.completionPath);
      const held = f.reference.path + ".held", bytes = await readFile(f.reference.path);
      await rename(f.reference.path, held); await writeFile(f.reference.path, bytes, { mode: 0o600 });
      expect(reason(() => store.compareAndSwap(f.binding.workspace, 1, f.ready))).toBe(DependencyReceiptStorageFailure.InvalidTransition);
      expect(store.read(f.binding.workspace)).toEqual(installing);
      await rm(f.reference.path); await rename(held, f.reference.path);
      expect(store.compareAndSwap(f.binding.workspace, 1, f.ready)).toEqual(f.ready);
      expect(await readFile(join(f.workspacePath, "packages/a/code.js"), "utf8")).toBe("TEST original source");
    } finally { store.close(); await f.cleanup(); }
  });

  it("removes only the authenticated old remainder without resolving trash-relative source links", async () => {
    const f = await fixture(), originalInput = f.effectInput(), renameOperation = await openDependencyTreeRename(originalInput);
    try {
      await renameOperation.rename(); await renameOperation.close();
      // A fresh source tree/current generation does not authenticate old trash.
      await mkdir(join(f.workspacePath, "node_modules")); await writeFile(join(f.workspacePath, "node_modules/fresh"), "TEST new installation");
      const falseTarget = join(f.trash.destinationParent.canonicalPath, "packages/a"); await mkdir(falseTarget, { recursive: true });
      await writeFile(join(falseTarget, "sentinel"), "TEST raw-relative wrong target");
      expect(await readFile(join(f.target, "a/sentinel"), "utf8")).toBe("TEST raw-relative wrong target");
      const { bytes: commitBytes, reference: commit } = await commitAbsent(f);
      const detached = f.sourceStore.open(f.ready, { workspace: f.trash.destinationParent, name: f.trash.destinationName });
      const input = f.effectInput(detached);
      try {
        const whole = await observeDependencyDirectoryRoot({ parentPath: f.trash.destinationParent.canonicalPath, name: f.trash.destinationName,
          expectedTree: f.binding.tree, limits, sourceLinkSession: detached });
        expect(whole.status, whole.status === Observed.Incomplete ? whole.reason : undefined).toBe(Observed.Complete);
        if (whole.status === Observed.Complete) expect(whole.digest).toBe(f.binding.manifestDigest);
        await writeFile(join(f.workspacePath, "packages/a/package.json"), encode({ name: "a", version: "2.0.0" }));
        const partial = await openCommittedDependencyTrashRemoval({ ...input, commit, maxRemovals: 1 });
        try { await expect(partial.remove()).rejects.toThrow("bounds"); } finally { await partial.close(); }
        expect((await lstat(f.target)).isDirectory()).toBe(true);
        const retry = await openCommittedDependencyTrashRemoval({ ...input, commit, maxRemovals: 128 });
        try { expect((await retry.remove()).removedEntries).toBe(1); } finally { await retry.close(); }
        await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(falseTarget, "sentinel"), "utf8")).toBe("TEST raw-relative wrong target");
        expect(await readFile(join(f.workspacePath, "packages/a/code.js"), "utf8")).toBe("TEST original source");
        expect(await readFile(join(f.workspacePath, "node_modules/fresh"), "utf8")).toBe("TEST new installation");
        expect(await readFile(commit.path)).toEqual(commitBytes);
      } finally { closeDependencySourceLinkSession(detached); }
    } finally { await renameOperation.close(); if (originalInput.sourceLinkSession) closeDependencySourceLinkSession(originalInput.sourceLinkSession); await f.cleanup(); }
  });

  it.each(["source", "protected reference"])("holds prepared old trash after %s replacement without deleting a leaf", async change => {
    const f = await fixture(), originalInput = f.effectInput(), renameOperation = await openDependencyTreeRename(originalInput);
    try {
      await renameOperation.rename(); await renameOperation.close();
      const { reference: commit, bytes: commitBytes } = await commitAbsent(f);
      const detached = f.sourceStore.open(f.ready, { workspace: f.trash.destinationParent, name: f.trash.destinationName });
      const removal = await openCommittedDependencyTrashRemoval({ ...f.effectInput(detached), commit, maxRemovals: 128 });
      try {
        if (change === "source") { await rename(join(f.workspacePath, "packages/a"), join(f.root, "held-a")); await cp(join(f.root, "held-a"), join(f.workspacePath, "packages/a"), { recursive: true }); }
        else { const bytes = await readFile(f.reference.path); await rename(f.reference.path, f.reference.path + ".held"); await writeFile(f.reference.path, bytes, { mode: 0o600 }); }
        await expect(removal.remove()).rejects.toThrow();
        expect((await lstat(join(f.target, "a"))).isSymbolicLink()).toBe(true);
        expect(await readFile(join(f.workspacePath, "packages/a/code.js"), "utf8")).toBe("TEST original source");
        expect(await readFile(commit.path)).toEqual(commitBytes);
      } finally { await removal.close(); closeDependencySourceLinkSession(detached); }
    } finally { await renameOperation.close(); if (originalInput.sourceLinkSession) closeDependencySourceLinkSession(originalInput.sourceLinkSession); await f.cleanup(); }
  });
});

// Red if protected historical reads open mutable sources, if the separate
// mapping accepts installed completion fields, or if no verifier grants publish.
describe.skipIf(process.platform !== "linux")("compared-local mapping is separate history", () => {
  it("reads only pinned historical bytes after source disappearance and denies substitutions", async () => {
    const f = await fixture();
    try {
      const operationId = randomUUID(), original: DependencyLegacyLocalSourceBindingRecord["original"]["receipt"] = {
        version: 1, revision: 1, state: State.Unverified, reason: DependencyUnverifiedReason.BaselineMissing,
        generation: f.binding.generation, workspace: f.binding.workspace, coverageRevision: f.binding.coverageRevision, tree: f.binding.tree };
      const record: DependencyLegacyLocalSourceBindingRecord = { version: 1,
        kind: DependencyLegacyLocalSourceBindingKind.LegacyLocalComparedSourceV1, profile: f.record.profile, operationId, candidate: f.binding,
        original: { receipt: original, reference: f.reference }, referenceOutput: f.reference, closureDigest: f.record.closureDigest,
        sourceLinks: f.record.sourceLinks, directories: f.record.directories, ancestors: f.record.ancestors };
      // Shape-valid bytes below are history-reader data, never install or Ready authority.
      const path = join(f.sourceRoot, `${f.binding.workspace.dev}-${f.binding.workspace.ino}`, `${f.binding.generation}.${operationId}.compared-local.json`);
      const bytes = encode(record); await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      const fileIdentity = await identity(path);
      const reference = { path, identity: { dev: fileIdentity.dev, ino: fileIdentity.ino }, sha256: hash(bytes) };
      await rm(join(f.workspacePath, "packages"), { recursive: true });
      expect(() => f.sourceStore.readLegacyLocalCompared({ ...reference, identity: fileIdentity })).toThrow();
      expect(f.sourceStore.readLegacyLocalCompared(reference)).toEqual(record);
      expect(f.sourceStore.readInstalledHistory(f.reference)).toEqual(f.record);
      expect(() => f.sourceStore.readLegacyLocalCompared({ ...reference, sha256: "e".repeat(64) })).toThrow();
      await rename(path, path + ".held"); await symlink(path + ".held", path);
      expect(() => f.sourceStore.readLegacyLocalCompared(reference)).toThrow();
      await rm(path); await writeFile(path, encode({ ...record, installerCompletionSha256: "e".repeat(64) }), { mode: 0o600 });
      const forgedBytes = await readFile(path);
      expect(() => f.sourceStore.readLegacyLocalCompared({ path, identity: { dev: String(lstatSync(path, { bigint: true }).dev), ino: String(lstatSync(path, { bigint: true }).ino) }, sha256: hash(forgedBytes) })).toThrow();
      expect(await readFile(f.reference.path)).toEqual(encode(f.record));
    } finally { await f.cleanup(); }
  });
  it("requires the new protected verifier and preserves all leaves before publication", async () => {
    const f = await fixture();
    try {
      const before = await readdir(join(f.sourceRoot, `${f.binding.workspace.dev}-${f.binding.workspace.ino}`));
      const original: DependencyLegacyLocalSourceBindingRecord["original"]["receipt"] = { version: 1, revision: 1, generation: f.binding.generation,
        workspace: f.binding.workspace, coverageRevision: f.binding.coverageRevision, state: State.Unverified, tree: f.binding.tree,
        reason: DependencyUnverifiedReason.BaselineMissing };
      expect(reason(() => f.sourceStore.publishLegacyLocalCompared({ capture: f.capture, sourceSession: f.captureSession,
        candidate: f.binding, operationId: randomUUID(), original: { receipt: original, reference: f.reference }, referenceOutput: f.reference })))
        .toBe(DependencySourceBindingFailure.OutputProof);
      expect(await readdir(join(f.sourceRoot, `${f.binding.workspace.dev}-${f.binding.workspace.ino}`))).toEqual(before);
      expect(await readFile(join(f.workspacePath, "node_modules/a/code.js"), "utf8")).toBe("TEST original source");
    } finally { await f.cleanup(); }
  });
});
