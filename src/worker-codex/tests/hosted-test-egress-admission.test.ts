import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressGrant } from "../hosted-test-egress-contract";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { canonicalHostedTestIdentity, hostedTestEgressGrantRoot, writeHostedTestEgressGrant } from "../hosted-test-egress-files";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";

const fs = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn(), readFile: vi.fn(), readlink: vi.fn(), privateBytes: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), ...fs,
}));
const directory = (uid = 0, mode = 0o755, symlink = false) => ({
  uid, mode, isDirectory: () => !symlink, isSymbolicLink: () => symlink,
});
const identity = { jobId: "synthetic", jobRootDir: "/TEST/jobs/job", workspacePath: "/TEST/workspaces/workspace" };
const input = { ...identity, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } };
const grant: HostedTestEgressGrant = { schemaVersion: 1, ...identity, profileId: CodexProviderEgressProfileId.TestNpmQualification };

// Isolated egress transport tests: synthetic host permission only. The actual
// exclusive TEST supervisor denies ordinary profiles; its gate is tested separately.
vi.mock("../hosted-readonly-supervisor-host", () => ({
  HostedReadonlySupervisorHost: class { assertManagedAdmission() {} },
}));

// These egress fixtures contain no root-approved readonly records. Do not inspect
// the host's real policy filesystem while testing synthetic egress identities.
vi.mock("../hosted-readonly-inputs", async importOriginal => ({
  ...await importOriginal<typeof import("../hosted-readonly-inputs")>(),
  readHostedReadonlyPolicy: () => null,
  readHostedPrivateBytes: fs.privateBytes,
}));

describe("finite admission eligibility and identity ancestor custody (synthetic host)", () => {
  beforeEach(async () => {
    fs.privateBytes.mockReturnValue(null);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "getuid").mockReturnValue(0);
    fs.lstat.mockImplementation(async (path: string) => directory(0, path.startsWith("/run") ? 0o700 : 0o755));
    fs.readlink.mockImplementation(async (path: string) => path.split("/").at(-1));
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fs.readFile.mockImplementation((path: string, ...args: unknown[]) => path === "/proc/self/uid_map"
      ? Promise.resolve("0 0 4294967295\n") : Reflect.apply(real.readFile, real, [path, ...args]));
    fs.open.mockResolvedValue({ stat: async () => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o600, size: 200 }),
      readFile: async () => JSON.stringify(grant), close: vi.fn() });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

  it.each([false, true])("non-root Linux keeps API-only policy without private authority reads; spoofed TEST env=%s", async spoof => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    fs.lstat.mockRejectedValue(Object.assign(new Error("EACCES /synthetic/private-parent"), { code: "EACCES" }));
    const policy = await admitHostedTestEgress({ ...input, sourceEnv: spoof ? { ...input.sourceEnv,
      SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: CodexProviderEgressProfileId.TestNpmQualification } : {} });
    expect(policy.profileId).toBe(CodexProviderEgressProfileId.ProviderApi);
    expect(policy.domains).toEqual(["api.openai.com"]);
    expect(fs.lstat).not.toHaveBeenCalled(); expect(fs.open).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it.each(["EACCES", "EIO", "ENOTDIR"])("rejects trusted-host %s instead of treating it as absence; sanitizes the diagnostic", async code => {
    fs.lstat.mockRejectedValue(Object.assign(new Error("PRIVATE_SENTINEL"), { code }));
    await expect(admitHostedTestEgress(input)).rejects.toEqual(new Error("hosted_test_egress_admission_invalid"));
  });
  it("defaults trusted absence but refuses existing malformed and mismatched grants", async () => {
    fs.open.mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" }));
    expect((await admitHostedTestEgress(input)).profileId).toBe(CodexProviderEgressProfileId.ProviderApi);
    for (const contents of ["PRIVATE_SENTINEL{", JSON.stringify({ ...grant, workspacePath: "/different" })]) {
      fs.open.mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o600, size: 200 }),
        readFile: async () => contents, close: vi.fn() });
      await expect(admitHostedTestEgress(input)).rejects.toEqual(new Error("hosted_test_egress_admission_invalid"));
    }
  });
  it.each(["codex-readonly-custody", "codex-readonly-revoked"])(
    "rejects absent volatile grant before API fallback when durable %s survives", async kind => {
      fs.open.mockRejectedValue(Object.assign(new Error(), { code: "ENOENT" }));
      fs.privateBytes.mockImplementation((path: string) =>
        path.startsWith(`/var/lib/subscription-runtime-host-policy/${kind}/`) ? Buffer.from("{}") : null);
      await expect(admitHostedTestEgress(input)).rejects.toThrow(
        kind.endsWith("revoked") ? "hosted_readonly_revoked" : "hosted_readonly_managed_grant_required");
      const createExecutor = vi.fn();
      await expect(runCodexGoal({ ...input, taskId: "synthetic", promptPath: "/TEST/must-not-read",
        authRootDir: "/TEST/unused", accounts: codexGoalAccountSlots(["fake"]) }, { createExecutor }))
        .rejects.toThrow("hosted_readonly_");
      expect(createExecutor).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalledWith("/TEST/must-not-read", "utf8");
    });
  it.each(["/", "/TEST", "/TEST/jobs", identity.jobRootDir, "/TEST/workspaces", identity.workspacePath])(
    "requires trusted ownership, non-writable mode and no symlink at %s for publication and admission", async unsafePath => {
      for (const unsafe of [directory(1000), directory(0, 0o775), directory(0, 0o757), directory(0, 0o755, true)]) {
        fs.lstat.mockImplementation(async (path: string) => path === unsafePath ? unsafe : directory(0, 0o700));
        await expect(writeHostedTestEgressGrant(grant)).rejects.toThrow("custody_invalid");
        expect(fs.open).not.toHaveBeenCalled(); // Rejection precedes publication.
        await expect(admitHostedTestEgress(input)).rejects.toEqual(new Error("hosted_test_egress_admission_invalid"));
        fs.open.mockClear();
      }
    });
  it("rejects identity beneath the writable workspace, which could let a hosted command rename the job root", async () => {
    await expect(canonicalHostedTestIdentity({ ...identity, jobRootDir: identity.workspacePath + "/job" }))
      .rejects.toThrow("identity_invalid");
  });
  it("rejects the rename-capable parent before an intermediate symlink swap can be followed", async () => {
    // Review precondition: actor can rename /TEST/workspaces because /TEST is writable.
    // A lstat of the final workspace would follow the intermediate replacement.
    let swapped = false;
    fs.lstat.mockImplementation(async (path: string) => {
      if (path === "/TEST") { swapped = true; return directory(0, 0o777); }
      if (path === "/TEST/workspaces") return directory(0, 0o755, swapped);
      return directory(0, 0o700);
    });
    await expect(admitHostedTestEgress(input)).rejects.toThrow("admission_invalid");
    expect(swapped).toBe(true);
    expect(fs.lstat).not.toHaveBeenCalledWith(identity.workspacePath);
    // Even if the swap completed before admission, a symlink intermediate is refused.
    fs.lstat.mockImplementation(async (path: string) => directory(0, 0o700, path === "/TEST/workspaces"));
    await expect(admitHostedTestEgress(input)).rejects.toThrow("admission_invalid");
  });
  it("stops the actual runner before prompt or launch when an actor can rename an identity ancestor", async () => {
    fs.lstat.mockImplementation(async (path: string) => directory(0, path === "/TEST/workspaces" ? 0o777 : 0o700));
    const createExecutor = vi.fn();
    await expect(runCodexGoal({ ...input, taskId: "synthetic", promptPath: "/TEST/must-not-read",
      authRootDir: "/TEST/unused", accounts: codexGoalAccountSlots(["fake"]) }, { createExecutor }))
      .rejects.toThrow("admission_invalid");
    expect(createExecutor).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalledWith("/TEST/must-not-read", "utf8");
  });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("a grant alone cannot start the runner without installed origin/material: %s", async profileId => {
    // UID/mode metadata is synthetic; this is not a kernel or deployed namespace test.
    const inspected = new Map<string, ReturnType<typeof directory>>();
    fs.lstat.mockImplementation(async (path: string) => {
      const stat = directory(0, path.startsWith("/run") ? 0o700 : 0o755);
      inspected.set(path, stat); return stat;
    });
    const root = await mkdtemp(join(tmpdir(), "TEST-custody-launch-"));
    const config = { jobId: "synthetic", taskId: "synthetic", jobRootDir: join(root, "job"),
      workspacePath: join(root, "workspace"), promptPath: join(root, "prompt"),
      authRootDir: join(root, "unused"), accounts: codexGoalAccountSlots(["fake"]), sourceEnv: input.sourceEnv };
    try {
      await mkdir(config.jobRootDir); await mkdir(config.workspacePath); await writeFile(config.promptPath, "offline");
      const file = await fs.open();
      file.readFile = async () => JSON.stringify({ ...grant, profileId, jobRootDir: config.jobRootDir, workspacePath: config.workspacePath });
      const createExecutor = vi.fn();
      await expect(runCodexGoal(config, { createExecutor })).rejects.toThrow(
        profileId === CodexProviderEgressProfileId.TestManagedQualification ? /hosted_readonly_/ : /hosted_activation_authority_required/);
      expect(createExecutor).not.toHaveBeenCalled();
      // The egress reader still inspected every identity ancestor before the
      // independent origin/material gate rejected this deliberately incomplete fixture.
      for (const identityPath of [config.jobRootDir, config.workspacePath]) {
        for (let parent = dirname(identityPath); ; parent = dirname(parent)) {
          expect(fs.lstat.mock.calls.some(call => call[0] === parent)).toBe(true);
          const stat = inspected.get(parent)!;
          expect(stat.uid).toBe(0); expect(stat.mode & 0o022).toBe(0);
          expect(stat.isSymbolicLink()).toBe(false);
          expect(parent.startsWith(hostedTestEgressGrantRoot)).toBe(false);
          if (parent === "/") break;
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
