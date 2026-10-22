import { captureHostedDependencyToolReadyReader } from "../hosted-dependency-tool-ready-reader";
import { registerMaterializationAttemptTest } from "./hosted-dependency-materialization-attempt-test-support";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import * as runtimeFactory from "../file-backend-codex-runtime-factory";
import { validAuthJson } from "./file-backend-codex-worker-test-support";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { claimDependencyConsumer, fenceDependencyConsumer, markDependencyConsumerRunning,
  claimDependencyMaintenance, isDependencyConsumerOwner, DependencyOwnerKind, DependencyInstallProofKind, DependencyPreservationKind, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyBindingName, hostedDependencyJobRoot, hostedDependencyOwnerRoot, parseHostedDependencyBinding } from "../hosted-dependency-workspace";
import * as dependencyWorkspace from "../hosted-dependency-workspace";
import { HostedDependencyReferenceKind } from "../hosted-dependency-workspace";
import { tryRunHostedLegacyReference } from "../hosted-dependency-legacy-reference";
import * as referenceRecords from "../hosted-dependency-legacy-reference-records";
import { CodexSessionHomeProfileKind } from "../codex-session-home-profile";
import type { CodexGoalRunConfig } from "../codex-goal-runner";
import { JobStorageHomeStateRequirement, JobStorageIntentKind } from "@vioxen/subscription-runtime/worker-core";
import { submitHostedOrdinaryProcess } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import { admitHostedDependencyConsumer, assertHostedDependencyExecutionWorkspace } from "../hosted-dependency-admission";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { runHostedRuntimeForeground } from "../hosted-readonly-foreground";
import type { EventEmitter } from "node:events";
import type { CodexAppServerChildProcess } from "../../provider-codex/app-server/application/app-server-process-port";
import { dependencyCoverageRevision, readHostedDependencyReceipt } from "../hosted-dependency-materialization";
import { publishHostedDependencyReceipt, hostedDependencyReceiptHistoryRoot } from "../hosted-dependency-receipts";
import { dependencyToolPins, DependencyToolProfileId, DependencyToolTransformCache } from "../../core/dependency-environment/dependency-tool-profile";
import { captureManagedDependencyGitContext, isLinkedGitWorktree } from "../managed-dependency-git";
import { readLocalGitHeadCommit } from "../codex-goal-git-revision";
import { withHandoffLiveIndexSnapshot, withHandoffWorktreeIndex } from "../codex-goal-handoff-worktree-index";

/** Uses the ordinary suite's real private FS and retained origin composition.
 * Synthetic kernel facts do not certify the production mount/capability fence. */
export function registerDependencyConsumerAdmissionTests(input: {
  fixture: { root: string; boot: string; manifestMountInfo: string; runtimeUnit: string; group: string; jobs: string; captureAncestry: boolean; captureDirectories: Map<number, string>; legacyGitReads: number; afterLegacyGitRead: (() => void) | undefined; spawn: Mock<(...args: unknown[]) => CodexAppServerChildProcess> };
  stageName: string; runtimeDirectory: string; local: (path: string) => string;
  put: (name: string, value: unknown) => void; read: (name: string) => any;
}): void {
  const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
  const jobId = "TEST-dependency-admission", jobRootDir = hostedDependencyJobRoot(jobId), workspacePath = jobRootDir + "/workspace";
  function prepared(mixedLegacy = false, routeArgs: readonly string[] = []) {
    for (const directory of [jobRootDir, workspacePath, workspacePath + "/.git", hostedDependencyOwnerRoot,
      "/var/lib/subscription-runtime-host-policy/dependency-bindings", "/var/lib/subscription-runtime-host-policy/dependency-attempt-fences",
      "/var/lib/subscription-runtime-host-policy/dependency-provider-attempts"]) mkdirSync(input.local(directory), { recursive: true, mode: 0o700 });
    writeFileSync(input.local(workspacePath + "/.git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n", { mode: 0o600 });
    writeFileSync(input.local(workspacePath + "/dirty-source"), "original dirty TEST bytes\n", { mode: 0o640 });
    const launch = { command: process.execPath, args: [join(input.runtimeDirectory, "dist/worker-codex/codex-goal-cli.js"), "run", "--task-id", jobId,
      "--job-root", jobRootDir, "--workspace", workspacePath, ...routeArgs], cwd: workspacePath };
    const creator = { creatorId: "TEST-dependency-creator", jobId, jobRootDir, workspacePath, launch };
    const legacy = { creatorId: "legacy-TEST-only-creator", jobId: "ordinary-job", jobRootDir: "/jobs/ordinary-job",
      workspacePath: "/jobs/ordinary-job/workspace", launch: { command: process.execPath,
        args: [join(input.runtimeDirectory, "dist/worker-codex/codex-goal-cli.js"), "run"], cwd: "/jobs/ordinary-job/workspace" } };
    input.put("readonly-inventory.json", { ...input.read("readonly-inventory.json"), ordinaryCreators: mixedLegacy ? [creator, legacy] : [creator], runtimeLaunch: launch });
    const grant = { schemaVersion: 1, jobId, jobRootDir, workspacePath, profileId: "codex-test-npm-qualification" };
    const store = new HostedInstallationActivationStore(), installed = store.install();
    input.put(`grants/${hash(jobId)}.json`, grant);
    store.enrollOrdinary(creator.creatorId);
    if (mixedLegacy) store.enrollOrdinary(legacy.creatorId);
    store.resumeOrdinary();
    const stat = lstatSync(input.local(workspacePath), { bigint: true });
    const binding = parseHostedDependencyBinding({ version: 1, jobId, jobRootDir,
      workspace: { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) },
      installationId: installed.installationId, runtimeSha: "a".repeat(40), grantDigest: hash(readFileSync(join(input.fixture.root, "grants", hash(jobId) + ".json"))) });
    input.put(hostedDependencyBindingName(jobId), binding);
    const retained = store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
    input.fixture.runtimeUnit = retained.reservation.unit;
    input.fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${retained.reservation.unit}`;
    return { binding, retained, host: store };
  }
  function running(p: ReturnType<typeof prepared>) {
    const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
    try {
      const attempt = claimDependencyConsumer(store, p.binding.workspace, { installationId: p.binding.installationId,
        bootId: p.retained.start.bootId, runtimeSha: p.binding.runtimeSha, grantDigest: p.binding.grantDigest,
        startId: p.retained.reservation.startId, unit: p.retained.reservation.unit }, randomUUID());
      markDependencyConsumerRunning(store, p.binding.workspace, attempt);
      return attempt;
    } finally { store.close(); }
  }
  const providerInput = () => ({ cwd: workspacePath, env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
    SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "codex-test-npm-qualification" } });
  function completedFixture(p: ReturnType<typeof prepared>) {
    const generation = randomUUID(), coverageRevision = dependencyCoverageRevision(p.binding);
    mkdirSync(input.local(workspacePath + "/node_modules"), { mode: 0o700 });
    writeFileSync(input.local(workspacePath + "/node_modules/original-TEST-file"), "original dependency TEST bytes\n", { mode: 0o640 });
    const stat = lstatSync(input.local(workspacePath + "/node_modules"), { bigint: true });
    const tree = { dev: String(stat.dev), ino: String(stat.ino) }, installKey = "a".repeat(64), manifestDigest = "c".repeat(64);
    const base = { version: 1 as const, generation, workspace: p.binding.workspace, coverageRevision };
    const intent = { ...base, revision: 1, state: DependencyReceiptState.Installing, operationId: generation, requestedKey: installKey,
      preservation: { kind: DependencyPreservationKind.KnownFreshAbsence, generation, workspace: p.binding.workspace,
        coverageRevision, operationId: generation, absenceEvidenceId: "b".repeat(64) } };
    const proof = { generation, workspace: p.binding.workspace, coverageRevision, installKey, tree, manifestDigest };
    const ready = { ...base, revision: 2, state: DependencyReceiptState.Ready as const, ...proof,
      provenance: { ...proof, kind: DependencyInstallProofKind.CompletedInstall as const, operationId: generation,
        verificationEvidenceId: "d".repeat(64), installerDrainEvidenceId: "e".repeat(64) } };
    const directory = `dependency-receipts/${p.binding.workspace.dev}-${p.binding.workspace.ino}`;
    mkdirSync(join(input.fixture.root, directory), { recursive: true, mode: 0o700 });
    input.put(directory + "/installing.json", intent); input.put(directory + "/ready.json", ready);
    return { ready, directory };
  }
  describe("private physical dependency consumer admission", () => {
    beforeEach(async () => {
      // Match the outer fixture's root-owned stat facts without changing the
      // production store's effective-UID check or touching host policy paths.
      vi.spyOn(process, "geteuid").mockReturnValue(0);
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      const fixtureRealpath = fs.realpathSync, fixtureReadFile = fs.readFileSync;
      const usesBufferEncoding = (value: unknown): boolean => value === "buffer";
      vi.spyOn(fs, "realpathSync").mockImplementation((path, options) => {
        if (typeof path !== "string") return fixtureRealpath(path, options);
        const physical = input.local(path);
        if (physical === path) return fixtureRealpath(path, options);
        if (real.realpathSync(physical) !== physical) throw new Error("noncanonical TEST fixture path");
        const encoding = typeof options === "string" ? options : options?.encoding;
        return usesBufferEncoding(encoding) ? Buffer.from(path) : path;
      });
      // The Git guard reads an already validated descriptor, not a path. Keep
      // real descriptor I/O while the outer fixture supplies finite /proc facts.
      vi.spyOn(fs, "readFileSync").mockImplementation((path, options) =>
        typeof path === "number" ? real.readFileSync(path, options) : fixtureReadFile(path, options));
    });
    registerMaterializationAttemptTest({ prepared, local: input.local, fixture: input.fixture });
    it.each(["missing-binding", "reference-v3", "foreign-identity", "stale-v1-runtime"])("optional tool reader refuses actual protected %s before default fallback", fault => {
      // Red if a missing protected binding, reference purpose or caller alias
      // can select the ordinary default factory without a current owner.
      const p = prepared(), name = hostedDependencyBindingName(jobId);
      if (fault === "missing-binding") fs.unlinkSync(input.local(`/var/lib/subscription-runtime-host-policy/${name}`));
      if (fault === "stale-v1-runtime") input.put(name,{...p.binding,runtimeSha:"b".repeat(40)});
      if (fault === "reference-v3") input.put(name,{...p.binding,version:3,reference:{
        kind:HostedDependencyReferenceKind.LegacyRegistryV1,operationId:randomUUID()}});
      expect(() => withHostedActivationFence(fence => captureHostedDependencyToolReadyReader(fence,{
        jobId,jobRootDir,workspacePath:fault === "foreign-identity" ? "/tmp/TEST-foreign-workspace" : workspacePath,
      }))).toThrow();
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath+"/dirty-source"),"utf8")).toBe("original dirty TEST bytes\n");
    });
    it.each(["unprepared-v2", "missing-binding", "reference-v3"])("actual protected %s rejects omitted helper context and aliases before generic IO/callback", async kind => {
      // Red on the old lexical dispatcher: a real protected C start plus an
      // outside-jobsRoot alias enters PATH Git or the generic index callback.
      const p = prepared();
      const files = Array.from({ length: 7 }, (_, index) => ({ path: `${jobRootDir}/TEST-readonly-${index}`, sha256: "a".repeat(64) }));
      const binding = parseHostedDependencyBinding({ ...p.binding, version: 2, toolProfile: {
        version: 1, profileId: DependencyToolProfileId.ViteVitestConfigFreeV1, pins: dependencyToolPins,
        cache: { ...p.binding.workspace, canonicalPath: `${jobRootDir}/tool-cache/${DependencyToolProfileId.ViteVitestConfigFreeV1}` },
        node: { path: `${jobRootDir}/TEST-node`, sha256: "b".repeat(64) }, helper: files[0], readonlyFiles: files,
        testFiles: ["source.test.ts"], optimizerDependencies: ["test-tool"], transformCache: DependencyToolTransformCache.Temporary,
      } });
      input.put(hostedDependencyBindingName(jobId), binding);
      if (kind === "missing-binding") fs.unlinkSync(input.local(`/var/lib/subscription-runtime-host-policy/${hostedDependencyBindingName(jobId)}`));
      if (kind === "reference-v3") input.put(hostedDependencyBindingName(jobId), parseHostedDependencyBinding({ ...p.binding, version: 3,
        reference: { kind: HostedDependencyReferenceKind.LegacyRegistryV1, operationId: randomUUID() } }));
      const authored = input.local(workspacePath + "/dirty-source"), before = readFileSync(authored);
      const alias = join(input.fixture.root, "TEST-workspace-alias"); fs.symlinkSync(input.local(workspacePath), alias);
      const initialize = vi.fn(async () => {}), operation = vi.fn(async () => "unexpected generic callback");
      expect(() => captureManagedDependencyGitContext(alias)).toThrow();
      await expect(isLinkedGitWorktree(alias)).rejects.toThrow();
      await expect(readLocalGitHeadCommit(alias)).rejects.toThrow();
      await expect(withHandoffWorktreeIndex({ initialize, operation })).rejects.toThrow();
      await expect(withHandoffLiveIndexSnapshot({ sourceIndexPath: authored, operation })).rejects.toThrow();
      expect(initialize).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
      expect(readFileSync(authored)).toEqual(before); expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
    });
    it("reference purpose denies generic entry before qualification, even with no requested workspace", async () => {
      // Regression: accepting the new binding without the mandatory generic
      // veto would call qualification/bootstrap before failing on later facts.
      // Keep the real private binding/files; this spy observes, never grants G1.
      const p=prepared(),binding=parseHostedDependencyBinding({...p.binding,version:3,
        reference:{kind:HostedDependencyReferenceKind.LegacyRegistryV1,operationId:randomUUID()}});
      input.put(hostedDependencyBindingName(jobId),binding);
      const qualification=vi.spyOn(dependencyWorkspace,"assertHostedDependencyQualifiedInventory");
      const original=readFileSync(input.local(workspacePath+"/dirty-source"));
      await expect(admitHostedDependencyConsumer({taskId:jobId,jobId,jobRootDir,workspacePath,
        authRootDir:jobRootDir+"/auth",promptPath:jobRootDir+"/prompt.md",accounts:[]})).rejects.toThrow();
      expect(()=>assertHostedDependencyExecutionWorkspace(undefined)).toThrow();
      expect(()=>assertHostedDependencyExecutionWorkspace("/unselected-TEST-workspace")).toThrow();
      expect(qualification).not.toHaveBeenCalled();
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath+"/dirty-source"))).toEqual(original);
    });
    it("a reference purpose with missing protected relation never falls back to a normal CLI entry", async () => {
      // A parser/purpose label or the genuine ordinary start alone cannot
      // authorize a reference install. Missing relation must reject before
      // any consumer claim, dependency read or submission, not return undefined.
      const p=prepared(),binding=parseHostedDependencyBinding({...p.binding,version:3,
        reference:{kind:HostedDependencyReferenceKind.LegacyRegistryV1,operationId:randomUUID()}});
      input.put(hostedDependencyBindingName(jobId),binding);
      await expect(tryRunHostedLegacyReference({taskId:jobId,jobId,jobRootDir,workspacePath,
        authRootDir:jobRootDir+"/auth",promptPath:jobRootDir+"/prompt.md",accounts:[]})).rejects.toThrow();
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(input.local(workspacePath+"/node_modules"))).toBe(false);
      expect(readFileSync(input.local(workspacePath+"/dirty-source"),"utf8")).toBe("original dirty TEST bytes\n");
    });
    const unsupportedReferencePolicies: readonly Partial<Pick<CodexGoalRunConfig, "storage" | "sessionHomeProfile">>[] = [
      { storage: { generationId: randomUUID(), intent: { kind: JobStorageIntentKind.NoResume,
        homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } } },
      { sessionHomeProfile: { kind: CodexSessionHomeProfileKind.OneShot } },
      { sessionHomeProfile: { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "TEST-reference-session" } },
    ];
    it.each(unsupportedReferencePolicies)("reference purpose refuses explicit NEW policy %j before relation or owner effects", async policy => {
      // Old entry ignores the policy and reaches this real relation reader;
      // missing evidence then produces ENOENT. No fixture grants a relation.
      const p=prepared(),binding=parseHostedDependencyBinding({...p.binding,version:3,
        reference:{kind:HostedDependencyReferenceKind.LegacyRegistryV1,operationId:randomUUID()}});
      input.put(hostedDependencyBindingName(jobId),binding);
      const relation=vi.spyOn(referenceRecords,"readReferenceRelation");
      const before=readFileSync(input.local(workspacePath+"/dirty-source"));
      await expect(tryRunHostedLegacyReference({taskId:jobId,jobId,jobRootDir,workspacePath,
        authRootDir:jobRootDir+"/auth",promptPath:jobRootDir+"/prompt.md",accounts:[],...policy}))
        .rejects.toThrow(/^dependency_legacy_reference_unresolved$/);
      expect(relation).not.toHaveBeenCalled();
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(input.local(workspacePath+"/node_modules"))).toBe(false);
      expect(readFileSync(input.local(workspacePath+"/dirty-source"))).toEqual(before);
    });
    it("active legacy v1 cannot admit a provider but its exact release fence remains available", () => {
      // A new parser must not reinterpret an old Running owner as new authority.
      const p = prepared(), attempt = running(p);
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).not.toThrow();
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try {
        const current = store.read(p.binding.workspace);
        if (!current || !isDependencyConsumerOwner(current.owner)) throw new Error("missing TEST consumer");
        const path = input.local(`${hostedDependencyOwnerRoot}/${p.binding.workspace.dev}-${p.binding.workspace.ino}.json`);
        const legacy = { version: 1, workspace: current.workspace, revision: current.revision, epoch: current.epoch,
          owner: { phase: current.owner.phase, attempt: current.owner.attempt } };
        writeFileSync(path, JSON.stringify(legacy) + "\n", { mode: 0o600 });
        expect(store.read(p.binding.workspace)).toEqual(legacy);
        const bytes = readFileSync(path), submit = vi.fn();
        expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).toThrow();
        expect(() => submitHostedOrdinaryProcess(providerInput(), submit)).toThrow();
        expect(submit).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(bytes);
        fenceDependencyConsumer(store, p.binding.workspace, attempt);
        expect(store.read(p.binding.workspace)?.version).toBe(1);
        expect(store.read(p.binding.workspace)?.owner?.phase).toBe("fenced");
      } finally { store.close(); }
    });
    it("protected maintenance ownership cannot mint provider or executor permission", () => {
      const p = prepared(); input.fixture.group = "/system.slice/trusted.service";
      const actual = withHostedActivationFence(fence => p.host.dependencyMaintenanceAuthority(fence, jobId));
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try {
        claimDependencyMaintenance(store, p.binding.workspace, { installationId: actual.installation.installationId,
          bootId: actual.session.bootId, runtimeSha: actual.installation.runtimeSha, inventoryDigest: actual.installation.inventorySha256,
          grantDigest: p.binding.grantDigest, supervisorId: actual.session.supervisorId }, randomUUID());
      } finally { store.close(); }
      const path = input.local(`${hostedDependencyOwnerRoot}/${p.binding.workspace.dev}-${p.binding.workspace.ino}.json`), before = readFileSync(path);
      input.fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${p.retained.reservation.unit}`;
      const submit = vi.fn();
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).toThrow();
      expect(() => submitHostedOrdinaryProcess(providerInput(), submit)).toThrow();
      expect(submit).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
    });
    it("default-off host eviction policy preserves source and creates no owner or child", async () => {
      const p = prepared(); input.fixture.group = "/system.slice/trusted.service";
      await expect(p.host.evictDependencyCandidate({ jobId, generation: randomUUID(), revision: 2, installKey: "a".repeat(64) }))
        .resolves.toEqual({ outcome: "skipped" });
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
    });
    it("enabled eviction rejects a stale candidate before ownership or tree effects", async () => {
      // Removing the candidate comparison would claim Maintenance and try a
      // destructive transaction against a different current generation.
      const p = prepared(), completed = completedFixture(p);
      readHostedDependencyReceipt(p.binding);
      const originalPath = join(input.fixture.root, completed.directory, "ready.json"), original = readFileSync(originalPath);
      input.put("dependency-retention-policy.json", { version: 1, managedReadyRequired: true, evictionEnabled: true });
      input.fixture.group = "/system.slice/trusted.service";
      await expect(p.host.evictDependencyCandidate({ jobId, generation: completed.ready.generation,
        revision: completed.ready.revision + 1, installKey: completed.ready.installKey })).rejects.toThrow("dependency_transaction_unresolved");
      expect(readHostedDependencyReceipt(p.binding)).toEqual(completed.ready);
      expect(readFileSync(originalPath)).toEqual(original);
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(readFileSync(input.local(workspacePath + "/node_modules/original-TEST-file"), "utf8")).toBe("original dependency TEST bytes\n");
      expect(input.fixture.spawn).not.toHaveBeenCalled();
    });
    it("authenticated Absent with an unexpected existing tree refuses before ownership or install", async () => {
      // A committed absence is not permission to overwrite a newly present
      // tree. This exercises real history transitions and the final entry.
      const p = prepared(), completed = completedFixture(p), ready = completed.ready, operationId = randomUUID();
      readHostedDependencyReceipt(p.binding);
      const parent = lstatSync(input.fixture.root, { bigint: true });
      const trash = { operationId, originalTree: ready.tree,
        destinationParent: { canonicalPath: "/var/lib/subscription-runtime-host-policy/dependency-trash", dev: String(parent.dev), ino: String(parent.ino) },
        destinationName: `dependency-${operationId}` };
      publishHostedDependencyReceipt(p.binding, 2, { version: 1, state: DependencyReceiptState.Evicting, revision: 3,
        generation: ready.generation, workspace: ready.workspace, coverageRevision: ready.coverageRevision,
        operationId, installKey: ready.installKey, tree: ready.tree, manifestDigest: ready.manifestDigest, trash });
      const absent = publishHostedDependencyReceipt(p.binding, 3, { version: 1, state: DependencyReceiptState.Absent, revision: 4,
        generation: ready.generation, workspace: ready.workspace, coverageRevision: ready.coverageRevision, operationId, installKey: ready.installKey,
        evictionCommit: { generation: ready.generation, workspace: ready.workspace, coverageRevision: ready.coverageRevision,
          operationId, installKey: ready.installKey, tree: ready.tree, manifestDigest: ready.manifestDigest, trash, commitEvidenceId: "f".repeat(64) } });
      const files = readdirSync(input.local(hostedDependencyReceiptHistoryRoot)).sort();
      const before = files.map(name => readFileSync(input.local(hostedDependencyReceiptHistoryRoot + "/" + name)));
      await expect(admitHostedDependencyConsumer({ jobId, taskId: jobId, jobRootDir, workspacePath } as Parameters<typeof admitHostedDependencyConsumer>[0]))
        .rejects.toThrow("dependency_admission:unsafe_tree");
      expect(readHostedDependencyReceipt(p.binding)).toEqual(absent);
      expect(files.map(name => readFileSync(input.local(hostedDependencyReceiptHistoryRoot + "/" + name)))).toEqual(before);
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(readFileSync(input.local(workspacePath + "/node_modules/original-TEST-file"), "utf8")).toBe("original dependency TEST bytes\n");
      expect(input.fixture.spawn).not.toHaveBeenCalled();
    });
    it.skipIf(process.platform !== "linux")("normal original entry rejects the actual retained historical CLI while committed Absent, before child or output effects", async () => {
      // Authentic public9c package/719 compiler CLI, retained as generated DATA.
      // OS/profile ports are projected here: real schema2 store rejects the
      // recipe; native H1 separately observes the earlier schema4 request gate.
      const historical=gunzipSync(Buffer.from("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","base64"),{maxOutputLength:28066});
      expect(historical.length).toBe(28065);expect(hash(historical)).toBe("9d99f8b351817328c721d4d0618017bafe02777374e4cb2d28bb763f3628ee4f");
      const outputPath=jobRootDir+"/state/TEST-result.json";const p=prepared(false,["--output",outputPath]),completed=completedFixture(p),ready=completed.ready,operationId=randomUUID();
      readHostedDependencyReceipt(p.binding);const parent=lstatSync(input.fixture.root,{bigint:true});
      const trash={operationId,originalTree:ready.tree,destinationParent:{canonicalPath:"/var/lib/subscription-runtime-host-policy/dependency-trash",dev:String(parent.dev),ino:String(parent.ino)},destinationName:`dependency-${operationId}`};
      publishHostedDependencyReceipt(p.binding,2,{version:1,state:DependencyReceiptState.Evicting,revision:3,generation:ready.generation,workspace:ready.workspace,coverageRevision:ready.coverageRevision,operationId,installKey:ready.installKey,tree:ready.tree,manifestDigest:ready.manifestDigest,trash});
      const absent=publishHostedDependencyReceipt(p.binding,3,{version:1,state:DependencyReceiptState.Absent,revision:4,generation:ready.generation,workspace:ready.workspace,coverageRevision:ready.coverageRevision,operationId,installKey:ready.installKey,evictionCommit:{generation:ready.generation,workspace:ready.workspace,coverageRevision:ready.coverageRevision,operationId,installKey:ready.installKey,tree:ready.tree,manifestDigest:ready.manifestDigest,trash,commitEvidenceId:"f".repeat(64)}});
      const retained=join(input.fixture.root,"historical-cli-DATA.js");writeFileSync(retained,historical,{mode:0o644,flag:"wx"});
      // Model coherent absent physical placement with a REAL same-inode rename;
      // this case does not claim native maintenance/provenance or trash removal.
      const real=await vi.importActual<typeof import("node:fs")>("node:fs"),moved=join(input.fixture.root,"historical-absence-trash");
      real.renameSync(input.local(workspacePath+"/node_modules"),moved);
      input.fixture.group="/system.slice/trusted.service";
      const launch=input.read("readonly-inventory.json").ordinaryCreators[0].launch;
      const activation=readFileSync(join(input.fixture.root,"host-activation.json")),inventory=readFileSync(join(input.fixture.root,"readonly-inventory.json"));
      const receiptNames=readdirSync(input.local(hostedDependencyReceiptHistoryRoot)).sort(),receipts=receiptNames.map(name=>readFileSync(input.local(hostedDependencyReceiptHistoryRoot+"/"+name)));
      const priorSpawn=input.fixture.spawn.mock.calls.length;
      const output=input.local(outputPath);mkdirSync(input.local(jobRootDir+"/state"),{recursive:true,mode:0o700});writeFileSync(output,"completed TEST result remains original\n",{mode:0o600});const priorOutput=real.statSync(output),outputBytes=real.readFileSync(output);
      const opened=vi.spyOn(fs,"openSync");
      await expect(runHostedRuntimeForeground(launch.command,[retained,...launch.args.slice(1)],launch.cwd,{})).rejects.toThrow("hosted_activation_evidence_invalid");
      expect(input.fixture.spawn.mock.calls.length).toBe(priorSpawn);expect(opened.mock.calls.some(call=>[output,outputPath].includes(String(call[0])))).toBe(false);
      expect(readFileSync(join(input.fixture.root,"host-activation.json"))).toEqual(activation);expect(readFileSync(join(input.fixture.root,"readonly-inventory.json"))).toEqual(inventory);
      expect(readHostedDependencyReceipt(p.binding)).toEqual(absent);expect(readdirSync(input.local(hostedDependencyReceiptHistoryRoot)).sort()).toEqual(receiptNames);
      expect(receiptNames.map(name=>readFileSync(input.local(hostedDependencyReceiptHistoryRoot+"/"+name)))).toEqual(receipts);expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(real.existsSync(input.local(workspacePath+"/node_modules"))).toBe(false);expect(real.statSync(moved).ino).toBe(Number(ready.tree.ino));
      expect(real.readFileSync(join(moved,"original-TEST-file"),"utf8")).toBe("original dependency TEST bytes\n");expect(real.readFileSync(output)).toEqual(outputBytes);expect(real.statSync(output).ino).toBe(priorOutput.ino);
      expect(real.readFileSync(retained)).toEqual(historical);expect(readFileSync(input.local(workspacePath+"/dirty-source"),"utf8")).toBe("original dirty TEST bytes\n");
    });
    it("mixed legacy privileged creators remain unsupported before actual runtime reservation", () => {
      expect(() => prepared(true)).toThrow("dependency_admission:unsupported");
      expect(input.read("host-activation.json").ordinaryStarts).toHaveLength(0);
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
    });
    it.each([
      ["--hosted-lifecycle", "start"], ["--hosted-lifecycle=continue"],
      ["--lifecycle-job-id", jobId], ["--lifecycle-confirmed"], ["--lifecycle-skip-doctor"],
      ["--lifecycle-force-start"], ["--lifecycle-stale-after-ms=1"], ["--registry-root", "/foreign-TEST-registry"],
    ])("inventoried alternate route %j refuses before runtime, owner or provider effects", (...routeArgs) => {
      // A valid cold installation + grant/binding cannot authorize a pinned CLI
      // branch which performs lifecycle/registry work before dependency entry.
      expect(() => prepared(false, routeArgs)).toThrow("dependency_admission:unsupported");
      expect(input.read("host-activation.json").ordinaryStarts).toHaveLength(0);
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
    });
    it("genuine run with its exact private registry remains admissible", () => {
      const p = prepared(false, ["--registry-root", jobRootDir + "/state/registry"]);
      running(p);
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).not.toThrow();
      const submit = vi.fn(() => input.fixture.spawn());
      submitHostedOrdinaryProcess(providerInput(), submit);
      expect(submit).toHaveBeenCalledOnce();
    });
    it.each([
      ["NODE_OPTIONS", "--import=" + workspacePath + "/payload.mjs"],
      ["NODE_PATH", workspacePath], ["LD_PRELOAD", workspacePath + "/payload.so"],
      ["GIT_CONFIG_COUNT", "1"], ["SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "/foreign-TEST-registry"],
      ["CODEX_GOAL_REGISTRY_ROOT", "/foreign-TEST-registry"],
    ])("opted %s injection refuses before host child submission or new ownership", async (key, value) => {
      // A loader could execute before the goal gate. This observes the real
      // submit seam: installed records stay identical and no child is spawned.
      prepared(); input.fixture.group = "/system.slice/trusted.service";
      const before = readFileSync(join(input.fixture.root, "host-activation.json"));
      const launch = input.read("readonly-inventory.json").ordinaryCreators[0].launch;
      await expect(runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, { [key]: value }))
        .rejects.toThrow("dependency_host_environment_unsupported");
      expect(readFileSync(join(input.fixture.root, "host-activation.json"))).toEqual(before);
      expect(readdirSync(input.local(hostedDependencyOwnerRoot))).toEqual([]);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
    });
    it("corrupt or unrelated durable intent vetoes an otherwise valid Ready record without writes", () => {
      const p = prepared(), generation = randomUUID(), coverageRevision = dependencyCoverageRevision(p.binding);
      const base = { version: 1, revision: 1, generation, workspace: p.binding.workspace, coverageRevision };
      const requestedKey = "a".repeat(64), tree = { dev: p.binding.workspace.dev, ino: "987654321" };
      const intent = { ...base, state: DependencyReceiptState.Installing, operationId: generation, requestedKey,
        preservation: { kind: DependencyPreservationKind.KnownFreshAbsence, generation, workspace: p.binding.workspace,
          coverageRevision, operationId: generation, absenceEvidenceId: "b".repeat(64) } };
      const proof = { generation, workspace: p.binding.workspace, coverageRevision, installKey: requestedKey, tree, manifestDigest: "c".repeat(64) };
      const ready = { ...base, revision: 2, state: DependencyReceiptState.Ready, ...proof,
        provenance: { ...proof, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation,
          verificationEvidenceId: "d".repeat(64), installerDrainEvidenceId: "e".repeat(64) } };
      const directory = `dependency-receipts/${p.binding.workspace.dev}-${p.binding.workspace.ino}`;
      mkdirSync(join(input.fixture.root, directory), { recursive: true, mode: 0o700 });
      input.put(directory + "/installing.json", intent); input.put(directory + "/ready.json", ready);
      expect(readHostedDependencyReceipt(p.binding)?.state).toBe(DependencyReceiptState.Ready);
      const before = readFileSync(join(input.fixture.root, directory, "ready.json"));
      for (const corrupt of [{ nonsense: true }, { ...intent, requestedKey: "f".repeat(64) }, { ...intent, generation: randomUUID() }]) {
        input.put(directory + "/installing.json", corrupt);
        expect(() => readHostedDependencyReceipt(p.binding)).toThrow();
        expect(readFileSync(join(input.fixture.root, directory, "ready.json"))).toEqual(before);
      }
      input.put(directory + "/installing.json", intent);
      const history = input.local(`/var/lib/subscription-runtime-host-policy/dependency-receipt-history/${p.binding.workspace.dev}-${p.binding.workspace.ino}.lock`);
      writeFileSync(history, "retained uncertain TEST publisher\n", { mode: 0o600 });
      expect(() => readHostedDependencyReceipt(p.binding)).toThrow();
      expect(readFileSync(history, "utf8")).toBe("retained uncertain TEST publisher\n");
      expect(readFileSync(join(input.fixture.root, directory, "ready.json"))).toEqual(before);
      expect(input.fixture.spawn).not.toHaveBeenCalled();
    });
    it("successful job result survives unresolved dependency cleanup and retains fenced owner", async () => {
      // A genuine late drain failure makes this red if cleanup changes code 0
      // into runtime failure. Completion and owner are actual persisted records.
      const p = prepared();
      // Return to the inventoried host dispatcher for its real foreground run.
      input.fixture.group = "/system.slice/trusted.service";
      const inventoried = input.read("readonly-inventory.json").ordinaryCreators[0].launch;
      const result = runHostedRuntimeForeground(inventoried.command, inventoried.args, inventoried.cwd, {});
      const latest = input.read("host-activation.json").ordinaryStarts.at(-1);
      const start = input.read(`ordinary-starts/${latest.startId}.json`);
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      let attempt;
      try {
        attempt = claimDependencyConsumer(store, p.binding.workspace, { installationId: p.binding.installationId,
          bootId: start.bootId, runtimeSha: p.binding.runtimeSha, grantDigest: p.binding.grantDigest,
          startId: latest.startId, unit: latest.unit }, randomUUID());
        markDependencyConsumerRunning(store, p.binding.workspace, attempt);
      } finally { store.close(); }
      // An actual queued start for this exact retained unit prevents release
      // after the successful wait; unrelated units are not used as a fault.
      input.fixture.jobs = `9 ${latest.unit} start waiting\n`;
      const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      // Pin the actual completion record immediately after publication, before
      // the failing cleanup coordinator runs. This proves completion/status
      // retention only; FDA/summary/log authenticity belongs to the native case.
      const complete = HostedInstallationActivationStore.prototype.recordOrdinaryRuntimeWaitCompletion;
      let completed: { path: string; bytes: Buffer; stat: fs.BigIntStats } | undefined;
      vi.spyOn(HostedInstallationActivationStore.prototype, "recordOrdinaryRuntimeWaitCompletion").mockImplementation(function (this: HostedInstallationActivationStore) {
        complete.call(this);
        const path = join(input.fixture.root, `ordinary-completed/${latest.startId}.json`);
        completed = { path, bytes: readFileSync(path), stat: lstatSync(path, { bigint: true }) };
      });
      const child = input.fixture.spawn.mock.results.at(-1)!.value as EventEmitter;
      child.emit("exit", 0, null);
      await expect(result).resolves.toBe(0);
      expect(warning).toHaveBeenCalledWith("dependency_cleanup_unresolved\n");
      expect(completed).toBeDefined();
      const saved = completed!;
      const now = lstatSync(saved.path, { bigint: true });
      expect(readFileSync(saved.path)).toEqual(saved.bytes);
      expect([now.dev, now.ino, now.mode]).toEqual([saved.stat.dev, saved.stat.ino, saved.stat.mode]);
      const retained = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try { expect(retained.read(p.binding.workspace)?.owner?.phase).toBe("fenced"); } finally { retained.close(); }
      expect(input.read(`ordinary-completed/${latest.startId}.json`).waitStatus).toBe(0);
      expect(input.read("host-activation.json").phase).toBe("ORDINARY");
      expect(input.read("host-activation.json").ordinaryStarts.find((row: { startId: string }) => row.startId === p.retained.reservation.startId).state).toBe("reserved");
    });
    it("missing dependencies refuse before ownership, provider submission and direct executor reads", async () => {
      const p = prepared(), submit = vi.fn();
      await expect(admitHostedDependencyConsumer({ jobId, taskId: jobId, jobRootDir, workspacePath } as Parameters<typeof admitHostedDependencyConsumer>[0]))
        .rejects.toThrow("dependency_admission:needs_install");
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try { expect(store.read(p.binding.workspace)).toBeNull(); } finally { store.close(); }
      expect(() => submitHostedOrdinaryProcess(providerInput(), submit)).toThrow();
      expect(() => new FileBackendCodexSafeExecutor({ workspacePath, stateRootDir: join(input.fixture.root, "never-created"), accounts: [] })).toThrow();
      expect(submit).not.toHaveBeenCalled(); expect(input.fixture.spawn).not.toHaveBeenCalled();
      expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
    });
    it("actual retained grant admits once; fenced owner prevents stale enqueue while originals remain", () => {
      const p = prepared(), attempt = running(p);
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).not.toThrow();
      const submit = vi.fn(() => input.fixture.spawn());
      submitHostedOrdinaryProcess(providerInput(), submit);
      expect(submit).toHaveBeenCalledOnce();
      const startsBefore = input.read("host-activation.json").ordinaryStarts.length;
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try { fenceDependencyConsumer(store, p.binding.workspace, attempt); } finally { store.close(); }
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).toThrow();
      expect(() => submitHostedOrdinaryProcess(providerInput(), submit)).toThrow();
      expect(submit).toHaveBeenCalledOnce(); expect(input.read("host-activation.json").ordinaryStarts).toHaveLength(startsBefore);
      expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
    });
    it("fenced owner after durable recovery reads denies private callback before session reread or runtime effects", async () => {
      const p = prepared(), attempt = running(p), providerInstanceId = "codex:TEST-managed-recovery";
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).not.toThrow();
      const captured: runtimeFactory.FileBackendCodexWorkerRuntimeParts[] = [];
      const createRuntime = runtimeFactory.createFileBackendCodexWorkerRuntime;
      vi.spyOn(runtimeFactory, "createFileBackendCodexWorkerRuntime").mockImplementation(args => {
        const parts = createRuntime(args); captured.push(parts); return parts;
      });
      const worker = new FileBackendCodexWorker({ providerInstanceId,
        stateRootDir: join(input.fixture.root, "recovery-state"), workspacePath,
        codexBinaryPath: "codex", encryptionKey: new Uint8Array(32).fill(17),
        executionEngine: "app-server-goal", sourceEnv: {},
      });
      const parts = captured[0]; if (!parts) throw new Error("actual worker runtime missing");
      const runId = "TEST-recovery-admission", requestId = "TEST-recovery-request";
      const resumeHandle = { runId, providerId: "codex", providerInstanceId, workerId: worker.workerId, workspacePath };
      await parts.sessionStore.write({ providerInstanceId, expectedGeneration: 0,
        nextArtifact: sessionArtifactFromCodexAuthJson(validAuthJson),
        idempotencyKey: "TEST-recovery-session", leaseId: "TEST-recovery-seed" });
      await parts.managedRunStore.saveWaitingInput({ runId,
        request: { id: requestId, kind: "missing_context", question: "TEST context?", audience: "orchestrator" },
        resumeHandle, recoveryPacket: { originalPrompt: "TEST recover", lastOutput: "TEST waiting", blockerQuestion: "TEST context?" },
        now: new Date("2026-10-07T00:00:00.000Z") });
      expect(await parts.sessionStore.read({ providerInstanceId, expectedProviderId: "codex", purpose: "run" })).not.toBeNull();
      let allowRecord!: () => void, recordRead!: () => void;
      const recordGate = new Promise<void>(resolve => { allowRecord = resolve; });
      const enteredRecord = new Promise<void>(resolve => { recordRead = resolve; });
      const get = parts.managedRunStore.get.bind(parts.managedRunStore);
      const recordReads = vi.spyOn(parts.managedRunStore, "get").mockImplementationOnce(async args => {
        const record = await get(args); recordRead(); await recordGate; return record;
      });
      let allowSession!: () => void, sessionRead!: () => void;
      const sessionGate = new Promise<void>(resolve => { allowSession = resolve; });
      const enteredSession = new Promise<void>(resolve => { sessionRead = resolve; });
      const read = parts.sessionStore.read.bind(parts.sessionStore);
      const reads = vi.spyOn(parts.sessionStore, "read").mockImplementation(async args => {
        const session = await read(args);
        if (args.purpose === "run") { sessionRead(); await sessionGate; }
        return session;
      });
      // Fail closed if the old callback crosses either effect seam. Neither
      // sentinel grants admission; the real retained owner is checked below.
      const refresh = vi.spyOn(parts.runtime, "refreshThenRunTask").mockRejectedValue(new Error("unexpected recovery runtime effect"));
      const workspace = vi.spyOn(parts.workspace, "create").mockRejectedValue(new Error("unexpected recovery workspace effect"));
      try {
        await worker.start();
        const resumed = worker.resumeManagedRun({ runId, requestId, answer: "TEST answer", resumeHandle });
        const refused = expect(resumed).rejects.toThrow(/^dependency_admission:unsupported$/);
        await enteredRecord;
        expect(recordReads).toHaveBeenCalledOnce(); expect(reads).not.toHaveBeenCalled();
        allowRecord(); await enteredSession;
        // Both real reads settled while the same selected start was admitted.
        expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).not.toThrow();
        const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
        try {
          expect(store.read(p.binding.workspace)?.owner).toEqual({ kind: DependencyOwnerKind.Consumer, phase: "running", attempt });
          fenceDependencyConsumer(store, p.binding.workspace, attempt);
          const fenced = store.read(p.binding.workspace);
          expect(fenced?.workspace).toEqual(p.binding.workspace);
          expect(fenced?.owner).toEqual({ kind: DependencyOwnerKind.Consumer, phase: "fenced", attempt });
        } finally { store.close(); }
        allowSession(); await refused;
        expect(reads.mock.calls.map(([args]) => args.purpose)).toEqual(["run"]);
        expect(refresh).not.toHaveBeenCalled(); expect(workspace).not.toHaveBeenCalled();
        expect(input.fixture.spawn).not.toHaveBeenCalled();
        expect(readFileSync(input.local(workspacePath + "/dirty-source"), "utf8")).toBe("original dirty TEST bytes\n");
        const retained = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
        try { expect(retained.read(p.binding.workspace)?.owner).toEqual({ kind: DependencyOwnerKind.Consumer, phase: "fenced", attempt }); } finally { retained.close(); }
      } finally { allowRecord(); allowSession(); await worker.dispose(); }
    });
    it("profile environment cannot borrow the trusted sibling's workspace", () => {
      const p = prepared(); running(p);
      input.fixture.group = "/system.slice/uncontrolled-TEST-reader.service";
      const submit = vi.fn();
      expect(() => assertHostedDependencyExecutionWorkspace(workspacePath)).toThrow();
      expect(() => submitHostedOrdinaryProcess(providerInput(), submit)).toThrow();
      expect(submit).not.toHaveBeenCalled(); expect(input.fixture.spawn).not.toHaveBeenCalled();
    });
  });
}
