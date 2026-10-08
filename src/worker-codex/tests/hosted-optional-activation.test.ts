import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedActivationMode, assertHostedBaselineIdentity, isHostedContainment, readHostedActivationMode } from
  "../../provider-codex/app-server/adapters/hosted-host-policy";
import { spawnCodexAppServerProcess } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { requiresHostedProcessAdmission } from "@vioxen/subscription-runtime/provider-codex";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { isHostedGoalLaunch, routeHostedGoalLaunch } from "../hosted-readonly-goal-launch";
import { codexGoalStatusInputFromLaunch } from "../application/codex-goal-status-input";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";

// Real disposable records, directory handles and no-follow reads. Only fixed
// host paths/principal and one cgroup fact are projected; effects are captured.
const f = vi.hoisted(() => ({ root: "", group: "0::/user.slice/TEST.service\n", spawn: vi.fn(),
  denyPrivate: false, privateReads: 0, drift: false }));
const mode = "/etc/subscription-runtime/host-activation-mode";
const policy = "/var/lib/subscription-runtime-host-policy";
function local(path: string): string {
  return path.startsWith("/proc/") ? path : path === "/" ? f.root : join(f.root, path);
}
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const check = (path: string) => {
    if (path.startsWith("/run/user/0/")) {
      f.privateReads++;
      if (f.denyPrivate) throw Object.assign(new Error("TEST inaccessible private root"), { code: "EACCES" });
    }
  };
  return { ...fs,
    lstatSync: (path: string) => { check(path); return Object.assign(fs.lstatSync(local(path)), { uid: 0 }); },
    openSync: (path: string, flags: number, permissions?: number) => {
      check(path); return fs.openSync(local(path), flags, permissions);
    },
    fstatSync: (fd: number) => {
      const stat = fs.fstatSync(fd);
      return Object.assign(stat, { uid: 0, ctimeMs: stat.ctimeMs + (f.drift ? 1 : 0) });
    },
    readFileSync: (path: Parameters<typeof fs.readFileSync>[0], options: Parameters<typeof fs.readFileSync>[1]) =>
      path === "/proc/self/cgroup" ? f.group : fs.readFileSync(typeof path === "string" ? local(path) : path, options),
  };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
function put(path: string, bytes = "retained TEST authority\n", permissions = 0o600): void {
  mkdirSync(dirname(local(path)), { recursive: true, mode: 0o700 });
  writeFileSync(local(path), bytes, { mode: permissions });
}
const identity = { jobId: "TEST-optional", jobRootDir: "/TEST/jobs/TEST-optional", workspacePath: "/TEST/jobs/TEST-optional/workspace" };
const input = { cwd: identity.workspacePath, command: "/TEST/codex", args: ["app-server"],
  env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: identity.jobId } };
const name = createHash("sha256").update(identity.jobId).digest("hex") + ".json";
beforeEach(() => {
  f.root = mkdtempSync(join(tmpdir(), "host-optional-TEST-"));
  f.group = "0::/user.slice/TEST.service\n"; f.denyPrivate = false; f.privateReads = 0; f.drift = false;
  f.spawn.mockReset(); f.spawn.mockReturnValue({ stdin: { write: vi.fn() } });
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.stubEnv("SUBSCRIPTION_RUNTIME_SANDBOX_KIND", "");
});
afterEach(() => { rmSync(f.root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("optional host activation with real records and projected Host principal", () => {
  it("defaults off with real missing policy parents and launches the installed wrapper", () => {
    expect(readHostedActivationMode()).toBe(HostedActivationMode.Disabled);
    expect(requiresHostedProcessAdmission(input.env)).toBe(false);
    spawnCodexAppServerProcess(input);
    const [command, args, options] = f.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe("/opt/subscription-runtime/managed-launcher/launch.mjs");
    expect(args).not.toContain("--fd-ready-v1");
    expect(JSON.parse(args[2])).toMatchObject({ operation: "provider", jobId: identity.jobId });
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });
  it("inventory alone cannot enroll activation or require a final-release FD gate", () => {
    put(policy + "/readonly-inventory.json", '{"schemaVersion":4}\n');
    expect(isHostedContainment({})).toBe(false);
    spawnCodexAppServerProcess(input);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]![1].join(" ")).not.toContain("--fd-ready-v1");
  });
  it("cannot disable an opted-in Host with environment or marker stripping", () => {
    put(mode, "required\n");
    put(policy + "/readonly-inventory.json", "{}\n");
    vi.stubEnv("SUBSCRIPTION_RUNTIME_HOST_ACTIVATION_MODE", "disabled");
    expect(readHostedActivationMode()).toBe(HostedActivationMode.Required);
    expect(requiresHostedProcessAdmission({})).toBe(true);
    expect(() => spawnCodexAppServerProcess({ ...input, env: {} })).toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(["required", "disabled\n", " required\n", "required\n\n", ""])("rejects an existing invalid mode %j before effects", bytes => {
    put(mode, bytes);
    expect(() => spawnCodexAppServerProcess(input)).toThrow("hosted_activation_mode_invalid");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("retains strict actual ordinary origin even when the mode file is absent", () => {
    f.group = "0::/subscription.slice/subscription-runtime-ordinary-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service\n";
    expect(requiresHostedProcessAdmission({})).toBe(true);
    expect(() => spawnCodexAppServerProcess({ ...input, env: {} })).toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(["host-installation.json", "host-activation.json", "host-activation.next", "ordinary-origins.json", "ordinary-origins.next",
    "readonly-enrollment.json", "readonly-epoch.json", "readonly-epoch.next",
    "codex-readonly-custody/" + name, "codex-readonly-revoked/" + name, "ordinary-origins/" + name,
    "dependency-bindings/" + name])("retained %s cannot fall back after volatile grant loss", path => {
    put(policy + "/" + path);
    expect(() => assertHostedBaselineIdentity(identity.jobId)).toThrow("managed_grant_required");
    expect(() => spawnCodexAppServerProcess(input)).toThrow("managed_grant_required");
    expect(() => spawnCodexAppServerProcess({ ...input, env: { SUBSCRIPTION_RUNTIME_JOB_ID: identity.jobId } }))
      .toThrow("managed_grant_required");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("rejects interrupted global installation before an unmarked raw spawn with no job identity", () => {
    put(policy + "/host-installation.json", "partial TEST bytes");
    expect(() => spawnCodexAppServerProcess({ ...input, env: {} })).toThrow("managed_grant_required");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(["codex-egress", "codex-readonly"])("explicit volatile %s authority cannot fall back", directory => {
    put("/run/user/0/subscription-runtime-host-policy/" + directory + "/" + name);
    expect(() => spawnCodexAppServerProcess(input)).toThrow("managed_grant_required");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("rejects unsafe missing ancestry, aliases, hardlinks and drift", () => {
    mkdirSync(local("/etc"), { mode: 0o777 });
    chmodSync(local("/etc"), 0o777);
    expect(readHostedActivationMode).toThrow("invalid");
    chmodSync(local("/etc"), 0o700); put(mode, "required\n");
    linkSync(local(mode), local(mode) + ".alias");
    expect(readHostedActivationMode).toThrow("invalid");
    rmSync(local(mode)); symlinkSync(local(mode) + ".alias", local(mode));
    expect(readHostedActivationMode).toThrow("invalid");
    rmSync(local(mode)); rmSync(local(mode) + ".alias"); put(mode, "required\n");
    f.drift = true; expect(readHostedActivationMode).toThrow("invalid");
  });
  it("rejects EACCES as uncertainty while preserving the uncontained non-root local path", async () => {
    f.denyPrivate = true;
    put("/run/user/0/subscription-runtime-host-policy/placeholder", "");
    await expect(admitHostedTestEgress({ ...identity, sourceEnv: input.env })).rejects.toThrow("invalid");
    f.privateReads = 0; vi.spyOn(process, "getuid").mockReturnValue(1000);
    const localPolicy = await admitHostedTestEgress({ ...identity, sourceEnv: {} });
    expect(localPolicy.profileId).toBe("codex-provider-api");
    expect(admitHostedReadonlyInputs({ ...identity, sourceEnv: {}, providerEgressPolicy: localPolicy })).toBeUndefined();
    expect(f.privateReads).toBe(0);
  });
  it("uses full Internet and foreground status for a default-off contained job", async () => {
    const sourceEnv = input.env;
    const policy = await admitHostedTestEgress({ ...identity, sourceEnv });
    expect(policy.profileId).toBe("codex-full-internet-v1");
    expect(admitHostedReadonlyInputs({ ...identity, sourceEnv, providerEgressPolicy: policy })).toBeUndefined();
    const launch = { config: { ...identity, taskId: identity.jobId, authRootDir: "/TEST/auth",
      promptPath: "/TEST/prompt", accounts: [{ name: "TEST-account" }], sourceEnv },
      cliCommand: ["/TEST/node", "/TEST/cli"], cwd: identity.workspacePath, logPath: "/TEST/log", tmuxSession: "foreign" };
    expect(isHostedGoalLaunch(launch)).toBe(true);
    expect(await routeHostedGoalLaunch(launch)).toBeUndefined();
    expect(codexGoalStatusInputFromLaunch(launch)).not.toHaveProperty("tmuxSession");
    const options = buildCodexGoalExecutorOptions({ config: launch.config, stateRootDir: "/TEST/state", encryptionKey: new Uint8Array(32) });
    expect(options.accounts[0]!.worker.sourceEnv).toMatchObject({ SUBSCRIPTION_RUNTIME_JOB_ID: identity.jobId });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("preserves an unmarked native job's accepted project boundary and source environment", () => {
    const sourceEnv = { PATH: "/TEST/bin" };
    const config = { ...identity, taskId: identity.jobId, authRootDir: "/TEST/auth",
      promptPath: "/TEST/prompt", accounts: [{ name: "TEST-account" }], sourceEnv,
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      projectAccessScope: { projectId: "TEST-native", readRoots: [identity.workspacePath], isolatedWorkspaceRoot: identity.workspacePath } };
    const options = buildCodexGoalExecutorOptions({ config, stateRootDir: "/TEST/state", encryptionKey: new Uint8Array(32) });
    expect(options.accounts[0]!.worker.sourceEnv).toBe(sourceEnv);
    expect(options.accounts[0]!.worker.enforceProjectReadBoundary).toBe(true);
    expect(options.accounts[0]!.worker.sourceEnv).not.toHaveProperty("SUBSCRIPTION_RUNTIME_SANDBOX_KIND");
    expect(options.accounts[0]!.worker.sourceEnv).not.toHaveProperty("SUBSCRIPTION_RUNTIME_JOB_ID");
  });
  it("rejects forged tickets and mount/reservation claims in default-off mode", () => {
    for (const effect of [() => spawnCodexAppServerProcess(input, undefined, undefined, {}),
      () => spawnCodexAppServerProcess(input, undefined, "subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service"),
      () => spawnCodexAppServerProcess(input, { jobId: identity.jobId, workspacePath: input.cwd, readonlyPaths: [input.cwd + "/source"] })]) {
      expect(effect).toThrow("synchronous_fence_required");
    }
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
