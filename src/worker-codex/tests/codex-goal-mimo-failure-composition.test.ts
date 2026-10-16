import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LocalFileAttemptJournal } from "@vioxen/subscription-runtime/store-local-file";
import { InMemoryWorkspaceLockStore, SafeExecutionRunner, SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";
import { managedRunFailureToWorkerError } from "../file-backend-codex-managed-run-recovery";
import type { FileBackendCodexWorkerResult } from "../file-backend-codex-worker";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexJsonAgentDriver } from "../../provider-codex/codex-json-agent-driver";
import { CodexModelBackend } from "../../provider-codex/codex-model-backend";
import { HostedMimoCodingProxyOwner } from "../../provider-codex/hosted-mimo-coding-proxy-material";
import { StaticRunner } from "../../provider-codex/tests/codex-provider-test-support";
import { startMimoCredentialProxy } from "../../provider-codex/hosted-mimo-credential-proxy";
import { codexGoalAccountSlots, runCodexGoal, type CodexGoalExecutor } from "../codex-goal-runner";
import { collectCodexGoalStatus } from "../codex-goal-ops";
import { buildCodexGoalBriefMcpResponse } from "../codex-goal-mcp-brief-response";
import { CodexGoalBriefDetail } from "../codex-goal-mcp-inputs";

// Only loopback HTTP is real. The injected upstream never opens a provider
// connection, and the runner's executor port never starts an agent process.
it.each([
  { kind: "http", reason: "upstream_http_error", phase: "upstream_response", upstream_status: 503 },
  { kind: "dns", reason: "upstream_transport_error", phase: "upstream_request", transport_code: "ENOTFOUND" },
] as const)("persists $kind proxy failure through the runner and public MCP projection", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "TEST-mimo-failure-composition-"));
  const taskId = "TEST-mimo-failure-composition";
  const secret = "TEST-synthetic-key-never-persist";
  const privateBody = "TEST-private-provider-body";
  let capability = "";
  const transport = vi.fn<typeof fetch>(async () => {
    if (scenario.kind === "dns") throw new TypeError(privateBody, {
      cause: Object.assign(Error(secret), { code: "ENOTFOUND", hostname: privateBody }),
    });
    return new Response(secret + capability + privateBody, { status: 503,
      headers: { "x-private": secret, "retry-after": "999", location: "https://invalid.test/" + secret } });
  });
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from(secret), model: "mimo-v2.6-pro",
    fetchUpstream: transport, limits: { deadlineMs: Date.now() + 30_000, maxRequests: 1,
      maxConcurrency: 1, maxBodyBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 100, requestTimeoutMs: 1000 } });
  capability = proxy.capability;
  const jobRootDir = join(root, "job"), workspacePath = join(root, "workspace");
  const outputPath = join(jobRootDir, taskId + ".latest-result.json");
  const promptPath = join(root, "prompt.md");
  const execute = vi.fn<CodexGoalExecutor["run"]>();
  const dispose = vi.fn(async () => {});
  // This explicit TEST adapter projection supplies the real proxy observation
  // without manufacturing protected hosted-origin custody or a provider process.
  const latest = vi.spyOn(HostedMimoCodingProxyOwner.prototype, "latestFailure", "get")
    .mockImplementation(() => proxy.latestFailure());
  let firstTurn = true, publicProxyBody = "", engineTurns = 0;
  const driver = new CodexJsonAgentDriver({ modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    sourceEnv: { TEST_MIMO_KEY: secret }, mimoApiKeyEnvVarName: "TEST_MIMO_KEY",
    engine: { kind: "TEST-inprocess", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      capabilities: { supportsStructuredOutput: false, supportsJsonEvents: false,
        supportsThreadResume: false, requiresSchemaFile: false },
      async run() {
        engineTurns++;
        if (firstTurn) {
          firstTurn = false;
          const response = await fetch(proxy.baseUrl + "/responses", { method: "POST",
            headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "mimo-v2.6-pro", input: "TEST", stream: false }) });
          expect(response.status).toBe(502);
          expect(response.headers.get("retry-after")).toBeNull();
          expect(response.headers.get("location")).toBeNull();
          publicProxyBody = await response.text();
        }
        throw Error("TEST in-process turn failure");
      } },
  });
  const runTurn = () => driver.runTask({ session: null,
    task: { kind: "structured-prompt", prompt: "TEST synthetic transport failure" },
    workspace: { path: workspacePath }, runner: new StaticRunner(""), redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal });
  try {
    await mkdir(jobRootDir); await mkdir(workspacePath);
    await writeFile(promptPath, "Synthetic transport diagnostic TEST only.\n");
    const formatted = await runTurn();
    expect(formatted.status).toBe("failed");
    if (formatted.status !== "failed") throw Error("TEST expected actual driver failure");
    if (!formatted.failure.details) throw Error("TEST expected actual driver failure details");
    const stale = await runTurn();
    expect(stale.status).toBe("failed");
    if (stale.status !== "failed") throw Error("TEST expected unrelated later failure");
    expect(stale.failure.details).not.toHaveProperty("mimoProxyReason");
    expect(engineTurns).toBe(2);
    const workerError = managedRunFailureToWorkerError(formatted);
    const journalRoot = join(root, "attempt-journal");
    const journal = new LocalFileAttemptJournal(journalRoot);
    const safeRunner = new SafeExecutionRunner({ journal, lockStore: new InMemoryWorkspaceLockStore(),
      snapshotter: { async capture() { return { mode: "filesystem" as const, workspacePath,
        capturedAt: new Date(), dirty: false, changedFiles: [], fingerprint: "unchanged",
        summary: "unchanged isolated TEST workspace" }; } } });
    const poolRun = vi.fn(async () => {
      throw new SubscriptionWorkerError("subscription_worker_pool_slot_failed", "TEST worker failed", { cause: workerError });
    });
    execute.mockImplementation(() => safeRunner.run<{ workspacePath: string }, FileBackendCodexWorkerResult>({
      taskId, workspace: { mode: "existing_locked", path: workspacePath }, effectMode: "read_only",
      provider: "codex", pool: { run: poolRun }, job: { workspacePath }, originalPrompt: "TEST",
      policy: { maxAttempts: 1 } }));
    await runCodexGoal({ taskId, jobRootDir, workspacePath, promptPath, outputPath,
      authRootDir: join(root, "synthetic-auth-not-used"), accounts: codexGoalAccountSlots(["account-a"]) },
    { createExecutor: () => ({ run: execute, dispose }) });
    const persistedBytes = await readFile(outputPath, "utf8");
    const persisted = JSON.parse(persistedBytes);
    expect(persisted).toMatchObject({ status: "failed", reason: "unknown_error", details: {
      mimoProxyReason: scenario.reason, mimoProxyPhase: scenario.phase, mimoProxyRequestNumber: "1",
      ...(scenario.kind === "http" ? { mimoUpstreamStatus: "503" } : { mimoTransportCode: "ENOTFOUND" }),
    } });
    const status = await collectCodexGoalStatus({ jobRootDir, taskId });
    const expected = { reason: scenario.reason, phase: scenario.phase, request_number: 1,
      ...(scenario.kind === "http" ? { upstream_status: 503 } : { transport_code: "ENOTFOUND" }) };
    expect(status.resultProxyFailure).toMatchObject(expected);
    expect(status.resultProxyFailure?.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(status.resultProxyFailure?.elapsed_ms).toBeLessThan(30_000);
    const compact = buildCodexGoalBriefMcpResponse({ ok: true, registryRootDir: root,
      jobId: taskId, brief: {}, status }, { detail: CodexGoalBriefDetail.Compact, jobId: taskId, logTailLines: 0 });
    expect(compact).toMatchObject({ status: { resultProxyFailure: expected } });
    for (const bytes of [publicProxyBody, persistedBytes, JSON.stringify(status), JSON.stringify(compact)]) {
      for (const sentinel of [secret, capability, privateBody, "retry-after", "x-private", "invalid.test"])
        expect(bytes).not.toContain(sentinel);
    }
    expect(transport).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(poolRun).toHaveBeenCalledOnce();
    const journaled = await new LocalFileAttemptJournal(journalRoot).readTask({ taskId });
    expect(journaled?.attempts).toHaveLength(1);
    expect(journaled?.lastFailureDetails).toMatchObject({ mimoProxyReason: scenario.reason,
      mimoProxyPhase: scenario.phase, mimoProxyRequestNumber: "1",
      ...(scenario.kind === "http" ? { mimoUpstreamStatus: "503" } : { mimoTransportCode: "ENOTFOUND" }) });
    for (const sentinel of [secret, capability, privateBody]) expect(JSON.stringify(journaled)).not.toContain(sentinel);
    expect(persisted.changedFiles).toEqual([]);
  } finally { await driver.dispose(); latest.mockRestore(); await proxy.close();
    await rm(root, { recursive: true, force: true }); }
});
