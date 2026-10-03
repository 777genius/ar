import { describe, expect, it } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedMimoGoalConfinement } from "../hosted-mimo-goal-confinement";

const config = {
  taskId: "synthetic-mimo", jobRootDir: "/synthetic/job",
  workspacePath: "/synthetic/job/workspace", promptPath: "/synthetic/job/prompt",
  authRootDir: "/synthetic/unused-auth", accounts: [{ name: "account-q" }],
  modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
  executionEngine: "app-server-goal" as const,
  sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
};

describe("hosted MiMo effective goal confinement", () => {
  it("accepts only the fixed account and engine before private grant admission", () => {
    // Regression: a matching grant must not authorize a different effective account or model.
    expect(() => assertHostedMimoGoalConfinement(config)).not.toThrow();
    for (const changed of [
      { accounts: [{ name: "account-x" }] },
      { accounts: [{ name: "account-q", authJsonPath: "/synthetic/auth.json" }] },
      { model: "other-model" },
      { accessBoundary: AccessBoundary.DangerFullAccess },
      { providerSandboxMode: "danger-full-access" as const },
      { mimoAccounts: [{ name: "account-q", envVarName: "OVERRIDE_KEY" }] },
      { sourceEnv: { ...config.sourceEnv, MIMO_TOKEN_PLAN_API_KEY: "synthetic-only" } },
      { sourceEnv: { ...config.sourceEnv, SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE: "/synthetic/key" } },
    ]) {
      expect(() => assertHostedMimoGoalConfinement({ ...config, ...changed }))
        .toThrow("hosted_mimo_effective_confinement_required");
    }
    expect(() => assertHostedMimoGoalConfinement({ ...config,
      sourceEnv: {}, accounts: [{ name: "account-x" }] })).not.toThrow();
  });
});
