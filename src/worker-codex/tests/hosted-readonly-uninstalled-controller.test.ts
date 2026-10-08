import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import type { Stats } from "node:fs";
import { CodexModelBackend, CodexProviderEgressProfileId, HostedMimoProfile, requiresHostedProcessAdmission } from "@vioxen/subscription-runtime/provider-codex";
import { admitHostedControllerLaunch } from "../hosted-readonly-controller-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { codexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import * as grants from "../hosted-test-egress-files";
import { readonlyIdentityName } from "../hosted-readonly-authority";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";

const io = vi.hoisted(() => ({ lstat: vi.fn(), lstatSync: vi.fn(), statSync: vi.fn(),
  openSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(), readlinkSync: vi.fn(), mkdirSync: vi.fn(),
  rmdirSync: vi.fn(), spawn: vi.fn(), cgroup: "0::/TEST-uninstalled.service\n" }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  lstatSync: io.lstatSync, statSync: io.statSync, openSync: io.openSync,
  fstatSync: io.fstatSync, readFileSync: io.readFileSync, readlinkSync: io.readlinkSync,
  mkdirSync: io.mkdirSync, rmdirSync: io.rmdirSync }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), lstat: io.lstat }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: io.spawn }));

// Keep both admission modules, private readers, classifier and default factory
// real. Remap fixed paths into a disposable Linux filesystem; only ownership
// and process facts are synthetic. The OS spawn boundary never starts a process.
describe.skipIf(process.platform !== "linux")("actual uninstalled controller composition", () => {
  let real: typeof import("node:fs");
  let root: string;
  let launch: CodexGoalLaunchInput;
  let sourceEnv: Record<string, string | undefined>;
  const volatile = "/run/user/0/subscription-runtime-host-policy";
  const permanent = "/var/lib/subscription-runtime-host-policy";
  const mapped = (path: string): string => path === "/" ? root :
    /^\/(?:run|var)(?:\/|$)/.test(path) ? root + path : path;
  const owner = (stat: Stats): Stats => Object.assign(stat, { uid: 0 });
  beforeEach(async () => {
    vi.resetAllMocks();
    real = await vi.importActual<typeof import("node:fs")>("node:fs");
    root = real.mkdtempSync(tmpdir() + "/TEST-uninstalled-controller-");
    for (const path of ["/run", "/run/user", "/run/user/0", "/var", "/var/lib"]) {
      real.mkdirSync(mapped(path), { mode: path === "/run/user/0" ? 0o700 : 0o755 });
    }
    vi.spyOn(process, "getuid").mockReturnValue(0);
    io.cgroup = "0::/TEST-uninstalled.service\n";
    io.lstatSync.mockImplementation((path: string) => owner(real.lstatSync(mapped(path))));
    io.lstat.mockImplementation(async (path: string) => owner(real.lstatSync(mapped(path))));
    io.statSync.mockImplementation((path: string) => owner(real.statSync(mapped(path))));
    io.openSync.mockImplementation((path: string, flags: number) => real.openSync(mapped(path), flags));
    io.fstatSync.mockImplementation((fd: number) => owner(real.fstatSync(fd)));
    io.mkdirSync.mockImplementation((path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(mapped(path), options));
    io.rmdirSync.mockImplementation((path: string) => real.rmdirSync(mapped(path)));
    io.readlinkSync.mockImplementation((path: string) => /^\/proc\/(?:self|1)\/ns\//.test(path) ? path.split("/").at(-1)! : real.readlinkSync(mapped(path)));
    io.readFileSync.mockImplementation((path: string, options: Parameters<typeof real.readFileSync>[1]) => {
      if (path === "/proc/self/cgroup") return io.cgroup;
      if (path === "/proc/self/uid_map") return "0 0 4294967295\n";
      if (path === "/proc/sys/kernel/random/boot_id") return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n";
      return real.readFileSync(mapped(path), options);
    });
    sourceEnv = {};
    launch = { cwd: root, logPath: root + "/log", cliCommand: ["TEST-no-execution"], config: {
      jobId: "TEST-uninstalled", taskId: "TEST-uninstalled", jobRootDir: root + "/job", workspacePath: root + "/workspace",
      authRootDir: root + "/auth", promptPath: root + "/prompt", accounts: [{ name: "TEST-unused" }], sourceEnv,
    } };
  });
  afterEach(() => { vi.restoreAllMocks(); real.rmSync(root, { recursive: true, force: true }); });
  it("admits API-only ordinary execution with real absent parents and no authority writes", async () => {
    expect(requiresHostedProcessAdmission({})).toBe(false);
    const admitted = await admitHostedControllerLaunch(launch);
    expect(admitted.policy.profileId).toBe(CodexProviderEgressProfileId.ProviderApi);
    expect(admitted.policy.domains).toEqual(["api.openai.com"]);
    const child = { stdin: { write: vi.fn() } };
    io.spawn.mockReturnValue(child);
    const home = root + "/job/home/codex";
    expect(admitted.processFactory({ command: "TEST-codex", args: ["app-server"], cwd: launch.config.workspacePath,
      env: { CODEX_HOME: home } })).toBe(child);
    expect(io.spawn).toHaveBeenCalledExactlyOnceWith("TEST-codex", expect.arrayContaining(["features.network_proxy.enabled=true"]),
      expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: home,
        SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: CodexProviderEgressProfileId.ProviderApi }), stdio: ["pipe", "pipe", "pipe"] }));
    expect(real.readdirSync(mapped("/run/user/0"))).toEqual([]);
    expect(real.readdirSync(mapped("/var/lib"))).toEqual([]);
  });
  it.each(["marker", "cgroup", "permanent-empty", "volatile-only", "custody", "revoked"])(
    "retains refusal before provider effects for %s", async kind => {
      if (kind === "marker") sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND = "hosted-codex-job";
      if (kind === "cgroup") io.cgroup = "0::/subscription-runtime-hosted-TEST.service\n";
      if (kind === "permanent-empty") real.mkdirSync(mapped(permanent), { mode: 0o700 });
      if (kind === "volatile-only") real.mkdirSync(mapped(volatile), { mode: 0o700 });
      if (kind === "custody" || kind === "revoked") {
        const directory = mapped(permanent + "/codex-readonly-" + kind);
        real.mkdirSync(directory, { recursive: true, mode: 0o700 });
        // Both durable reader parents exist; a retained record survives loss of volatile policy.
        real.mkdirSync(mapped(permanent + "/codex-readonly-" + (kind === "custody" ? "revoked" : "custody")), { mode: 0o700 });
        real.writeFileSync(directory + "/" + readonlyIdentityName("TEST-uninstalled"), "{}", { mode: 0o600 });
      }
      await expect(admitHostedControllerLaunch(launch)).rejects.toThrow("hosted_readonly_");
      expect(io.spawn).not.toHaveBeenCalled();
    });
  it("requires strict readonly admission for a managed profile even with both bases absent", () => {
    expect(() => admitHostedReadonlyInputs({ jobId: "TEST-uninstalled", jobRootDir: root + "/job",
      workspacePath: root + "/workspace", sourceEnv: {},
      providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification) })).toThrow("hosted_readonly_");
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each([CodexProviderEgressProfileId.TestManagedQualification, CodexProviderEgressProfileId.PublicResearchV1,
    CodexProviderEgressProfileId.MimoTokenPlan] as const)("keeps standalone grant checks for %s", async profileId => {
    const identity = { jobId: "TEST-uninstalled", jobRootDir: root + "/job", workspacePath: root + "/workspace" };
    vi.spyOn(grants, "readHostedTestEgressGrantFile").mockResolvedValue(profileId === CodexProviderEgressProfileId.MimoTokenPlan ?
      { ...identity, schemaVersion: 2, profileId, accountId: "account-q", hostedProfile: HostedMimoProfile.Controller,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, executionEngine: "app-server-goal", namedPermissions: true,
        globalScanGuard: true, nativeToolSurface: "disabled" } : { ...identity, schemaVersion: 1, profileId });
    await expect(admitHostedControllerLaunch(launch)).rejects.toThrow(profileId === CodexProviderEgressProfileId.PublicResearchV1 ?
      "hosted_research_ordinary_admission_required" : profileId === CodexProviderEgressProfileId.MimoTokenPlan ?
        "hosted_mimo_admission_invalid" : "hosted_readonly_");
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it("rechecks required-hosted after grant await and refuses a newly appearing root at default spawn", async () => {
    const admitted = await admitHostedControllerLaunch(launch);
    real.mkdirSync(mapped(permanent), { mode: 0o700 });
    expect(() => admitted.processFactory({ command: "TEST-codex", args: [], cwd: root, env: {} })).toThrow("hosted_activation_evidence_invalid");
    expect(io.spawn).not.toHaveBeenCalled();
    real.rmdirSync(mapped(permanent));
    vi.spyOn(grants, "readHostedTestEgressGrantFile").mockImplementation(async () => {
      sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND = "hosted-codex-job";
      return null;
    });
    await expect(admitHostedControllerLaunch(launch)).rejects.toThrow("hosted_readonly_");
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each(["symlink", "writable", "anchor-replaced"])("denies real filesystem %s before provider effects", async unsafe => {
    if (unsafe === "symlink") real.symlinkSync(root + "/TEST-missing", mapped(volatile));
    if (unsafe === "writable") real.chmodSync(mapped("/run/user/0"), 0o777);
    if (unsafe === "anchor-replaced") {
      let moved = false;
      io.lstatSync.mockImplementation((path: string) => {
        if (!moved && /^\/proc\/self\/fd\/[0-9]+\/subscription-runtime-host-policy$/.test(path)) {
          moved = true;
          real.renameSync(mapped("/run/user/0"), root + "/TEST-retained-anchor");
          real.mkdirSync(mapped("/run/user/0"), { mode: 0o700 });
        }
        return owner(real.lstatSync(mapped(path)));
      });
    }
    await expect(admitHostedControllerLaunch(launch)).rejects.toThrow("hosted_");
    expect(io.spawn).not.toHaveBeenCalled();
  });
});
