import { describe, expect, it } from "vitest";
import {
  buildCodexGoalBriefMcpResponse,
  type CodexGoalBriefResponseOptions,
} from "../codex-goal-mcp-brief-response";
import { CodexGoalBriefDetail } from "../codex-goal-mcp-inputs";
import { mcpJson } from "../codex-goal-mcp-response";

function fullFixture(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    registryRootDir: "/sandbox/registry",
    jobId: "job-a",
    brief: {
      text: "worker alive, lastProgressAt volatile",
      lastProgressAt: "2026-09-05T10:00:00.000Z",
      lastProgressAgeMs: 10_000,
      workerAlive: true,
      workerHealth: {
        alive: true,
        stale: false,
        blocked: true,
        safeToContinue: false,
        liveness: "alive",
        progressFreshness: "fresh",
        activeWriterRisk: { kind: "active_worker", risky: true },
        reasons: ["worker_alive"],
        evidence: ["progressHeartbeatAgeMs:10000"],
      },
      statusView: {
        account: "account-a",
        freshAgeMs: 10_000,
        activeWriterRisk: "active_worker",
        safeToContinue: false,
      },
      silentStale: false,
      heartbeatOnlyNoOutput: false,
      progressStatus: "running",
      progressAttemptCount: 2,
      changedFiles: ["src/a.ts"],
      safeToContinue: false,
      handoffManifestSha256: "abc123",
      handoffArtifactError: "handoff_manifest_missing",
      lifecycleMarkerTypes: ["pause_request"],
      nextBestTool: "manual_review",
      nextBestReason: "handoff_artifact_materialization_failed",
      nextBestCommand: "inspect artifacts",
      configuredAccounts: ["account-a", "account-b"],
      recentCommands: ["npm test"],
      recentLogTail: "large log body",
    },
    status: {
      tmuxAlive: true,
      resultExists: false,
      workspaceDirty: true,
      changedFiles: ["src/a.ts"],
      progressStatus: "running",
      progressUpdatedAt: "2026-09-05T10:00:00.000Z",
      progressHeartbeatAgeMs: 10_000,
      progressCpuActive: true,
      progressAttemptCount: 2,
      runtimeEventsUpdatedAt: "2026-09-05T10:00:00.000Z",
      lastRuntimeEvent: "turn_completed",
      lastRuntimeEventAt: "2026-09-05T10:00:00.000Z",
      recommendedAction: "wait_for_worker",
      warnings: ["synthetic warning"],
    },
    diagnostics: { verbose: "x".repeat(500) },
    ...overrides,
  };
}

const options = {
  detail: CodexGoalBriefDetail.Compact,
  registryRootDir: "/sandbox/registry",
  jobId: "job-a",
  staleAfterMs: 600_000,
  logTailLines: 0,
} as const;

describe("codex_goal_brief MCP response projection", () => {
  it("keeps safety and artifact facts while dropping verbose diagnostics and logs", () => {
    const compact = buildCodexGoalBriefMcpResponse(fullFixture(), options);
    expect(compact).toMatchObject({
      unchanged: false,
      detail: "compact",
      brief: {
        safeToContinue: false,
        workerAlive: true,
        changedFiles: ["src/a.ts"],
        handoffManifestSha256: "abc123",
        handoffArtifactError: "handoff_manifest_missing",
        nextBestTool: "manual_review",
        nextBestReason: "handoff_artifact_materialization_failed",
      },
      status: {
        workspaceDirty: true,
        warnings: ["synthetic warning"],
      },
    });
    expect(JSON.stringify(compact)).not.toContain("large log body");
    expect(JSON.stringify(compact)).not.toContain("configuredAccounts");
  });

  it("includes an explicitly requested log tail and emits compact MCP text", () => {
    const compact = buildCodexGoalBriefMcpResponse(fullFixture(), {
      ...options,
      logTailLines: 20,
    });
    expect(compact).toMatchObject({
      brief: {
        recentCommands: ["npm test"],
        recentLogTail: "large log body",
      },
    });
    const response = mcpJson(compact);
    expect(response.content[0]?.text).toBe(JSON.stringify(compact));
    expect(response.structuredContent).toBe(compact);
  });

  it("suppresses heartbeat and age-only churn but wakes for meaningful changes", () => {
    const first = buildCodexGoalBriefMcpResponse(fullFixture(), options);
    const revision = String(first.revision);
    const volatile = fullFixture();
    (volatile.brief as Record<string, unknown>).lastProgressAgeMs = 90_000;
    ((volatile.brief as Record<string, unknown>).statusView as Record<string, unknown>)
      .freshAgeMs = 90_000;
    ((volatile.brief as Record<string, unknown>).workerHealth as Record<string, unknown>)
      .evidence = ["progressHeartbeatAgeMs:90000"];
    (volatile.status as Record<string, unknown>).progressHeartbeatAgeMs = 90_000;
    (volatile.status as Record<string, unknown>).progressCpuActive = false;
    (volatile.status as Record<string, unknown>).progressUpdatedAt =
      "2026-09-05T10:01:20.000Z";
    (volatile.status as Record<string, unknown>).lastRuntimeEventAt =
      "2026-09-05T10:01:20.000Z";

    expect(buildCodexGoalBriefMcpResponse(volatile, {
      ...options,
      afterRevision: revision,
    })).toMatchObject({ unchanged: true, revision });

    (volatile.status as Record<string, unknown>).warnings = ["new blocker"];
    const changed = buildCodexGoalBriefMcpResponse(volatile, {
      ...options,
      afterRevision: revision,
    });
    expect(changed.unchanged).toBe(false);
    expect(changed.revision).not.toBe(revision);
  });

  it("wakes for progress, result and artifact identity transitions", () => {
    const revision = String(
      buildCodexGoalBriefMcpResponse(fullFixture(), options).revision,
    );
    const changedFixtures = [
      (() => {
        const value = fullFixture();
        (value.status as Record<string, unknown>).progressAttemptCount = 3;
        return value;
      })(),
      (() => {
        const value = fullFixture();
        (value.status as Record<string, unknown>).resultStatus = "completed";
        return value;
      })(),
      (() => {
        const value = fullFixture();
        (value.brief as Record<string, unknown>).handoffManifestSha256 = "def456";
        return value;
      })(),
    ];
    for (const full of changedFixtures) {
      expect(buildCodexGoalBriefMcpResponse(full, {
        ...options,
        afterRevision: revision,
      }).unchanged).toBe(false);
    }
  });

  it("binds revisions to job, registry and output options", () => {
    const revision = String(buildCodexGoalBriefMcpResponse(fullFixture(), options).revision);
    const cases: readonly (readonly [Record<string, unknown>, CodexGoalBriefResponseOptions])[] = [
      [fullFixture({ jobId: "job-b" }), {
        ...options,
        jobId: "job-b",
        afterRevision: revision,
      }],
      [fullFixture({ registryRootDir: "/sandbox/other" }), {
        ...options,
        registryRootDir: "/sandbox/other",
        afterRevision: revision,
      }],
      [fullFixture(), { ...options, logTailLines: 20, afterRevision: revision }],
    ];
    for (const [fixture, changedOptions] of cases) {
      expect(buildCodexGoalBriefMcpResponse(fixture, changedOptions).unchanged)
        .toBe(false);
    }
  });

  it("keeps full as an exact escape hatch and fails safely for unknown shapes", () => {
    const full = fullFixture();
    expect(buildCodexGoalBriefMcpResponse(full, {
      ...options,
      detail: CodexGoalBriefDetail.Full,
      afterRevision: "ignored",
    })).toBe(full);
    const unknown = { ok: true, registryRootDir: "/sandbox/registry", jobId: "job-a" };
    expect(buildCodexGoalBriefMcpResponse(unknown, options)).toBe(unknown);
  });

  it("reduces serialized bytes for compact and unchanged polling", () => {
    const full = fullFixture();
    const compact = buildCodexGoalBriefMcpResponse(full, options);
    const unchanged = buildCodexGoalBriefMcpResponse(full, {
      ...options,
      afterRevision: String(compact.revision),
    });
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(bytes(compact)).toBeLessThan(bytes(full));
    expect(bytes(unchanged)).toBeLessThan(bytes(compact));
  });
});
