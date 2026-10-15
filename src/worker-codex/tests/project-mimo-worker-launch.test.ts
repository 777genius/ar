import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(),
  authorize: vi.fn(), grant: vi.fn(), start: vi.fn(), current: vi.fn(), status: vi.fn(), service: vi.fn(), process: vi.fn(), cancel: vi.fn(), handoff: vi.fn(), terminal: vi.fn(), finalize: vi.fn() }));
vi.mock("../research-registered-handoff", () => ({ authorizeRegisteredResearchHandoff: state.authorize,
  assertRegisteredResearchHandoffCurrent: state.handoff }));
vi.mock("../research-launch-owner", () => ({ grantRegisteredResearchLaunch: state.grant,
  startRegisteredResearchLaunch: state.start }));
vi.mock("../research-launch-admission", () => ({ researchJobAuthority: () => "/TEST-authority", researchCurrentStart: state.current, readResearchStartBinding: (directory: string) => JSON.parse(state.files.get(directory + "/binding.json")!.toString()) }));
vi.mock("../research-launch-files", async importOriginal => ({ ...await importOriginal<object>(),
  researchPublish: (path: string, value: unknown, exclusive: boolean) => {
    if (exclusive && state.files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    state.files.set(path, Buffer.from(JSON.stringify(value) + "\n"));
  }, researchRead: (path: string) => {
    const bytes = state.files.get(path); if (!bytes) throw Object.assign(new Error("Missing TEST request"), { code: "ENOENT" }); return bytes;
  } }));
vi.mock("../research-launch-lifecycle", () => ({ statusResearchLaunch: state.status, cancelRegisteredResearchLaunch: state.cancel, finalizeOwnedMimoWorker: state.finalize, terminalResearchStart: state.terminal }));
vi.mock("../research-launch-host", async importOriginal => ({ ...await importOriginal<object>(),
  assertResearchInitialRoot: vi.fn(), researchServiceIdentity: state.service, researchProcessIdentity: state.process }));
import { researchDescription } from "../research-launch-host";
import { CodexGoalNativeLifecycle, recommendCodexGoalAction } from "../codex-goal-ops";
import { researchHash } from "../research-launch-files";
import { launchProjectMimoWorker, observeProjectMimoWorker, stopProjectMimoWorker } from "../project-mimo-worker-launch";
import { createCodexGoalObservationContext } from "../application/codex-goal-observation-context";
import { collectRegisteredCodexGoalJobStatus } from "../application/codex-goal-registered-job-observation";
import { buildCodexGoalBrief } from "../application/codex-goal-brief";
import { isCodexGoalHeartbeatOnlyNoOutput } from "../application/codex-goal-decision";
function launch(jobRootDir = "/TEST-job"): CodexGoalLaunchInput {
  return { config: { jobId: "TEST-child", taskId: "TEST-task", jobRootDir,
    workspacePath: "/TEST-workspace", promptPath: join(jobRootDir, "prompt.md"), authRootDir: "/TEST-auth",
    codexBinaryPath: "/TEST-bin/codex", accounts: [{ name: "account-q" }],
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: "mimo-v2.6-pro",
    taskTimeoutMs: 60000, maxAccountCycles: 1, prewarmOnStart: false,
    projectAccessScope: { projectId: "TEST-project", isolatedWorkspaceRoot: "/TEST-workspace", authRoot: "/TEST-auth" } },
    cwd: "/TEST-workspace", logPath: join(jobRootDir, "log"), cliCommand: ["node", "cli"] };
}
beforeEach(() => {
  state.files.clear(); vi.clearAllMocks(); state.current.mockReset(); state.service.mockReset(); state.handoff.mockReset(); state.handoff.mockResolvedValue(() => {}); state.terminal.mockReset();
  state.terminal.mockImplementation(() => { throw Object.assign(Error("TEST no terminal"), { code: "ENOENT" }); });
  state.service.mockImplementation(() => { throw Error("TEST unknown service"); });
  state.process.mockReturnValue({ pid: 999, birthTicks: "99", bootId: "00000000-0000-4000-8000-000000000000",
    machineId: "1".repeat(32), controlGroup: "/TEST-operator", namespaces: { user: "user:[1]", mnt: "mnt:[2]", pid: "pid:[3]", net: "net:[4]" } });
  state.authorize.mockImplementation(async ({ request }) => ({ request: { ...request,
    durableHandoffRootDir: "/TEST-registry/durable-handoffs" } }));
  state.grant.mockResolvedValue(undefined);
  state.start.mockResolvedValue({ jobId: "TEST-child", unit: "TEST-unit", startId: "TEST-start", specSha256: "a".repeat(64) });
});
describe("registered project MiMo dispatch", () => {
  it("preserves the original reserved capability and publishes the authorizer's sink", async () => {
    const reservedLaunch = launch();
    await launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch });
    expect(state.authorize.mock.calls[0]?.[0].reservedLaunch).toBe(reservedLaunch);
    const request = JSON.parse(state.files.get("/TEST-authority/project-worker-request.json")!.toString());
    expect(request.durableHandoffRootDir).toBe("/TEST-registry/durable-handoffs");
    expect(request).not.toHaveProperty("env");
    expect(request).toMatchObject({ hostedProfile: "mimo-coding-v1", maxGoalTurns: 64 });
    expect(JSON.parse(state.files.get("/TEST-authority/project-worker-attempt.json")!.toString())).toMatchObject({
      startId: "TEST-start", specSha256: "a".repeat(64), registryRootDir: "/TEST-registry" });
  });
  it("performs no host effects when independent registered admission fails", async () => {
    state.authorize.mockRejectedValueOnce(new Error("foreign project"));
    await expect(launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() })).rejects.toThrow("foreign project");
    expect(state.grant).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled(); expect(state.files.size).toBe(0);
  });
  it("recovers the existing exact attempt after a lost start response without resubmission", async () => {
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256, "retained native spec");
      current.spec.unit = "TEST-retained-unit"; current.spec.startId = "TEST-retained-start";
      acceptedSubmission(current);
      throw new Error("lost response");
    });
    await expect(launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() })).resolves.toMatchObject({ startId: "TEST-retained-start", unit: "TEST-retained-unit" });
    expect(JSON.parse(state.files.get("/TEST-authority/project-worker-attempt.json")!.toString())).toMatchObject({
      startId: "TEST-retained-start", specSha256: researchHash(Buffer.from("retained native spec")) });
    expect(state.start).toHaveBeenCalledTimes(1);
  });
  it("retains uncertain submission and never replaces its exact request", async () => {
    state.start.mockRejectedValueOnce(new Error("uncertain transport"));
    const input = { registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() };
    await expect(launchProjectMimoWorker(input)).rejects.toThrow("uncertain transport");
    const request = state.files.get("/TEST-authority/project-worker-request.json");
    await expect(launchProjectMimoWorker(input)).rejects.toThrow("project_mimo_worker_prior_submission_retained");
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.files.get("/TEST-authority/project-worker-request.json")).toBe(request);
  });
});

const temporaryRoots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("owned native MiMo observation", () => {
  async function retained(jobRootDir = "/TEST-job") {
    vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 0 });
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256, "native retained TEST"); acceptedSubmission(current);
      throw new Error("TEST lost response");
    });
    await launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch(jobRootDir) });
    state.status.mockReturnValue({ jobId: "TEST-child", unit: "TEST-unit", startId: "TEST-start", active: true, providers: [] });
    return { registryRootDir: "/TEST-registry", launch: launch(jobRootDir) };
  }
  it("waits for positively owned active or pending native service without pretending tmux lives", async () => {
    const input = await retained();
    const nativeLifecycle = await observeProjectMimoWorker(input);
    expect(nativeLifecycle).toBe(CodexGoalNativeLifecycle.Active);
    if (nativeLifecycle === undefined) throw Error("TEST native observation missing");
    expect(recommendCodexGoalAction({ nativeLifecycle, tmuxAlive: false, resultExists: false })).toBe("wait_for_worker");
  });
  it.each([CodexGoalNativeLifecycle.Active, CodexGoalNativeLifecycle.Terminal, CodexGoalNativeLifecycle.Uncertain])(
    "omits an uncovered negative app-server observation with native lifecycle %s", async lifecycle => {
      const observed = await descendantObservation();
      const input = { ...await retained(observed.jobRoot), observation: observed.context }; vi.clearAllMocks();
      if (lifecycle === CodexGoalNativeLifecycle.Terminal) state.status.mockReturnValue({ jobId: "TEST-child", unit: "TEST-unit", startId: "TEST-start", active: false, providers: [] });
      if (lifecycle === CodexGoalNativeLifecycle.Uncertain) state.status.mockImplementation(() => { throw Error("TEST status unavailable"); });
      const before = [...state.files.entries()];
      const status = await collectRegisteredCodexGoalJobStatus(input);
      expect(status).not.toHaveProperty("appServerProcessAlive");
      expect(status.nativeLifecycle).toBe(lifecycle);
      expect(status.recommendedAction).toBe(lifecycle === CodexGoalNativeLifecycle.Active ? "wait_for_worker" : "check_log_or_result");
      expect(observed.readProcessRows).toHaveBeenCalledTimes(1); expect(observed.readWorkspaceStatus).toHaveBeenCalledTimes(1); expect(state.status).toHaveBeenCalledTimes(1);
      expect(state.start).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled(); expect(state.finalize).not.toHaveBeenCalled();
      expect([...state.files.entries()]).toEqual(before);
      if (lifecycle === CodexGoalNativeLifecycle.Active) {
        const brief = await buildCodexGoalBrief({ jobId: "TEST-child", launch: input.launch, status, accounts: [], staleAfterMs: 600_000, tailLines: 10 });
        expect(brief.text).toContain("appServerProcessAlive unknown");
        const prior = { ...status, appServerProcessAlive: false };
        expect(isCodexGoalHeartbeatOnlyNoOutput({ status, staleAfterMs: 600_000 })).toBe(true);
        expect(isCodexGoalHeartbeatOnlyNoOutput({ status, staleAfterMs: 600_000 })).toBe(isCodexGoalHeartbeatOnlyNoOutput({ status: prior, staleAfterMs: 600_000 }));
      }
    });
  it("preserves a positive descendant app-server observation and exact PID with native ownership", async () => {
    const observed = await descendantObservation(true);
    const input = { ...await retained(observed.jobRoot), observation: observed.context };
    const status = await collectRegisteredCodexGoalJobStatus(input);
    expect(status).toMatchObject({ nativeLifecycle: CodexGoalNativeLifecycle.Active, appServerProcessAlive: true, appServerProcessPid: 101, recommendedAction: "wait_for_worker" });
  });
  it("keeps direct non-native descendant negatives unchanged", async () => {
    const observed = await descendantObservation();
    const original = launch(observed.jobRoot), direct = { ...original, config: { ...original.config, modelBackend: CodexModelBackend.OpenAiChatGpt } };
    const status = await collectRegisteredCodexGoalJobStatus({ registryRootDir: "/TEST-registry", launch: direct, observation: observed.context });
    expect(status.appServerProcessAlive).toBe(false); expect(status.nativeLifecycle).toBeUndefined(); expect(state.status).not.toHaveBeenCalled();
  });
  it.each(["stale", "unknown"])("does not recommend restart on %s native observation", async fault => {
    const input = await retained();
    if (fault === "stale") state.status.mockReturnValue({ jobId: "TEST-child", unit: "OTHER-unit", startId: "OTHER-start", active: true, providers: [] });
    else state.status.mockImplementation(() => { throw Error("TEST status unavailable"); });
    const nativeLifecycle = await observeProjectMimoWorker(input);
    expect(nativeLifecycle).toBe(CodexGoalNativeLifecycle.Uncertain);
    if (nativeLifecycle === undefined) throw Error("TEST native observation missing");
    expect(recommendCodexGoalAction({ nativeLifecycle, tmuxAlive: false, resultExists: false })).toBe("check_log_or_result");
  });
  it("does not treat an accepted submission alone as native liveness proof", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 0 });
    await launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() });
    state.current.mockImplementation(() => { throw Object.assign(Error("TEST no active"), { code: "ENOENT" }); });
    expect(await observeProjectMimoWorker({ registryRootDir: "/TEST-registry", launch: launch() })).toBe(CodexGoalNativeLifecycle.Uncertain);
    expect(state.status).not.toHaveBeenCalled();
  });
  it("inspects a terminal owned attempt with no published result instead of restarting", () => {
    expect(recommendCodexGoalAction({ nativeLifecycle: CodexGoalNativeLifecycle.Terminal, resultExists: false, tmuxAlive: false })).toBe("check_log_or_result");
    expect(recommendCodexGoalAction({ nativeLifecycle: CodexGoalNativeLifecycle.Terminal, progressStatus: "maintenance_paused", resultExists: false })).toBe("check_log_or_result");
    expect(recommendCodexGoalAction({ tmuxAlive: false, resultExists: false })).toBe("start_worker");
  });
});

async function descendantObservation(appServer = false) {
  const jobRoot = await mkdtemp(join(tmpdir(), "TEST-native-liveness-")); temporaryRoots.push(jobRoot);
  await writeFile(join(jobRoot, "TEST-task.progress.json"), JSON.stringify({ pid: 100, status: "running", updatedAt: new Date().toISOString() }));
  await writeFile(join(jobRoot, "log"), "");
  const old = new Date(Date.now() - 1_200_000); await utimes(join(jobRoot, "log"), old, old);
  const readProcessRows = vi.fn(async () => [{ pid: 100, ppid: 1, cpu: 0, command: "node subscription-runtime-codex-goal" },
    ...(appServer ? [{ pid: 101, ppid: 100, cpu: 0, command: "codex app-server --listen stdio://" }] : [])]);
  const readWorkspaceStatus = vi.fn(async () => ({ exists: true, dirty: false, changedFiles: [] }));
  return { jobRoot, readProcessRows, readWorkspaceStatus,
    context: createCodexGoalObservationContext({ readProcessRows, readWorkspaceStatus }) };
}

function preparedStart(requestSha256: string, text = "TEST exact prepared spec") {
  const request = JSON.parse(state.files.get("/TEST-authority/project-worker-request.json")!.toString());
  const bytes = Buffer.from(text), directory = "/TEST-attempt";
  const current = { bytes, directory, spec: { request, requestSha256, grantSha256: researchHash(Buffer.from("TEST exact grant")), unit: "TEST-unit", startId: "TEST-start",
    registeredHandoff: { registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller" } } };
  state.current.mockReturnValue(current); state.files.set(directory + "/spec.json", bytes);
  state.files.set("/TEST-authority/active.json", Buffer.from("TEST exact active slot"));
  state.files.set("/TEST-authority/grant.json", Buffer.from("TEST exact grant"));
  return current;
}
describe("submission proof before retained attempt recovery", () => {
  it.each([false, true])("preserves the original pre-submission error with an existing bogus attempt=%s", async bogus => {
    const original = Error("TEST original failed before systemd submission");
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256);
      if (bogus) state.files.set("/TEST-authority/project-worker-attempt.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
        registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", jobId: "TEST-child", startId: "TEST-start",
        specSha256: researchHash(current.bytes), requestSha256 })));
      throw original;
    });
    await expect(launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() })).rejects.toBe(original);
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.files.has("/TEST-authority/project-worker-attempt.json")).toBe(bogus);
  });
  it("keeps prepared historical receipt uncertain while canonical Stop can request exact cleanup without minting acceptance", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 0 });
    await launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() });
    const request = state.files.get("/TEST-authority/project-worker-request.json")!;
    const current = preparedStart(researchHash(request));
    state.files.set("/TEST-authority/project-worker-attempt.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
      registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", jobId: "TEST-child", startId: "TEST-start",
      specSha256: researchHash(current.bytes), requestSha256: researchHash(request) })));
    state.status.mockReturnValue({ jobId: "TEST-child", unit: "TEST-unit", startId: "TEST-start", active: true, providers: [] });
    expect(await observeProjectMimoWorker({ registryRootDir: "/TEST-registry", launch: launch() })).toBe(CodexGoalNativeLifecycle.Uncertain);
    expect(state.status).not.toHaveBeenCalled();
    state.files.delete("/TEST-authority/project-worker-attempt.json");
    state.cancel.mockResolvedValueOnce({ cleanWorkspace: true });
    await expect(stopProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", launch: launch() })).resolves.toEqual({ cleanWorkspace: "true" });
    expect(state.cancel).toHaveBeenCalledWith({ jobId: "TEST-child", startId: "TEST-start", specSha256: researchHash(current.bytes), requestSha256: researchHash(request) });
    expect(state.files.has("/TEST-authority/project-worker-attempt.json")).toBe(false);
  });
});

function acceptedSubmission(current: ReturnType<typeof preparedStart>, kind: "pending" | "binding" | "live" = "pending") {
  const host = state.process(), unit = current.spec.unit;
  const service = { unit, mainPid: kind === "pending" ? 0 : 321, controlGroup: "/system.slice/" + unit,
    invocationId: "a".repeat(32), fragmentSha256: "b".repeat(64), description: researchDescription("TEST-child", researchHash(current.bytes)) };
  const process = { ...host, pid: 321, birthTicks: "123", controlGroup: service.controlGroup,
    namespaces: { ...host.namespaces, mnt: "mnt:[222]" } };
  if (kind === "binding") state.files.set(current.directory + "/binding.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
    specSha256: researchHash(current.bytes), process, service })));
  else { state.service.mockReturnValue(service); state.process.mockImplementation(pid => pid === 321 ? process : host); }
}
describe("positive native submission recovery witnesses", () => {
  it.each(["binding", "live"] as const)("recovers lost response only with an actual owned %s and no resubmission", async kind => {
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256); acceptedSubmission(current, kind); throw Error("TEST lost accepted response");
    });
    await expect(launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() })).resolves.toMatchObject({ startId: "TEST-start" });
    expect(state.start).toHaveBeenCalledTimes(1);
    if (kind === "binding") expect(state.service).not.toHaveBeenCalled();
  });
  it.each(["active", "grant", "spec", "binding", "receipt"] as const)("refuses %s replacement across async handoff verification", async fault => {
    const original = Error("TEST original accepted-response uncertainty");
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256); acceptedSubmission(current, "binding");
      if (fault === "receipt") state.files.set("/TEST-authority/project-worker-attempt.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
        registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", jobId: "TEST-child", startId: "TEST-start",
        specSha256: researchHash(current.bytes), requestSha256 })));
      state.handoff.mockImplementationOnce(async () => {
        const path = fault === "active" || fault === "grant" ? "/TEST-authority/" + fault + ".json" : fault === "receipt"
          ? "/TEST-authority/project-worker-attempt.json" : current.directory + "/" + fault + ".json";
        state.files.set(path, Buffer.from("TEST replaced witness")); return () => {};
      });
      throw original;
    });
    await expect(launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() })).rejects.toBe(original);
    expect(state.start).toHaveBeenCalledTimes(1);
    if (fault !== "receipt") expect(state.files.has("/TEST-authority/project-worker-attempt.json")).toBe(false);
  });
  it.each(["wrong-spec", "foreign-owner", "wrong-boot", "unknown-service"] as const)("retains original error for %s proof", async fault => {
    const original = Error("TEST original submission failure");
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256);
      if (fault !== "unknown-service") {
        acceptedSubmission(current, "binding"); const path = current.directory + "/binding.json", binding = JSON.parse(state.files.get(path)!.toString());
        if (fault === "wrong-spec") binding.specSha256 = "f".repeat(64);
        if (fault === "foreign-owner") binding.service.description = "TEST foreign description";
        if (fault === "wrong-boot") binding.process.bootId = "00000000-0000-4000-8000-000000000001";
        state.files.set(path, Buffer.from(JSON.stringify(binding)));
      }
      throw original;
    });
    await expect(launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() })).rejects.toBe(original);
    expect(state.files.has("/TEST-authority/project-worker-attempt.json")).toBe(false);
  });
});

describe("historical admitted native binding after actual terminal transition", () => {
  it.each([false, true])("requires retained terminal identity without reinterpreting absent service (changed=%s)", async changed => {
    vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 0 });
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const current = preparedStart(requestSha256); acceptedSubmission(current, "binding"); throw Error("TEST lost accepted response");
    });
    await launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() });
    const current = state.current();
    state.files.delete("/TEST-authority/active.json");
    state.files.set("/TEST-authority/last-terminal.json", Buffer.from(JSON.stringify({ schemaVersion: 1, startId: "TEST-start", specSha256: researchHash(current.bytes) })));
    state.current.mockImplementation(() => { throw Object.assign(Error("TEST actual active absent"), { code: "ENOENT" }); });
    state.terminal.mockReturnValue({ ...current, active: false });
    state.status.mockReturnValue({ jobId: "TEST-child", unit: "TEST-unit", startId: "TEST-start", active: false, providers: [] });
    if (changed) state.handoff.mockImplementationOnce(async () => {
      state.files.set("/TEST-authority/last-terminal.json", Buffer.from("TEST substituted terminal")); return () => {};
    });
    expect(await observeProjectMimoWorker({ registryRootDir: "/TEST-registry", launch: launch() })).toBe(changed
      ? CodexGoalNativeLifecycle.Uncertain : CodexGoalNativeLifecycle.Terminal);
    expect(state.service).not.toHaveBeenCalled();
    if (changed) expect(state.status).not.toHaveBeenCalled();
  });
});
