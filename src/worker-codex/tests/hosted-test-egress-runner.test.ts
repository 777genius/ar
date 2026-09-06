import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { codexGoalAccountSlots, codexGoalRuntimeEventsPath, runCodexGoal } from "../codex-goal-runner";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { codexAuthJsonForAccount, StaticRunner } from "./file-backend-codex-worker-test-support";
import type { HostedTestEgressGrant } from "../hosted-test-egress-contract";
import type { CodexWorkerExecutionEngine } from "../file-backend-codex-runtime-factory";

const files = vi.hoisted(() => ({ read: vi.fn(), operator: vi.fn() }));
vi.mock("../hosted-test-egress-files", () => ({
  hostedTestEgressGrantRoot: "/run/user/0/subscription-runtime-host-policy/codex-egress",
  readHostedTestEgressGrantFile: files.read,
  assertHostedTestEgressOperator: files.operator,
}));

describe("normal runner trusted admission", () => {
  beforeEach(() => { vi.spyOn(process, "getuid").mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("reads once per start, propagates to every rotating account, and re-admits revocation: %s", async selectedProfile => {
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
      files.read.mockResolvedValueOnce(grant).mockResolvedValueOnce(null);
      for (const profileId of [selectedProfile, CodexProviderEgressProfileId.ProviderApi]) {
        await runCodexGoal(config, { createExecutor(options) {
          expect(options.accounts).toHaveLength(2);
          for (const account of options.accounts) {
            expect(account.worker.providerEgressPolicy?.profileId).toBe(profileId);
            expect(Object.isFrozen(account.worker.providerEgressPolicy?.domains)).toBe(true);
          }
          return { async run() {
            // Record removal cannot change the policy already captured by this launch.
            files.read.mockResolvedValue(null);
            expect(options.accounts[0]!.worker.providerEgressPolicy?.profileId).toBe(profileId);
            return { status: "completed", attempts: [], task: { outputText: "offline" } } as never;
          }, async dispose() {} };
        } });
      }
      expect(files.read).toHaveBeenCalledTimes(2);
      expect(files.read.mock.calls[0]?.[0]).toBe("/run/user/0/subscription-runtime-host-policy/codex-egress");
      expect(files.read.mock.calls[0]?.[1]).toMatchObject({ jobId: "exact-job", jobRootDir: config.jobRootDir, workspacePath: config.workspacePath });
      const events = await readFile(codexGoalRuntimeEventsPath(config), "utf8");
      expect(events).toContain(CodexProviderEgressProfileId.ProviderApi);
      expect(events).toContain(selectedProfile);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("retains the admitted profile during a mock safe-executor quota rotation: %s", async selectedProfile => {
    const root = await mkdtemp(join(tmpdir(), "egress-rotation-"));
    const config = { jobId: "rotation", taskId: "rotation", jobRootDir: join(root, "job"),
      workspacePath: join(root, "workspace"), promptPath: join(root, "prompt"),
      authRootDir: join(root, "unused-synthetic-auth"), accounts: codexGoalAccountSlots(["fake-a", "fake-b"]),
      maxAccountCycles: 1,
      sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    };
    const fakes = [new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "You've hit your usage limit" }), new FakeAppServerFactory()];
    const launches: { account: number; profile: string | undefined }[] = [];
    const clock = { now: () => new Date("2026-05-31T00:05:00.000Z"), monotonicMs: () => performance.now() };
    try {
      await mkdir(config.jobRootDir); await mkdir(config.workspacePath); await writeFile(config.promptPath, "Offline rotation");
      files.read.mockResolvedValue({ schemaVersion: 1, jobId: config.jobId, jobRootDir: config.jobRootDir,
        workspacePath: config.workspacePath, profileId: selectedProfile });
      const result = await runCodexGoal(config, { createExecutor: options => new FileBackendCodexSafeExecutor({
        ...options, requireGitWorkspace: false, prewarmOnStart: false, clock,
        accounts: options.accounts.map((account, index) => ({
          codexAuthJson: codexAuthJsonForAccount(`synthetic-refresh-${index}`, `synthetic-account-${index}`),
          worker: { ...account.worker, clock, warmupPrompt: false,
            runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
            appServerProcessFactory: input => {
              launches.push({ account: index, profile: input.env?.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE });
              return fakes[index]!.create(input);
            },
          },
        })),
      }) });
      expect(result.status).toBe("completed");
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("quota_limited");
      expect(new Set(launches.map(launch => launch.account))).toEqual(new Set([0, 1]));
      expect(launches.every(launch => launch.profile === selectedProfile)).toBe(true);
      expect(files.read).toHaveBeenCalledOnce();
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
