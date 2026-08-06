import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexProviderApiAndNpmRegistryEgressProfileId,
  codexProviderApiEgressProfileId,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalTaskEgressProfile,
  type CodexGoalTaskEgressProfileInput,
} from "../codex-goal-task-egress-profile";
import {
  buildCodexGoalExecutorOptions,
  codexGoalAccountSlots,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";

describe("codex goal task egress profile", () => {
  it("selects npm-registry egress only for brokered isolated restricted project children", () => {
    const root = "/tmp/subscription-runtime-goal-egress";
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath: join(root, "prompt.md"),
      taskId: "task-egress",
      accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: {
        projectId: "infinity-context",
        isolatedWorkspaceRoot: join(root, "workspace"),
        workspaceRoots: [join(root, "workspace")],
      },
      sourceEnv: {
        SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START: "1",
      },
    };

    expect(codexGoalTaskEgressProfile(config)).toBe(
      codexProviderApiAndNpmRegistryEgressProfileId,
    );
    expect(buildCodexGoalExecutorOptions({
      config,
      stateRootDir: join(root, "state"),
      encryptionKey: new Uint8Array(32).fill(1),
    }).accounts[0]?.worker.egressProfile).toBe(
      codexProviderApiAndNpmRegistryEgressProfileId,
    );

    const { projectAccessScope: _projectAccessScope, ...withoutScope } = config;
    const nonBrokeredCandidates: readonly CodexGoalTaskEgressProfileInput[] = [
      { ...config, sourceEnv: {} },
      {
        ...config,
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START: "not-a-brokered-start",
        },
      },
      { ...config, accessBoundary: AccessBoundary.ReadOnly },
      { ...config, accessBoundary: AccessBoundary.DangerFullAccess },
      { ...config, networkAccess: NetworkAccessMode.Disabled },
      withoutScope,
    ];
    for (const candidate of nonBrokeredCandidates) {
      expect(codexGoalTaskEgressProfile(candidate)).toBe(
        codexProviderApiEgressProfileId,
      );
    }
  });
});
