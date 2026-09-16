import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  directCodexAppServerFailureCause,
} from "../application/project-control/codex-app-server-failure-cause";
import type { CodexGoalLaunchInput, CodexGoalStatus } from "../codex-goal-ops";
import { resolveProjectPreStartContinuation } from "../codex-goal-project-continuation-runtime";
import {
  cleanupProjectPreStartAdmissionFixtures,
  createBuiltinFixture,
} from "./codex-goal-project-pre-start-admission-fixture";

afterEach(cleanupProjectPreStartAdmissionFixtures);

describe("project provider-failure continuation", () => {
  it("accepts only direct or exactly once wrapped app-server failures", async () => {
    const fixture = await createBuiltinFixture();
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: fixture.plan().descriptor,
    };
    const resultPath = join(fixture.root, "provider-failure-result.json");
    const changedFiles = ["src/example.ts"];
    const status = {
      tmuxAlive: false,
      workspaceDirty: true,
      changedFiles,
      resultExists: true,
      resultPath,
      resultStatus: "partial",
      resultReason: "unknown_error",
      recommendedAction: "inspect_dirty_failure",
      warnings: [],
    } as CodexGoalStatus;
    const launch = {
      config: { taskId: manifest.taskId },
    } as CodexGoalLaunchInput;
    const providerCause = "codex_app_server_error:provider failed";
    const result = {
      taskId: manifest.taskId,
      status: "partial",
      reason: "unknown_error",
      changedFiles,
      evidence: ["safe_execution_status:partial"],
      blockers: ["unknown_error"],
      nextAction: "preserve_patch",
      details: { rawCause: providerCause },
    };
    const resolve = async (rawCause: string) => {
      await writeFile(
        resultPath,
        `${JSON.stringify({ ...result, details: { rawCause } })}\n`,
      );
      return resolveProjectPreStartContinuation({ manifest, launch, status });
    };
    const decision = {
      kind: "provider_failure",
      workspaceMode: "admitted_input_patch_continuation",
    };

    await expect(resolve(providerCause)).resolves.toEqual(decision);
    await expect(resolve(appServerTurnError(providerCause))).resolves.toEqual(
      decision,
    );
    await expect(
      resolve(appServerTurnError(appServerTurnError(providerCause))),
    ).resolves.toBeUndefined();
    await expect(
      resolve(`prefix:${appServerTurnError(providerCause)}`),
    ).resolves.toBeUndefined();
  });

  it.each([
    {},
    authenticTurnDetails({ elapsedMs: -1 }),
    authenticTurnDetails({ elapsedMs: "25" }),
    authenticTurnDetails({ turnNumber: 0 }),
    authenticTurnDetails({ turnNumber: 10_001 }),
    authenticTurnDetails({ turnNumber: 1.5 }),
    authenticTurnDetails({ outputCharCount: -1 }),
    authenticTurnDetails({ outputCharCount: Number.MAX_SAFE_INTEGER + 1 }),
    authenticTurnDetails({ outputCharCount: "0" }),
    authenticTurnDetails({ outputObserved: true }),
    authenticTurnDetails({
      phase: "turn_start_rejected",
      outputObserved: true,
      outputCharCount: 1,
    }),
    authenticTurnDetails({
      phase: "turn_error_before_output",
      outputObserved: true,
      outputCharCount: 1,
    }),
    authenticTurnDetails({
      phase: "turn_error_after_output",
      outputObserved: false,
      outputCharCount: 0,
    }),
    authenticTurnDetails({ phase: "unknown_phase" }),
    authenticTurnDetails({ unexpected: true }),
  ])("rejects a spoofed turn-error details envelope %#", (details) => {
    const cause = "codex_app_server_error:provider failed";
    const wrapped = appServerTurnError(cause, details);
    expect(directCodexAppServerFailureCause(wrapped)).toBe(wrapped);
  });

  it.each([
    authenticTurnDetails({ phase: "turn_start_rejected" }),
    authenticTurnDetails({ phase: "turn_error_before_output" }),
    authenticTurnDetails({
      phase: "turn_error_after_output",
      outputObserved: true,
      outputCharCount: 1,
    }),
  ])("accepts producer-valid phase/output details %#", (details) => {
    const cause = "codex_app_server_error:provider failed";
    expect(directCodexAppServerFailureCause(appServerTurnError(cause, details)))
      .toBe(cause);
  });

  it("rejects malformed wrapper details", () => {
    const rawCause =
      "codex_app_server_turn_error:codex_app_server_error:provider failed:details=not-json";
    expect(directCodexAppServerFailureCause(rawCause)).toBe(rawCause);
  });
});

function appServerTurnError(
  cause: string,
  details: Readonly<Record<string, unknown>> = authenticTurnDetails(),
): string {
  return `codex_app_server_turn_error:${cause}:details=${JSON.stringify(details)}`;
}

function authenticTurnDetails(
  override: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    phase: "turn_error_before_output",
    turnNumber: 1,
    outputObserved: false,
    outputCharCount: 0,
    elapsedMs: 25,
    ...override,
  };
}
