import { describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import type { CodexProjectControlBrokerInput } from "../codex-goal-mcp-project-broker";
const native = vi.hoisted(() => ({ launch: vi.fn(), ordinaryAdmission: vi.fn(), ordinaryRoute: vi.fn() }));
vi.mock("../project-mimo-worker-launch", async importOriginal => ({ ...await importOriginal<object>(), launchProjectMimoWorker: native.launch }));
vi.mock("../hosted-readonly-controller-admission", () => ({ admitHostedControllerLaunch: native.ordinaryAdmission }));
vi.mock("../hosted-readonly-goal-launch", async importOriginal => ({ ...await importOriginal<object>(), routeHostedGoalLaunch: native.ordinaryRoute }));
vi.mock("../application/project-control/codex-goal-project-broker-admission", () => ({ createProjectBrokerAdmission: () => ({ gate: { evaluate: async () => ({ allowed: true, reason: "test admission" }) }, creationProof: () => undefined }) }));
vi.mock("../application/project-control/codex-goal-project-admission-target", async importOriginal => ({ ...await importOriginal<object>(), assertAdmissionStoredLaunchIdentity: async () => undefined }));
vi.mock("../application/project-control/codex-goal-consumed-output-ledger-io", async importOriginal => ({ ...await importOriginal<object>(), assertCodexGoalProjectJobNotTerminal: async () => undefined }));
import { createCodexProjectControlBroker } from "../codex-goal-mcp-project-broker";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ordinary project broker MiMo supervisor composition", () => {
  it("routes the original reservation through the real supervisor and returns scheduled", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimo-broker-TEST-"));
    try {
      native.launch.mockResolvedValue({ jobId: "TEST-worker", unit: "TEST-unit", startId: "TEST-start", specSha256: "a".repeat(64) });
      const reservedLaunch = { config: { jobId: "TEST-worker", taskId: "TEST-worker", jobRootDir: join(root,"job"),
        workspacePath: join(root,"workspace"), promptPath: join(root,"job","prompt.md"), authRootDir: join(root,"auth"), accounts: [{ name: "account-q" }],
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }, cwd: root, cliCommand: ["node"], logPath: join(root,"log") } as CodexGoalLaunchInput;
      const broker = createCodexProjectControlBroker({ registryRootDir: join(root,"registry"),
        controller: { jobId: "TEST-controller", jobRootDir: join(root,"controller") },
        scope: { projectId: "TEST-project", workspaceRoots: [root], registryRoot: join(root,"registry"), allowedAccountIds: ["account-q"], jobIdPrefixes: ["TEST-"] },
        startLaunch: reservedLaunch, startManifest: { jobId: "TEST-worker", workspacePath: join(root,"workspace") },
        startWorkspaceLease: { canonicalWorkspacePath: join(root,"workspace") }, admissionDeps: {},
      } as unknown as CodexProjectControlBrokerInput);
      const result = await broker.startWorker({ jobId: "TEST-worker", registryRoot: join(root,"registry"),
        workspacePath: join(root,"workspace"), accounts: ["account-q"] });
      expect(native.launch.mock.calls[0]?.[0].reservedLaunch).toBe(reservedLaunch);
      expect(native.ordinaryAdmission).not.toHaveBeenCalled(); expect(native.ordinaryRoute).not.toHaveBeenCalled();
      expect(result.resourceId).toContain("scheduled:"); expect(result.resourceId).not.toContain("completed:");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
