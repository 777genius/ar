import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexGoalTmux, buildCodexGoalTmuxCommand, CodexGoalLaunchState, type CodexGoalLaunchInput } from "../codex-goal-ops";
import { runCodexGoalCli } from "../codex-goal-cli";
import { routeHostedGoalLaunch } from "../hosted-readonly-goal-launch";
import { runHostedReadonlyForeground } from "../hosted-readonly-foreground";

const f = vi.hoisted(() => ({ role: vi.fn(), launch: vi.fn(), close: vi.fn(), receipt: vi.fn(),
  upsert: vi.fn(), spawn: vi.fn(), mkdir: vi.fn(), exec: vi.fn(), admit: vi.fn(), run: vi.fn(), events: [] as string[] }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: f.spawn, execFile: f.exec }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), mkdir: f.mkdir }));
vi.mock("../hosted-readonly-controller-admission", () => ({ admitHostedControllerLaunch: f.admit }));
vi.mock("../codex-goal-runner", async original => ({ ...await original<typeof import("../codex-goal-runner")>(), runCodexGoal: f.run }));
vi.mock("../hosted-readonly-supervisor-host", () => ({ HostedReadonlySupervisorHost: class {
  runtimeRole = f.role;
  readEpoch() { return { identity: { jobId: "TEST", jobRootDir: "/job", workspacePath: "/workspace" } }; }
  runRuntimeLaunch = f.launch;
  closeRuntimeLaunch = f.close;
  recordRuntimeWaitCompletion = f.receipt;
} }));
vi.mock("../codex-goal-launch-manifest", () => ({ upsertCodexGoalLaunchManifest: f.upsert }));
vi.mock("../project-control-scope-guard", async original => ({ ...await original<typeof import("../project-control-scope-guard")>(),
  projectControlGenericScopeDenial: async () => undefined, projectControlGenericToolDenial: () => undefined }));
const input: CodexGoalLaunchInput = {
  config: { jobId: "TEST", taskId: "task", jobRootDir: "/job", workspacePath: "/workspace", authRootDir: "/auth",
    promptPath: "/job/prompt", accounts: [{ name: "synthetic" }], sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } },
  cliCommand: ["node", "cli.js"], cwd: "/workspace", tmuxSession: "existing-foreign-server", logPath: "/job/log",
};
function child() {
  const processChild = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: vi.fn(() => true) });
  f.spawn.mockReturnValue(processChild);
  return processChild;
}
beforeEach(() => {
  vi.resetAllMocks(); f.events.length = 0;
  f.role.mockReturnValue("supervisor");
  f.launch.mockImplementation((_command, _args, _cwd, submit) => { f.events.push("reserve"); return submit({ command: "/usr/bin/systemd-run", args: ["--wait", "--pipe"] }); });
  f.close.mockImplementation(() => { f.events.push("close"); });
  f.receipt.mockImplementation(() => { f.events.push("receipt"); });
  f.run.mockResolvedValue({ status: "completed" });
});
describe("actual shared managed start route (synthetic host/process facts)", () => {
  it("previews the foreground command without claiming admission or scheduling", () => {
    const plan = buildCodexGoalTmuxCommand(input);
    expect(plan.preview).toContain("run --no-tmux");
    expect(plan.preview).not.toContain("tmux new-session");
    expect(plan.launchState).toBeUndefined();
    expect(f.role).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  });
  it("starts foreground without touching a foreign tmux server or parent paths and waits for the service", async () => {
    const processChild = child();
    const pending = startCodexGoalTmux(input);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    expect(f.launch).toHaveBeenCalledWith("node", expect.arrayContaining(["cli.js", "run", "--no-tmux", "--job-id", "TEST"]), "/workspace", expect.any(Function));
    expect(f.mkdir).not.toHaveBeenCalled(); expect(f.exec).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
    processChild.emit("exit", 0, null);
    expect(await pending).toMatchObject({ launchState: CodexGoalLaunchState.Completed });
    expect(f.events).toEqual(["reserve", "receipt", "close"]);
  });
  it("admits an already-owned runtime before its paths and executes the goal in that lifetime", async () => {
    f.role.mockReturnValue("runtime");
    f.admit.mockImplementation(async () => { f.events.push("admit"); });
    f.mkdir.mockImplementation(async () => { f.events.push("mkdir"); });
    await expect(startCodexGoalTmux(input)).resolves.toMatchObject({ launchState: CodexGoalLaunchState.Completed });
    expect(f.events[0]).toBe("admit"); expect(f.run).toHaveBeenCalledWith(input.config);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.exec).not.toHaveBeenCalled();
  });
  it.each(["missing_review", "missing_grant", "stage_mismatch", "stale_generation", "foreign_cgroup"])("denies %s before mutation or submission", async reason => {
    child(); f.launch.mockImplementation(() => { throw new Error(reason); });
    await expect(startCodexGoalTmux(input)).rejects.toThrow(reason);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.mkdir).not.toHaveBeenCalled(); expect(f.exec).not.toHaveBeenCalled();
  });
  it("rejects a different job/workspace before requesting the fixed outer launch", async () => {
    await expect(routeHostedGoalLaunch({ ...input, config: { ...input.config, workspacePath: "/other" } })).rejects.toThrow("identity_mismatch");
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("keeps ordinary launches on their existing path after admission", async () => {
    expect(await routeHostedGoalLaunch({ ...input, config: { ...input.config, sourceEnv: {} } })).toBeUndefined();
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.role).not.toHaveBeenCalled();
  });
  it("closes before forwarding cancellation and refuses a later zero-exit receipt", async () => {
    const processChild = child();
    processChild.kill.mockImplementation(() => { f.events.push("kill"); return true; });
    const pending = runHostedReadonlyForeground("node", [], "/workspace", {});
    process.emit("SIGTERM");
    expect(f.events.slice(-2)).toEqual(["close", "kill"]);
    processChild.emit("exit", 0, null);
    expect(await pending).toBe(70); expect(f.receipt).not.toHaveBeenCalled();
  });
  it.each([1, 70])("retains custody on nonzero wait %s", async code => {
    const processChild = child(); const pending = runHostedReadonlyForeground("node", [], "/workspace", {});
    processChild.emit("exit", code, null);
    expect(await pending).toBe(code); expect(f.receipt).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
});

describe("public direct/tmux CLI ordering with actual parser", () => {
  const argv = ["run", "--registry-root", "/registry", "--job-root", "/job", "--job-id", "TEST", "--task-id", "task",
    "--workspace", "/workspace", "--auth-root", "/auth", "--prompt", "/job/prompt", "--accounts", "synthetic"];
  const io = { cwd: () => "/workspace", env: () => input.config.sourceEnv!, writeStdout: () => {}, writeStderr: () => {} };
  it.each([{ flags: ["--no-tmux"] }, { flags: ["--tmux-session", "foreign"] }])("routes $flags before the parent manifest write", async ({ flags }) => {
    const processChild = child();
    const pending = runCodexGoalCli([...argv, ...flags], io);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.mkdir).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["--registry-root", "/registry"]), "/workspace", expect.any(Function));
    processChild.emit("exit", 0, null);
    expect(await pending).toBe(0);
  });
  it("rejects denied admission before upsert", async () => {
    f.role.mockReturnValue("runtime"); f.admit.mockRejectedValue(new Error("revoked"));
    expect(await runCodexGoalCli([...argv, "--no-tmux"], io)).toBe(2);
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it("inside the owned service, admits then writes then runs", async () => {
    f.role.mockReturnValue("runtime");
    f.admit.mockImplementation(async () => { f.events.push("admit"); });
    f.upsert.mockImplementation(async () => { f.events.push("manifest"); });
    f.run.mockImplementation(async () => { f.events.push("run"); return { status: "completed" }; });
    expect(await runCodexGoalCli([...argv, "--no-tmux"], io)).toBe(0);
    expect(f.events).toEqual(["admit", "manifest", "run"]);
  });
});

// Explicit noninstalled host facts for local-route controls. Hosted cases in
// this transport suite supply their separate synthetic supervisor boundary.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: Parameters<typeof real.lstatSync>[0], options: Parameters<typeof real.lstatSync>[1]) => {
      if (path === "/var/lib/subscription-runtime-host-policy") throw Object.assign(new Error("synthetic absent installation"), { code: "ENOENT" });
      return real.lstatSync(path, options);
    },
    readFileSync: (path: Parameters<typeof real.readFileSync>[0], options: Parameters<typeof real.readFileSync>[1]) =>
      path === "/proc/self/cgroup" ? "0::/user.slice/offline-control.service\n" : real.readFileSync(path, options),
  };
});

// The managed transport fixture has a separately substituted EXCLUSIVE host.
// Actual installation/dispatch composition lives in hosted-ordinary-installation.
vi.mock("../hosted-installation-activation", async original => ({
  ...await original<typeof import("../hosted-installation-activation")>(),
  readHostedInstallationActivation: () => ({ activation: { phase: "EXCLUSIVE" } }),
}));
