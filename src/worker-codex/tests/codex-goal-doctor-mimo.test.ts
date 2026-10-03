import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { doctorCodexGoal } from "../codex-goal-doctor";

describe("MiMo goal doctor", () => {
  it("accepts a synthetic token-plan slot without an auth root or auth.json", async () => {
    // Regression: OAuth preflight rejects a valid MiMo slot before provider admission.
    const root = await mkdtemp(join(process.cwd(), ".synthetic-mimo-doctor-"));
    try {
      const promptPath = join(root, "prompt.md");
      await writeFile(promptPath, "synthetic task\n");
      const config = {
        taskId: "synthetic-mimo-doctor", jobRootDir: root, workspacePath: process.cwd(),
        promptPath, authRootDir: join(root, "absent-auth"), accounts: [{ name: "account-q" }],
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        sourceEnv: { MIMO_TOKEN_PLAN_API_KEY: "synthetic-token-doctor" },
      };
      const result = await doctorCodexGoal({ config });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic-token-doctor");
      expect(result.checks.map(check => check.name)).not.toContain("authRoot");
      expect((await doctorCodexGoal({ config: { ...config, sourceEnv: {} } })).ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
