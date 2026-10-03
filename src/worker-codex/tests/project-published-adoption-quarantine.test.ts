import { expect, it, vi } from "vitest";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { assertPublishedIntegrationAttemptMutable } from
  "../application/project-control/codex-goal-published-adoption-quarantine";

vi.mock("../application/project-control/codex-goal-legacy-attempt-quarantine-resolution", () => ({
  resolveLegacyAttemptQuarantine: async () => ({ attemptIds: new Set<string>() }),
}));

it("refuses adoption of a quarantined attempt before a permit or ledger mutation", async () => {
  const scope = { projectId: "synthetic-project" } as ProjectAccessScope;
  const input = {
    controllerJobRootDir: "/synthetic/controller",
    scope,
    attemptId: "quarantined-attempt",
    readQuarantine: async () => ({ attemptIds: new Set(["quarantined-attempt"]) }),
  };
  await expect(assertPublishedIntegrationAttemptMutable(input))
    .rejects.toThrow("project_integration_attempt_quarantined");
  await expect(assertPublishedIntegrationAttemptMutable({
    ...input, attemptId: "clean-attempt",
  })).resolves.toBeUndefined();
});
