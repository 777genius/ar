import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalMcpProjectControlActionsDeps } from "../codex-goal-mcp-project-control-actions";
const locks = vi.hoisted(() => ({ held: false, acquisitions: 0 }));
vi.mock("../codex-goal-project-workspace-lock", () => ({
  projectControlWorkspaceLocks: () => ({}),
  withValidatedProjectWorkspaceLock: async (input: { effect: (workspace: { canonicalWorkspacePath: string }) => Promise<unknown> }) => {
    locks.acquisitions++; locks.held = true;
    try { return await input.effect({ canonicalWorkspacePath: "/TEST-workspace" }); } finally { locks.held = false; }
  },
}));
vi.mock("../codex-goal-mcp-project-scope", () => ({
  projectControlCanonicalWorkspacePath: async () => "/TEST-workspace",
  projectControlRealPathOutsideWorkspaceScope: async () => undefined,
}));
vi.mock("../codex-goal-ops", async importOriginal => ({ ...await importOriginal<object>(),
  collectCodexGoalStatus: async () => ({}), listCodexGoalAccountStatuses: async () => [],
}));
vi.mock("../codex-goal-mcp-brief", () => ({ buildCodexGoalBrief: async () => ({ workerHealth: {} }) }));
vi.mock("../application/project-control/codex-goal-project-stop-policy", () => ({ decideCodexGoalProjectStop: () => ({ allowed: true }) }));
vi.mock("../codex-goal-mcp-lifecycle-markers", () => ({ writeCodexGoalStopEvent: async () => "/TEST-event", writeCodexGoalStoppedProgress: async () => undefined }));
vi.mock("../application/project-control/codex-goal-project-account-reservation", () => ({ releaseCodexProjectAccount: async () => true }));
import { projectControlStopStoredJobView } from "../codex-goal-mcp-project-control-stop";
beforeEach(() => { locks.held = false; locks.acquisitions = 0; });
describe("project stop lock composition", () => {
  for (const { backend, clean } of [{ backend: CodexModelBackend.XiaomiMimoTokenPlan, clean: false },
    { backend: CodexModelBackend.XiaomiMimoTokenPlan, clean: true },
    { backend: CodexModelBackend.OpenAiChatGpt, clean: false }]) {
    it(`hands ${backend} (clean=${clean}) to its expected lock owner`, async () => {
      let heldAtNativeStop: boolean | undefined;
      const deps = {
        loadProjectControlController: async () => ({ registryRootDir: "/TEST-registry", controller: { jobId: "TEST-controller", jobRootDir: "/TEST-controller" }, scope: { projectId: "TEST-project" } }),
        loadJobLaunch: async () => ({ manifest: { jobId: "TEST-job", workspacePath: "/TEST-workspace" },
          launch: { cwd: "/TEST-workspace", config: { taskId: "TEST-task", jobId: "TEST-job", jobRootDir: "/TEST-job", workspacePath: "/TEST-workspace", authRootDir: "/TEST-auth", accounts: [], modelBackend: backend } } }),
        codexProjectControlBroker: () => ({ stopWorker: async () => {
          heldAtNativeStop = locks.held;
          return { status: "applied", evidence: clean ? { cleanWorkspace: "true" } : { handoffPacketPath: "/TEST-packet", handoffManifestSha256: "a".repeat(64) } };
        } }),
      } as unknown as CodexGoalMcpProjectControlActionsDeps;
      await projectControlStopStoredJobView({ jobId: "TEST-job", confirmStop: true }, deps);
      expect(heldAtNativeStop).toBe(backend !== CodexModelBackend.XiaomiMimoTokenPlan);
      expect(locks.acquisitions).toBe(backend === CodexModelBackend.XiaomiMimoTokenPlan ? 0 : 1);
    });
  }
});
