import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyInstallProofKind, DependencyPreservationKind,
  DependencyReceiptState, DependencyTreeObservationStatus, claimDependencyConsumer, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind, type DependencyTestNpmToolchain } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { captureNpmInstallInputs, NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { buildTestNpmDependencyInstallKey } from "../../worker-local/dependency-environment/build-test-npm-dependency-install-key";
import { observeDependencyTree } from "../../worker-local/dependency-environment/observe-dependency-tree";
import { HostedDependencyInstallerRecipe } from "../hosted-dependency-installer-inputs";
import { consumeHostedDependencyColdHandoff, closeHostedDependencyColdHandoff, type HostedDependencyColdHandoff } from "../hosted-dependency-materialization";
import type { HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";

// Supplied TEST key facts never stand in for a genuine host/install permit.
const toolchain: DependencyTestNpmToolchain = {
  nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127", platform: "linux", arch: DependencyInstallArchitecture.X64,
  npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js", npmSha256: "b".repeat(64), npmVersion: "10.9.3",
  npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
  libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
  toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
};
// Red if copied final data/Ready/start labels mint a handoff or reach host IO.
// Positive same-attempt publication, exactly3 scans and true stale minted
// handles require the native disposable TEST fixture, never mocked authority.
describe.skipIf(process.platform !== "linux")("cold handoff private authority", () => {
  it("rejects a copied start despite actual FS observation and committed Ready, preserving history and bytes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-cold-handoff-")));
    const workspacePath = join(root, "workspace"), receiptsPath = join(root, "receipts"), ownersPath = join(root, "owners");
    for (const path of [workspacePath, receiptsPath, ownersPath]) await mkdir(path, { mode: 0o700 });
    await mkdir(join(workspacePath, "node_modules"), { mode: 0o700 });
    const file = join(workspacePath, "node_modules", "index.js"), sentinel = Buffer.from("module.exports = 7;\n");
    await writeFile(file, sentinel, { mode: 0o600 });
    const pkg = { name: "test-cold-handoff", version: "1.0.0" };
    await writeFile(join(workspacePath, "package.json"), JSON.stringify(pkg));
    await writeFile(join(workspacePath, "package-lock.json"), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }));
    const stat = await lstat(workspacePath, { bigint: true }), workspace = { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) };
    const owners = LocalDependencyOwnerStore.open({ rootPath: ownersPath, maxRecordBytes: 16384 });
    const receipts = LocalDependencyReceiptStore.open({ rootPath: receiptsPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
    try {
      const startId = randomUUID();
      const launch = { installationId: randomUUID(), bootId: randomUUID(), startId, runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64), unit: `subscription-runtime-ordinary-${startId}.service` };
      const attempt = claimDependencyConsumer(owners, workspace, launch, randomUUID());
      const binding: HostedDependencyBinding = { version: 1, jobId: "TEST-cold-handoff", jobRootDir: root, workspace,
        installationId: launch.installationId, runtimeSha: launch.runtimeSha, grantDigest: launch.grantDigest };
      const capture = await captureNpmInstallInputs({ workspacePath, expectedWorkspace: workspace, maxInputBytes: 16384, maxDurationMs: 10000 });
      if (capture.status !== NpmInputCaptureStatus.Qualified) throw new Error("TEST input capture failed");
      const key = buildTestNpmDependencyInstallKey({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, lockName: capture.lockName, toolchain, maxInputBytes: 16384, maxCanonicalBytes: 16384 });
      const inputs = { recipe: HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1 as const, capture, key, lockName: capture.lockName,
        packageBytes: Buffer.from(capture.packageBytes), lockBytes: Buffer.from(capture.lockBytes) };
      const final = await observeDependencyTree({ workspacePath, expectedWorkspace: workspace, treeName: "node_modules", limits: { maxEntries: 64, maxTotalBytes: 4096, maxManifestBytes: 16384, maxDurationMs: 10000 } });
      if (final.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST final capture failed");
      const generation = randomUUID(), base = { version: 1 as const, workspace, generation, coverageRevision: "c".repeat(64) };
      receipts.compareAndSwap(workspace, null, { ...base, revision: 1, state: DependencyReceiptState.Installing, operationId: generation, requestedKey: key.installKey,
        preservation: { kind: DependencyPreservationKind.KnownFreshAbsence, workspace, generation, coverageRevision: base.coverageRevision, operationId: generation, absenceEvidenceId: "TEST-only-shape" } });
      const proof = { workspace, generation, coverageRevision: base.coverageRevision, installKey: key.installKey, tree: final.tree, manifestDigest: final.digest };
      const ready: Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }> = { ...base, ...proof, state: DependencyReceiptState.Ready, revision: 2, treeMeasurement: final.measurement,
        provenance: { ...proof, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation, verificationEvidenceId: final.digest, installerDrainEvidenceId: "TEST-only-shape" } };
      receipts.compareAndSwap(workspace, 1, ready);
      const history = await readdir(receiptsPath), committed = receipts.getCommittedReady(workspace, 2);
      const copy: HostedDependencyColdHandoff = Object.freeze({ startId: attempt.launch.startId });
      expect(() => consumeHostedDependencyColdHandoff(copy, binding, attempt, inputs, ready)).toThrow(DependencyAdmissionError);
      try { consumeHostedDependencyColdHandoff(copy, binding, attempt, inputs, ready); throw new Error("TEST copied handle accepted"); }
      catch (error) { expect(error).toMatchObject({ reason: DependencyAdmissionFailure.StaleAttempt }); }
      closeHostedDependencyColdHandoff(copy);
      expect(receipts.getCommittedReady(workspace, 2)).toEqual(committed); expect(await readdir(receiptsPath)).toEqual(history);
      expect(await readFile(file)).toEqual(sentinel); expect(owners.read(workspace)?.owner).toMatchObject({ attempt });
    } finally { receipts.close(); owners.close(); await rm(root, { recursive: true, force: true }); }
  });
});
