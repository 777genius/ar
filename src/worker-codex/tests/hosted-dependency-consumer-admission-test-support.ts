import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import * as runtimeFactory from "../file-backend-codex-runtime-factory";
import { validAuthJson } from "./file-backend-codex-worker-test-support";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { claimDependencyConsumer, fenceDependencyConsumer, markDependencyConsumerRunning,
  claimDependencyMaintenance, isDependencyConsumerOwner, DependencyOwnerKind, DependencyInstallProofKind, DependencyPreservationKind, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyBindingName, hostedDependencyJobRoot, hostedDependencyOwnerRoot, parseHostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { submitHostedOrdinaryProcess } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import { admitHostedDependencyConsumer, assertHostedDependencyExecutionWorkspace } from "../hosted-dependency-admission";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { runHostedRuntimeForeground } from "../hosted-readonly-foreground";
import type { EventEmitter } from "node:events";
import type { CodexAppServerChildProcess } from "../../provider-codex/app-server/application/app-server-process-port";
import { dependencyCoverageRevision, readHostedDependencyReceipt } from "../hosted-dependency-materialization";
import { publishHostedDependencyReceipt, hostedDependencyReceiptHistoryRoot } from "../hosted-dependency-receipts";

/** Uses the ordinary suite's real private FS and retained origin composition.
 * Synthetic kernel facts do not certify the production mount/capability fence. */
export function registerDependencyConsumerAdmissionTests(input: {
  fixture: { root: string; runtimeUnit: string; group: string; jobs: string; spawn: Mock<(...args: unknown[]) => CodexAppServerChildProcess> };
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
    input.put(`grants/${hash(jobId)}.json`, grant);
    const store = new HostedInstallationActivationStore(), installed = store.install();
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
      const child = input.fixture.spawn.mock.results.at(-1)!.value as EventEmitter;
      child.emit("exit", 0, null);
      await expect(result).resolves.toBe(0);
      expect(warning).toHaveBeenCalledWith("dependency_cleanup_unresolved\n");
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
