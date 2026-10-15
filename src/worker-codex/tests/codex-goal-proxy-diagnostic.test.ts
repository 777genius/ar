import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectCodexGoalStatus } from "../codex-goal-ops";
import { resolveVisibleCodexGoalResult } from "../application/codex-goal-visible-result";
import { buildCodexGoalBriefMcpResponse } from "../codex-goal-mcp-brief-response";
import { CodexGoalBriefDetail } from "../codex-goal-mcp-inputs";

const details = { mimoProxyReason: "upstream_http_error", mimoProxyPhase: "upstream_response",
  mimoProxyElapsedMs: "77", mimoProxyRequestNumber: "1", mimoUpstreamStatus: "401",
  rawCause: "TEST-secret-body-never-forward", api_key: "TEST-secret-token-never-forward" };
async function fixture(run: (root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "TEST-proxy-diagnostic-"));
  try { await run(root, join(root, "TEST-proxy-diagnostic.latest-result.json")); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const options = { detail: CodexGoalBriefDetail.Compact, jobId: "TEST-proxy-diagnostic", logTailLines: 0 } as const;

it("shows closed proxy facts through file status and compact MCP without forwarding private result details", async () => {
  await fixture(async (root, path) => {
    await writeFile(path, JSON.stringify({ status: "failed", reason: "unknown_error", details }));
    const status = await collectCodexGoalStatus({ jobRootDir: root, taskId: "TEST-proxy-diagnostic" });
    expect(status.resultProxyFailure).toEqual({ reason: "upstream_http_error", phase: "upstream_response",
      elapsed_ms: 77, request_number: 1, upstream_status: 401 });
    expect(JSON.stringify(status)).not.toContain("TEST-secret");
    const full = { ok: true, registryRootDir: root, jobId: "TEST-proxy-diagnostic", brief: {}, status };
    const compact = buildCodexGoalBriefMcpResponse(full, options);
    expect(compact).toMatchObject({ status: { resultProxyFailure: status.resultProxyFailure } });
    expect(JSON.stringify(compact)).not.toContain("TEST-secret");
    const changed = buildCodexGoalBriefMcpResponse({ ...full, status: { ...status,
      resultProxyFailure: { ...status.resultProxyFailure, upstream_status: 503 } } },
      { ...options, afterRevision: compact.revision as string });
    expect(changed.unchanged).toBe(false);
    expect(changed.revision).not.toBe(compact.revision);
    const stale = resolveVisibleCodexGoalResult({ exists: true, status: "failed",
      proxyFailure: status.resultProxyFailure, updatedAt: "2026-01-01T00:00:00Z",
      progress: { status: "running", updatedAt: "2026-01-02T00:00:00Z" }, workerAlive: true });
    expect(stale.exists).toBe(false); expect(stale.proxyFailure).toBeUndefined();
  });
});

it.each([
  { mimoProxyReason: "TEST-secret-unknown-reason" }, { mimoProxyElapsedMs: "-1" },
  { mimoProxyRequestNumber: "4097" }, { mimoUpstreamStatus: "401TEST-secret" },
  { mimoTransportCode: "TEST-secret-network-error" }, { mimoValidationCode: "TEST-secret-parser-error" },
])("omits malformed diagnostics instead of copying untrusted values: %j", async invalid => {
  await fixture(async (root, path) => {
    await writeFile(path, JSON.stringify({ status: "failed", reason: "unknown_error", details: { ...details, ...invalid } }));
    const status = await collectCodexGoalStatus({ jobRootDir: root, taskId: "TEST-proxy-diagnostic" });
    expect(status.resultProxyFailure).toBeUndefined(); expect(JSON.stringify(status)).not.toContain("TEST-secret");
  });
});

it("does not show a retained failure observation on a successful result", async () => {
  await fixture(async (root, path) => {
    await writeFile(path, JSON.stringify({ status: "done", details }));
    const status = await collectCodexGoalStatus({ jobRootDir: root, taskId: "TEST-proxy-diagnostic" });
    expect(status.resultStatus).toBe("done"); expect(status.resultProxyFailure).toBeUndefined();
  });
});
