import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentRuntimeTool, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AppServerExecutionLifetime, CodexModelBackend, codexMimoDefaultModel, HostedMimoProfile, type CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import { captureHostedMimoCodingProxyCredential } from "../../provider-codex/hosted-mimo-credential-source";
import { startMimoCredentialProxy, type MimoCredentialProxy } from "../../provider-codex/hosted-mimo-credential-proxy";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { FileBackendCodexWorker, type FileBackendCodexWorkerOptions } from "../file-backend-codex-worker";
import * as workerFactory from "../file-backend-codex-runtime-factory";
import { codexAccountCapacityRootDir, codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { reserveCodexProjectAccount } from "../application/project-control/codex-goal-project-account-reservation";
import { ResearchMimoTaskRecoveryExecution, researchMimoTaskRecoveryOwner, settleResearchMimoCapacityRecovery } from "../research-mimo-capacity-recovery";
import { parseResearchOperatorRequest, type ResearchStartSpec } from "../research-launch-contract";
import type { researchCurrentStart } from "../research-launch-admission";
import { singleAccountFixture } from "./codex-goal-project-account-reservation-fixture";
import type { HostedMimoCodingWorkerOrigin } from "../../provider-codex/hosted-mimo-worker-origin";

// Only protected source/Host reads are replaced. Task/pool/store/credential
// capture/protocol proof/disposal/settlement are the actual production objects.
const native = vi.hoisted(() => ({ current: undefined as ReturnType<typeof researchCurrentStart> | undefined,
  fullGuardCalls: 0, factories: new Set<CodexAppServerProcessFactory>(), live: true, key: "", root: "", keyFds: new Set<number>() }));
vi.mock("../research-launch-admission", async original => ({
  ...await original<typeof import("../research-launch-admission")>(),
  ownedMimoWorkerStart: (factory: CodexAppServerProcessFactory) => native.factories.has(factory) ? native.current!.spec : undefined,
  researchCurrentStart: (job: string) => { if (job !== native.current!.spec.request.jobId) throw Error("TEST wrong owner"); return native.current!; },
  researchProviderAdmissionGuard: (factory: CodexAppServerProcessFactory) => native.factories.has(factory) ? () => { native.fullGuardCalls++; if (!native.live) throw Error("TEST original native no longer live"); } : undefined,
  researchProviderRetainedAuthorityGuard: (factory: CodexAppServerProcessFactory) => native.factories.has(factory) ? () => { if (!native.live) throw Error("TEST original native no longer live"); } : undefined,
}));
vi.mock("../../provider-codex/hosted-mimo-worker-origin", async original => ({
  ...await original<typeof import("../../provider-codex/hosted-mimo-worker-origin")>(),
  assertHostedMimoCodingWorkerOriginCurrent: () => {},
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const fixed = "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key";
  return { ...fs,
    openSync: (path: Parameters<typeof fs.openSync>[0], flags: string | number, mode?: number) => {
      const key = path === fixed, fd = fs.openSync(key ? native.key : path, flags, mode);
      if (key) native.keyFds.add(fd); return fd;
    },
    closeSync: (fd: number) => { native.keyFds.delete(fd); return fs.closeSync(fd); },
    fstatSync: (fd: number) => { const stat = fs.fstatSync(fd); return native.keyFds.has(fd) ? Object.assign(stat, { uid: 0 }) : stat; },
    lstatSync: (path: string) => {
      if (native.key && (path === fixed || fixed.startsWith(path.endsWith("/") ? path : path + "/"))) {
        const stat = fs.lstatSync(path === fixed ? native.key : native.root);
        return Object.assign(stat, { uid: 0, mode: stat.mode & ~0o022 });
      }
      return fs.lstatSync(path);
    },
  };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); native.factories.clear(); native.key = ""; native.root = ""; native.current = undefined; native.live = true; native.fullGuardCalls = 0; });
const demand = { provider: "codex", model: codexMimoDefaultModel, reasoningEffort: "high", serviceTier: "default" } as const;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("original native MiMo task current-key recovery composition", () => {
  it("joins protected birth, honest pending pool, one real response, disposed acceptance, cold settlement and next same-key task", async () => {
    const root = mkdtempSync(join(tmpdir(), "TEST-mimo-recovery-composition-")); roots.push(root); native.root = root;
    native.key = join(root, "TEST-key"); writeFileSync(native.key, "synthetic-current-token\n", { mode: 0o600 });
    const base = singleAccountFixture(root, "TEST-native-recovery");
    const scoped = { manifest: { ...base.manifest, accounts: ["account-q"] },
      launch: { ...base.launch, config: { ...base.launch.config, accounts: [{ name: "account-q" }] } } };
    mkdirSync(scoped.manifest.workspacePath, { recursive: true });
    const authRoot = scoped.launch.config.authRootDir;
    const capacityRoot = join(codexAccountCapacityRootDir(authRoot), "mimo-token-plan");
    const original = new LocalFileWorkerAccountCapacityStore({ rootDir: capacityRoot }).observe({
      accountId: "codex-provider:legacy", observedAt: new Date(Date.now() - 10_000), retainExpiredForRecheck: true,
      capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(Date.now() - 5_000) },
    })!;
    const originalBytes = readFileSync(original.recordId);
    const capacity = codexAccountCapacityStore(authRoot, { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan });
    const launch = { ...scoped.launch, config: { ...scoped.launch.config, ...demand, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, prewarmOnStart: false } };
    const reservation = await reserveCodexProjectAccount({ manifest: { ...scoped.manifest, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }, launch,
      deps: { capacityStore: capacity, leaseMode: "shared" } });
    expect(reservation.recoveryPending?.phase).toBe("prepared");
    expect(() => capacity.read({ accountId: "account-q", demand })).toThrow("legacy_identity_unresolved");
    let capturedOptions: FileBackendCodexWorkerOptions | undefined, proxy: MimoCredentialProxy | undefined;
    const originalFactory = workerFactory.createFileBackendCodexWorkerRuntime;
    vi.spyOn(workerFactory, "createFileBackendCodexWorkerRuntime").mockImplementation(input => { capturedOptions = input.options as FileBackendCodexWorkerOptions; return originalFactory(input); });
    vi.spyOn(FileBackendCodexWorker.prototype, "start").mockResolvedValue();
    vi.spyOn(FileBackendCodexWorker.prototype, "health").mockImplementation(async () => ({ status: "healthy", state: "ready", checkedAt: new Date(), failures: [], warnings: [] }));
    vi.spyOn(FileBackendCodexWorker.prototype, "dispose").mockImplementation(async () => { await proxy?.close(); });
    vi.spyOn(FileBackendCodexWorker.prototype, "capacityRecoveryProof").mockImplementation(() => proxy?.capacityRecoveryProof());
    const entered = deferred(), release = deferred(); let innerRuns = 0;
    vi.spyOn(FileBackendCodexWorker.prototype, "run").mockImplementation(async () => {
      innerRuns++;
      const capture = captureHostedMimoCodingProxyCredential({} as HostedMimoCodingWorkerOrigin, new DefaultRedactor(), () => {});
      const guard = await capturedOptions!.bindMimoCapacityRecoveryCredential!({ credentialFingerprint: capture.credentialFingerprint, requestedModel: demand.model, assertCurrent: capture.assertCurrent });
      proxy = await startMimoCredentialProxy({ apiKey: capture.bytes, credentialCapture: capture, model: demand.model, assertCurrent: guard,
        fetchUpstream: async () => new Response(JSON.stringify({ object: "response", id: "resp_TEST-original-task", status: "completed", model: demand.model }), { headers: { "content-type": "application/json" } }),
        limits: { deadlineMs: Date.now() + 60_000, maxRequests: 4, maxConcurrency: 1, maxBodyBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 100, requestTimeoutMs: 5000 } });
      capture.bytes.fill(0);
      await (await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { authorization: "Bearer " + proxy.capability, "content-type": "application/json" }, body: JSON.stringify({ model: demand.model, input: "TEST original already-authorized task" }) })).text();
      entered.resolve(); await release.promise;
      return { outputText: "TEST genuine completed task", warnings: [] };
    });
    const request = parseResearchOperatorRequest({ schemaVersion: 1, jobId: scoped.manifest.jobId, taskId: scoped.manifest.taskId,
      jobRootDir: scoped.manifest.jobRootDir, workspacePath: scoped.manifest.workspacePath, promptPath: scoped.manifest.promptPath,
      authRootDir: authRoot, accounts: ["account-q"], codexBinaryPath: "/usr/bin/codex", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      hostedProfile: HostedMimoProfile.CodingV1, model: demand.model, reasoningEffort: demand.reasoningEffort, serviceTier: demand.serviceTier, taskTimeoutMs: 60_000, maxAccountCycles: 1, prewarmOnStart: false });
    const spec: ResearchStartSpec = { schemaVersion: 1, startId: "11111111-1111-4111-8111-111111111111", runtimeDirectory: join(root, "TEST-runtime"),
      artifactSha256: "a".repeat(64), grantSha256: "b".repeat(64), request, requestSha256: "c".repeat(64), nodeSha256: "d".repeat(64), codexSha256: "e".repeat(64),
      unit: "subscription-runtime-research-11111111-1111-4111-8111-111111111111.service", jobDirectory: { path: request.jobRootDir, device: 1, inode: 2 }, workspaceDirectory: { path: request.workspacePath, device: 1, inode: 3 } };
    const bytes = Buffer.from(JSON.stringify(spec));
    native.current = { spec, bytes, directory: join(root, "TEST-native") };
    const factory = vi.fn<CodexAppServerProcessFactory>(); native.factories.add(factory);
    const owner = researchMimoTaskRecoveryOwner(factory)!;
    const makeExecutor = (selectedOwner: NonNullable<ReturnType<typeof researchMimoTaskRecoveryOwner>>, stateLeaf: string) => {
      const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 60_000, maxGoalTurns: 64, binding: { allocationId: selectedOwner.task.jobId, incarnationId: selectedOwner.task.startId } });
      return new FileBackendCodexSafeExecutor({ stateRootDir: join(root, stateLeaf), workspacePath: request.workspacePath,
      accountCapacityStore: capacity, mimoTaskRecoveryOwner: selectedOwner, executionLifetime: lifetime, maxAccountCycles: 1,
      prewarmOnStart: false, requireGitWorkspace: false, effectMode: "read_only", safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled" },
      accounts: [{ worker: { providerInstanceId: "TEST-provider", stateRootDir: join(root, stateLeaf), codexBinaryPath: "codex", encryptionKey: new Uint8Array(32).fill(7),
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, executionEngine: "app-server-goal", executionLifetime: lifetime, maxGoalTurns: 64, cleanThreadPrewarm: false, boundedWorkspaceTools: { denyProjectInstructions: true, allowedTools: [AgentRuntimeTool.ReadFile] },
        ...demand, sourceEnv: { MIMO_API_KEY: "synthetic-current-token" } } }] });
    };
    const executor = makeExecutor(owner, "state");
    const run = executor.run({ taskId: request.taskId, prompt: "TEST original task", effectMode: "read_only" });
    await Promise.race([entered.promise, run.then(result => { if ("error" in result && result.error instanceof Error) throw result.error; throw new Error("TEST managed result before worker: " + result.status + ("reason" in result ? ":" + result.reason + ":" + result.safeMessage : "")); })]);
    expect(executor.stats()).toMatchObject({ inFlight: 1, completed: 0 });
    const fullAtEntered = native.fullGuardCalls;
    await expect(executor.health()).resolves.toMatchObject({ status: "degraded" });
    await expect(executor.health()).resolves.toMatchObject({ status: "degraded" });
    expect(native.fullGuardCalls).toBe(fullAtEntered);
    await expect(executor.run({ taskId: request.taskId, prompt: "TEST forbidden retry" })).rejects.toThrow("child_invocation_consumed");
    expect(() => capacity.prepareTaskRecovery!({ demand, now: new Date(Date.now() + 24 * 60 * 60_000) })).toThrow("task_recovery_closed");
    release.resolve(); await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(executor.stats()).toMatchObject({ inFlight: 0, completed: 1 });
    await executor.dispose();
    const guardedTerminal = () => { if (native.live) throw Error("TEST original native/provider still live"); };
    await expect(settleResearchMimoCapacityRecovery(native.current, { assertTerminal: guardedTerminal, withPublication: async effect => await effect() })).rejects.toThrow("still live");
    native.live = false;
    await settleResearchMimoCapacityRecovery(native.current, { assertTerminal: guardedTerminal, withPublication: async effect => await effect() });
    const nextJobId = "TEST-native-recovery-next", nextTaskId = nextJobId + "-task";
    const nextRoot = join(root, nextJobId), nextPrompt = join(nextRoot, "prompt.md");
    const nextManifest = { ...scoped.manifest, jobId: nextJobId, taskId: nextTaskId, jobRootDir: nextRoot, promptPath: nextPrompt, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan };
    const nextLaunch = { ...launch, config: { ...launch.config, jobId: nextJobId, taskId: nextTaskId, jobRootDir: nextRoot, promptPath: nextPrompt } };
    const nextReservation = await reserveCodexProjectAccount({ manifest: nextManifest, launch: nextLaunch, deps: { capacityStore: capacity, leaseMode: "shared" } });
    expect(nextReservation.recoveryPending?.recordSha256).toBe(reservation.recoveryPending!.recordSha256);
    const nextRequest = parseResearchOperatorRequest({ ...request, jobId: nextJobId, taskId: nextTaskId, jobRootDir: nextRoot, promptPath: nextPrompt });
    const nextSpec = { ...spec, startId: "22222222-2222-4222-8222-222222222222", unit: "subscription-runtime-research-22222222-2222-4222-8222-222222222222.service", request: nextRequest, requestSha256: "f".repeat(64) };
    native.current = { spec: nextSpec, bytes: Buffer.from(JSON.stringify(nextSpec)), directory: join(root, "TEST-native-next") }; native.live = true;
    const nextOwner = researchMimoTaskRecoveryOwner(factory)!;
    const nextExecutor = makeExecutor(nextOwner, "state-next");
    await expect(nextExecutor.run({ taskId: nextTaskId, prompt: "TEST next original authorized task", effectMode: "read_only" })).resolves.toMatchObject({ status: "completed" });
    expect(nextExecutor.stats()).toMatchObject({ inFlight: 0, completed: 1 });
    await nextExecutor.dispose();
    const noRecoveryHook = new ResearchMimoTaskRecoveryExecution({ owner: nextOwner, store: capacity,
      options: { accounts: [] }, worker: () => undefined, accountId: () => "account-q" });
    const fullBeforeBind = native.fullGuardCalls;
    const inert = await noRecoveryHook.bindCredential({ credentialFingerprint: "a".repeat(64), requestedModel: demand.model, assertCurrent() {} });
    expect(native.fullGuardCalls).toBe(fullBeforeBind + 1);
    for (let index = 0; index < 4; index++) inert();
    expect(native.fullGuardCalls).toBe(fullBeforeBind + 1);
    expect(innerRuns).toBe(2); expect(readFileSync(original.recordId)).toEqual(originalBytes);
    expect(hash(bytes)).toBe(owner.task.specSha256);
  }, 20_000);
});
