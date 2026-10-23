import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { makeFakeRuntimeDeps } from "../../core/testing";
import { CodexJsonAgentDriver } from "../codex-json-agent-driver";
import { sessionArtifactFromCodexAuthJson } from "../codex-auth-json-codec";
import { CodexEphemeralSessionMaterializer } from "../codex-session-materializer";
import type { CodexExecutionEngine, CodexMaterializedSession } from "../codex-json-execution-engine";

const auth = (token: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: token, access_token: "SYNTHETIC_ACCESS", expiry: "2026-05-31T23:00:00Z" }, last_refresh: "2026-05-31T00:00:00Z" });
const artifact = sessionArtifactFromCodexAuthJson(auth("SYNTHETIC_FIRST"));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

function waiting(runId: string, requestId: string, workspacePath: string) {
  return {
    status: "waiting_for_input" as const,
    runId,
    outputText: "waiting",
    warnings: [],
    request: { id: requestId, kind: "missing_context" as const, audience: "orchestrator" as const, question: "continue" },
    resumeHandle: { providerId: "codex", runId, workspacePath },
  };
}

// A stale retry must not destroy the session the run is being resumed on: the
// resume validation guard means the claim never happened, so the retained
// session still belongs to the run's next legitimate resume.
async function staleRetryFixture() {
  const root = await mkdtemp(join(tmpdir(), "TEST-codex-stale-retry-"));
  const events: string[] = [];
  const sessions: CodexMaterializedSession[] = [];
  const physical = new CodexEphemeralSessionMaterializer();
  const engine: CodexExecutionEngine = {
    kind: "TEST-stale-retry",
    capabilities: { supportsStructuredOutput: true, supportsJsonEvents: true, supportsThreadResume: true, requiresSchemaFile: false },
    run: async () => { throw new Error("TEST-run-not-used"); },
    resume: async (input) => {
      sessions.push(input.session);
      if (input.requestId === "TEST-stale") throw new Error("codex_managed_run_request_mismatch");
      return waiting("TEST-run", input.requestId, root);
    },
  };
  const driver = new CodexJsonAgentDriver({
    engine,
    model: "gpt-test",
    sessionMaterializer: { mode: "ephemeral", materialize: async (input) => {
      const selected = await physical.materialize(input);
      return { ...selected,
        snapshotSession: async () => { events.push("snapshot"); return await selected.snapshotSession!(); },
        release: async () => { events.push("release"); await selected.release(); } };
    } },
  });
  const deps = makeFakeRuntimeDeps();
  const resumeInput = (requestId: string) => ({
    session: artifact,
    runId: "TEST-run",
    requestId,
    answer: "continue",
    resumeHandle: { providerId: "codex", runId: "TEST-run", workspacePath: root } as const,
    workspace: { path: root },
    runner: deps.runner,
    redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal,
  });
  cleanups.push(async () => {
    await driver.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { root, events, sessions, driver, resumeInput };
}

describe("bug I: a stale retry must keep the run's retained session", () => {
  it("keeps the retained session across a resume validation error", async () => {
    const f = await staleRetryFixture();
    try {
      const first = await f.driver.resumeManagedRun(f.resumeInput("TEST-request-1"));
      expect(first.status).toBe("waiting_for_input");
      const stale = await f.driver.resumeManagedRun(f.resumeInput("TEST-stale"));
      expect(stale.status).toBe("failed");
      expect(f.events.filter((event) => event === "release")).toHaveLength(0);
      const again = await f.driver.resumeManagedRun(f.resumeInput("TEST-request-2"));
      expect(again.status).toBe("waiting_for_input");
      expect(f.sessions).toHaveLength(3);
      expect(f.sessions[2]).toBe(f.sessions[0]);
    } finally {
      await f.driver.dispose().catch(() => undefined);
    }
  }, 20000);
});
