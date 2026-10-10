import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(),
  authorize: vi.fn(), grant: vi.fn(), start: vi.fn(), current: vi.fn(), status: vi.fn() }));
vi.mock("../research-registered-handoff", () => ({ authorizeRegisteredResearchHandoff: state.authorize,
  assertRegisteredResearchHandoffCurrent: vi.fn() }));
vi.mock("../research-launch-owner", () => ({ grantRegisteredResearchLaunch: state.grant,
  startRegisteredResearchLaunch: state.start }));
vi.mock("../research-launch-admission", () => ({ researchJobAuthority: () => "/TEST-authority", researchCurrentStart: state.current }));
vi.mock("../research-launch-files", async importOriginal => ({ ...await importOriginal<object>(),
  researchPublish: (path: string, value: unknown, exclusive: boolean) => {
    if (exclusive && state.files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    state.files.set(path, Buffer.from(JSON.stringify(value) + "\n"));
  }, researchRead: (path: string) => {
    const bytes = state.files.get(path); if (!bytes) throw Object.assign(new Error("Missing TEST request"), { code: "ENOENT" }); return bytes;
  } }));
vi.mock("../research-launch-lifecycle", () => ({ statusResearchLaunch: state.status, cancelRegisteredResearchLaunch: vi.fn(), finalizeOwnedMimoWorker: vi.fn(), terminalResearchStart: () => { throw Object.assign(Error("TEST no terminal"), { code: "ENOENT" }); } }));
import { CodexGoalNativeLifecycle, recommendCodexGoalAction } from "../codex-goal-ops";
import { researchHash } from "../research-launch-files";
import { launchProjectMimoWorker, observeProjectMimoWorker } from "../project-mimo-worker-launch";
function launch(): CodexGoalLaunchInput {
  return { config: { jobId: "TEST-child", taskId: "TEST-task", jobRootDir: "/TEST-job",
    workspacePath: "/TEST-workspace", promptPath: "/TEST-job/prompt.md", authRootDir: "/TEST-auth",
    codexBinaryPath: "/TEST-bin/codex", accounts: [{ name: "account-q" }],
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: "mimo-v2.6-pro",
    taskTimeoutMs: 60000, maxAccountCycles: 1, prewarmOnStart: false,
    projectAccessScope: { projectId: "TEST-project", isolatedWorkspaceRoot: "/TEST-workspace", authRoot: "/TEST-auth" } },
    cwd: "/TEST-workspace", logPath: "/TEST-job/log", cliCommand: ["node", "cli"] };
}
beforeEach(() => {
  state.files.clear(); vi.clearAllMocks(); state.current.mockReset();
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
      const request = JSON.parse(state.files.get("/TEST-authority/project-worker-request.json")!.toString());
      const bytes = Buffer.from("retained native spec");
      state.current.mockReturnValue({ bytes, directory: "/TEST-attempt", spec: { request, requestSha256,
        unit: "TEST-retained-unit", startId: "TEST-retained-start", registeredHandoff: { registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller" } } });
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

afterEach(() => vi.unstubAllGlobals());
describe("owned native MiMo observation", () => {
  async function retained() {
    vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 0 });
    state.start.mockImplementationOnce(async (_path: string, requestSha256: string) => {
      const request = JSON.parse(state.files.get("/TEST-authority/project-worker-request.json")!.toString());
      state.current.mockReturnValue({ bytes: Buffer.from("native retained TEST"), directory: "/TEST-attempt",
        spec: { request, requestSha256, unit: "TEST-unit", startId: "TEST-start",
          registeredHandoff: { registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller" } } });
      throw new Error("TEST lost response");
    });
    await launchProjectMimoWorker({ registryRootDir: "/TEST-registry", controllerJobId: "TEST-controller", reservedLaunch: launch() });
    state.status.mockReturnValue({ jobId: "TEST-child", unit: "TEST-unit", startId: "TEST-start", active: true, providers: [] });
    return { registryRootDir: "/TEST-registry", launch: launch() };
  }
  it("waits for positively owned active or pending native service without pretending tmux lives", async () => {
    const input = await retained();
    const nativeLifecycle = await observeProjectMimoWorker(input);
    expect(nativeLifecycle).toBe(CodexGoalNativeLifecycle.Active);
    if (nativeLifecycle === undefined) throw Error("TEST native observation missing");
    expect(recommendCodexGoalAction({ nativeLifecycle, tmuxAlive: false, resultExists: false })).toBe("wait_for_worker");
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
