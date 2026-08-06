import { describe, expect, it } from "vitest";
import { projectControlCreateCodexGoalJobView } from "../codex-goal-mcp-project-control-create-job";
import type { CodexGoalMcpProjectControlJobsDeps } from "../codex-goal-mcp-project-control-jobs";

describe("projectControlCreateCodexGoalJobView", () => {
  it("continues to deny danger-full-access child requests before broker execution", async () => {
    let brokerRequested = false;
    const deps: CodexGoalMcpProjectControlJobsDeps = {
      loadProjectControlController: async () => ({
        registryRootDir: "/tmp/project-control-registry",
        controller: { jobId: "project-controller" } as never,
        scope: { projectId: "project" },
      }),
      codexProjectControlBroker: () => {
        brokerRequested = true;
        throw new Error("broker must not be reached");
      },
    };

    await expect(projectControlCreateCodexGoalJobView({
      allowDangerFullAccess: true,
    }, deps)).rejects.toThrow("project_control_child_danger_full_access_denied");
    expect(brokerRequested).toBe(false);
  });
});
