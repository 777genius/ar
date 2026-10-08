import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStorageHomeStateRequirement, JobStorageIntentKind } from "@vioxen/subscription-runtime/worker-core";
import { codexProviderApiEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { buildCodexGoalExecutorOptions, runCodexGoal, type CodexGoalRunConfig } from "../codex-goal-runner";
import { CodexSessionHomeProfileKind, type CodexSessionHomeProfile } from "../codex-session-home-profile";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { FakeAppServerFactory, StaticRunner, codexAuthJson } from "./file-backend-codex-worker-test-support";
import { snapshotCodexGoalStorageConfig } from "../job-storage/codex-goal-storage-admission";

describe("ordinary goal storage boundary", () => {
  it("snapshots NEW nested account and permission inputs before asynchronous admission", () => {
    const accounts = [{ name: "admitted-account", authJsonPath: "/TEST/admitted-auth" }], readRoots = ["/TEST/admitted-root"];
    const original = { ...goalConfig("/TEST/job", { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "test-session" }), accounts,
      projectAccessScope: { projectId: "test-storage", readRoots }, storage: { generationId: "generation-1",
        intent: { kind: JobStorageIntentKind.Continuation as const, sessionId: "test-session" } } };
    const snapshot = snapshotCodexGoalStorageConfig(original);
    accounts[0]!.name = "unadmitted-account";
    accounts[0]!.authJsonPath = "/TEST/unadmitted-auth";
    readRoots.push("/TEST/unadmitted-root");
    expect(snapshot.accounts[0]).toEqual({ name: "admitted-account", authJsonPath: "/TEST/admitted-auth" });
    expect(snapshot.projectAccessScope?.readRoots).toEqual(["/TEST/admitted-root"]);
  });
  it.each([undefined, { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "stable-test-session" }] as const)(
    "retains actual cache bytes and scrubs auth across executor disposal for %j", async profile => {
      const root = await mkdtemp(join(tmpdir(), "test-a1-profile-")), server = new FakeAppServerFactory();
      const config = goalConfig(root, profile);
      await mkdir(config.workspacePath, { recursive: true });
      await mkdir(join(config.authRootDir, "synthetic"), { recursive: true });
      await writeFile(join(config.authRootDir, "synthetic", "auth.json"), codexAuthJson("synthetic-storage-profile"));
      let executorOrdinal = 0;
      const makeExecutor = () => {
        // Real runner builder -> safe executor -> worker -> materializer. Only
        // the model process is synthetic; this does not assert native admission.
        const options = buildCodexGoalExecutorOptions({ config, stateRootDir: join(root, "state"), encryptionKey: new Uint8Array(32).fill(7) });
        executorOrdinal += 1;
        return new FileBackendCodexSafeExecutor({ ...options,
          executorId: profile ? `continuation-test-executor-${executorOrdinal}` : "stable-legacy-test-executor", requireGitWorkspace: false,
          accounts: options.accounts.map(account => ({ codexAuthJson: codexAuthJson("synthetic-storage-profile"),
            worker: { ...account.worker, appServerProcessFactory: server.create, runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }) } })) });
      };
      let executor: FileBackendCodexSafeExecutor | undefined;
      try {
        executor = makeExecutor();
        await executor.run({ taskId: "test-a1", prompt: "Return synthetic completion", controls: { editMode: "allow-edits" } });
        const firstHome = server.codexHomes[0]!;
        await writeFile(join(firstHome, "retained-source-marker"), "unique bytes");
        await executor.dispose();
        await expect(access(join(firstHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
        executor = makeExecutor();
        await executor.run({ taskId: "test-a1", prompt: "Return synthetic completion", controls: { editMode: "allow-edits" } });
        expect(server.codexHomes.at(-1)).toBe(firstHome);
        expect(await readFile(join(server.codexHomes.at(-1)!, "retained-source-marker"), "utf8")).toBe("unique bytes");
      } finally { await executor?.dispose(); await rm(root, { recursive: true, force: true }); }
    });

  it("rejects NEW continuation without native lifetime authority before egress, files or executor", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-a1-no-authority-"));
    try {
      const config = { ...goalConfig(root, { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "stable-test-session" }),
        storage: { generationId: "generation-1", intent: { kind: JobStorageIntentKind.Continuation as const, sessionId: "stable-test-session" } } };
      await expect(runCodexGoal(config, { createExecutor: () => { throw new Error("unexpected_executor"); },
        admitProviderEgress: async () => { throw new Error("unexpected_egress"); } })).rejects.toThrow("job_storage_lifetime_authority_required");
      await expect(access(config.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stops a revoked lease after awaited egress before checkpoint/bootstrap writes or provider creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-a1-revoked-lease-"));
    let revoked = false, terminalObserved = false, providerStarts = 0;
    let reachEgress!: () => void, releaseEgress!: () => void;
    const reachedEgress = new Promise<void>(resolve => { reachEgress = resolve; });
    const egressGate = new Promise<void>(resolve => { releaseEgress = resolve; });
    const config: CodexGoalRunConfig = { ...goalConfig(root, { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "test-session" }),
      storage: { generationId: "generation-1", intent: { kind: JobStorageIntentKind.Continuation, sessionId: "test-session" } } };
    // Adversarial descriptive receipt tests rejection only. It qualifies no
    // native pin, shared generation fence, provider execution or successful job.
    const running = runCodexGoal(config, {
      storageAdmission: { async withAdmittedLifetime(request, effect) {
        return effect({ receipt: { ...request, schemaVersion: 1, receiptSha256: "a".repeat(64),
          machineId: "TEST-unqualified-machine", filesystemUuid: "TEST-unqualified-fs", device: "TEST-device",
          mountSource: "TEST-mount", fsRoot: "/", namespaceId: "TEST-namespace", pinId: "TEST-no-native-pin" },
          assertCurrent: () => { if (revoked) throw new Error("TEST_storage_lease_revoked"); },
          observeRunnerTerminal: async () => { terminalObserved = true; } });
      } },
      admitProviderEgress: async () => { reachEgress(); await egressGate; return codexProviderApiEgressPolicy(); },
      createExecutor: () => { providerStarts += 1; throw new Error("unexpected_executor"); },
    });
    const rejection = expect(running).rejects.toThrow("TEST_storage_lease_revoked");
    try {
      await Promise.race([reachedEgress, running.then(() => { throw new Error("unexpected_completion_before_egress"); })]);
      revoked = true;
      releaseEgress();
      await rejection;
      expect(providerStarts).toBe(0);
      expect(terminalObserved).toBe(true);
      await expect(access(config.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { releaseEgress(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["temp", "output", "encryption", "handoff"])("rejects NEW %s write escape before admission or files", async escape => {
    const root = await mkdtemp(join(tmpdir(), "test-a1-write-escape-"));
    try {
      const config: CodexGoalRunConfig = { ...goalConfig(root, { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "test-session" }),
        storage: { generationId: "generation-1", intent: { kind: JobStorageIntentKind.Continuation, sessionId: "test-session" } },
        ...(escape === "temp" ? { sourceEnv: { SUBSCRIPTION_RUNTIME_TMPDIR: "/TEST/foreign-temp", TMPDIR: "/TEST/foreign-temp/agent" } } : {}),
        ...(escape === "output" ? { outputPath: "/TEST/foreign-output" } : {}),
        ...(escape === "encryption" ? { encryptionKeyPath: "/TEST/foreign-key" } : {}),
        ...(escape === "handoff" ? { durableHandoffRootDir: "/TEST/foreign-handoff" } : {}),
      };
      await expect(runCodexGoal(config, { storageAdmission: { async withAdmittedLifetime() { throw new Error("unexpected_native_admission"); } },
        createExecutor: () => { throw new Error("unexpected_executor"); } })).rejects.toThrow("codex_goal_storage_layout_invalid");
      await expect(access(config.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps NEW OneShot disabled even when an admission dependency is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-a1-one-shot-disabled-"));
    try {
      const config = { ...goalConfig(root, { kind: CodexSessionHomeProfileKind.OneShot }), storage: { generationId: "generation-1",
        intent: { kind: JobStorageIntentKind.NoResume as const, homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } } };
      await expect(runCodexGoal(config, { storageAdmission: { async withAdmittedLifetime() { throw new Error("unexpected_native_admission"); } } }))
        .rejects.toThrow("job_storage_one_shot_disposal_unqualified");
      await expect(access(config.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => buildCodexGoalExecutorOptions({ config, stateRootDir: join(root, "state"), encryptionKey: new Uint8Array(32) }))
        .toThrow("job_storage_one_shot_disposal_unqualified");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
function goalConfig(root: string, sessionHomeProfile?: CodexSessionHomeProfile): CodexGoalRunConfig {
  return { jobId: "test-a1", taskId: "test-a1", jobRootDir: join(root, "job"), runtimeHomeRootDir: join(root, "job", "home"),
    workspacePath: join(root, "workspace"), promptPath: join(root, "prompt.md"), authRootDir: join(root, "synthetic-auth"),
    accounts: [{ name: "synthetic" }], ...(sessionHomeProfile ? { sessionHomeProfile } : {}) };
}
