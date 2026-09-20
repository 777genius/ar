import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";
import type { HostedTestEgressGrant } from "../hosted-test-egress-contract";
import type { CodexWorkerExecutionEngine } from "../file-backend-codex-runtime-factory";

const files = vi.hoisted(() => ({ read: vi.fn(), operator: vi.fn() }));
vi.mock("../hosted-test-egress-files", () => ({
  hostedTestEgressGrantRoot: "/run/user/0/subscription-runtime-host-policy/codex-egress",
  readHostedTestEgressGrantFile: files.read,
  assertHostedTestEgressOperator: files.operator,
}));

// Grant-only transport fixtures have no installed ordinary origin or managed
// custody. Real ordinary runner/default-factory quota rotation is composed in
// hosted-ordinary-installation.test.ts with private record and OS fixtures.
vi.mock("../hosted-readonly-supervisor-host", () => ({
  HostedReadonlySupervisorHost: class { assertManagedAdmission() {} },
}));

// These egress fixtures contain no root-approved readonly records. Do not inspect
// the host's real policy filesystem while testing synthetic egress identities.
vi.mock("../hosted-readonly-inputs", async importOriginal => ({
  ...await importOriginal<typeof import("../hosted-readonly-inputs")>(),
  readHostedReadonlyPolicy: () => null,
  readHostedPrivateBytes: () => null,
}));

describe("normal runner trusted admission", () => {
  beforeEach(() => { vi.spyOn(process, "getuid").mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("grant-only runner refuses before executor creation without installed origin/custody: %s", async selectedProfile => {
    const root = await mkdtemp(join(tmpdir(), "egress-runner-"));
    const config = {
      jobId: "exact-job", taskId: "task-label", jobRootDir: join(root, "job"),
      workspacePath: join(root, "workspace"), promptPath: join(root, "prompt"),
      authRootDir: join(root, "unused-synthetic-auth"), accounts: codexGoalAccountSlots(["fake-a", "fake-b"]),
      sourceEnv: { SUBSCRIPTION_RUNTIME_CODEX_EGRESS_GRANT_ROOT: join(root, "untrusted-authority"),
        SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
        SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: selectedProfile },
    };
    const grant: HostedTestEgressGrant = { schemaVersion: 1, jobId: config.jobId,
      jobRootDir: config.jobRootDir, workspacePath: config.workspacePath,
      profileId: selectedProfile };
    try {
      await mkdir(config.jobRootDir); await mkdir(config.workspacePath);
      await writeFile(config.promptPath, "Offline synthetic task");
      files.read.mockResolvedValue(grant);
      const createExecutor = vi.fn();
      await expect(runCodexGoal(config, { createExecutor })).rejects.toThrow(/hosted_(readonly|activation)_/);
      expect(createExecutor).not.toHaveBeenCalled();
      expect(files.read.mock.calls[0]?.[0]).toBe("/run/user/0/subscription-runtime-host-policy/codex-egress");
      expect(files.read.mock.calls[0]?.[1]).toMatchObject({ jobId: "exact-job", jobRootDir: config.jobRootDir, workspacePath: config.workspacePath });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("deleting the grant cannot turn an unadmitted hosted runner into ordinary API: %s", async selectedProfile => {
    const root = await mkdtemp(join(tmpdir(), "egress-rotation-"));
    const config = { jobId: "rotation", taskId: "rotation", jobRootDir: join(root, "job"),
      workspacePath: join(root, "workspace"), promptPath: join(root, "prompt"),
      authRootDir: join(root, "unused-synthetic-auth"), accounts: codexGoalAccountSlots(["fake-a", "fake-b"]),
      maxAccountCycles: 1,
      sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    };
    try {
      await mkdir(config.jobRootDir); await mkdir(config.workspacePath); await writeFile(config.promptPath, "Offline rotation");
      files.read.mockResolvedValue({ schemaVersion: 1, jobId: config.jobId, jobRootDir: config.jobRootDir,
        workspacePath: config.workspacePath, profileId: selectedProfile });
      const createExecutor = vi.fn();
      await expect(runCodexGoal(config, { createExecutor })).rejects.toThrow(/hosted_(readonly|activation)_/);
      files.read.mockResolvedValue(null);
      await expect(runCodexGoal(config, { createExecutor })).rejects.toThrow("hosted_activation_authority_required");
      expect(createExecutor).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["plain-exec", "packaged-exec", "app-server", "unknown"])("refuses %s before prompt/account/executor work", async executionEngine => {
    files.read.mockResolvedValue({ profileId: CodexProviderEgressProfileId.TestNpmQualification });
    const createExecutor = vi.fn();
    await expect(runCodexGoal({
      taskId: "test", jobRootDir: "/synthetic/job", workspacePath: "/synthetic/workspace",
      promptPath: "/synthetic/must-not-read", authRootDir: "/synthetic/must-not-read",
      accounts: codexGoalAccountSlots(["fake"]), executionEngine: executionEngine as CodexWorkerExecutionEngine,
      sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    }, { createExecutor })).rejects.toThrow();
    expect(createExecutor).not.toHaveBeenCalled();
  });
  it("sanitizes invalid authority errors before prompt work", async () => {
    files.read.mockRejectedValue(new Error("private fixture details"));
    await expect(runCodexGoal({
      taskId: "test", jobRootDir: "/synthetic/job", workspacePath: "/synthetic/workspace",
      promptPath: "/synthetic/must-not-read", authRootDir: "/synthetic/must-not-read",
      accounts: codexGoalAccountSlots(["fake"]),
    })).rejects.toThrow("hosted_test_egress_admission_invalid");
  });
});
