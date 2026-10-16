import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { CodexModelBackend } from "../../codex-model-backend";
import { classifyCodexRuntimeFailure } from "../../codex-cli-domain";

// Official installed CLI, synthetic loopback Responses only; no credentials or live MiMo.
// The TOML below is this test's own: it checks Codex semantics, while the generated runtime config is pinned by hosted-mimo-coding-proxy-material.test.ts.
// Opt-in like codex-native-empty-wire.test.ts: normal CI does not provide this host package.
const officialPackage = process.env.SUBSCRIPTION_RUNTIME_CODEX_01592_PACKAGE;

type Rows = { method: string | undefined; path: string | undefined }[];
type Handler = (rows: Rows, res: ServerResponse) => void;

async function withOfficialCodex(streamMaxRetries: number, handle: Handler) {
  assert(officialPackage, "explicit official Codex qualification package is required");
  expect(JSON.parse(await readFile(join(officialPackage, "package.json"), "utf8")).version).toBe("0.159.2");
  const root = await mkdtemp(join(tmpdir(), "NEWTEST-native-stream-retry-"));
  const home = join(root, "TEST-home"), codexHome = join(root, "TEST-codex-home"), workspace = join(root, "TEST-workspace");
  for (const path of [home, codexHome, workspace]) await mkdir(path, { mode: 0o700 });
  const httpRows: Rows = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request body */ }
    httpRows.push({ method: req.method, path: req.url });
    handle(httpRows, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await writeFile(join(codexHome, "config.toml"), `model = "mimo-v2.6-pro"
model_provider = "mimo"
[model_providers.mimo]
name = "NEWTEST synthetic local Responses"
base_url = "http://127.0.0.1:${address.port}/v1"
env_key = "TEST_DUMMY_MIMO_KEY"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = ${streamMaxRetries}
supports_websockets = false
`);
  const abort = new AbortController();
  let ownedChild: ReturnType<typeof spawn> | undefined;
  const client = new CodexAppServerClient({
    codexBinaryPath: join(officialPackage, "bin/codex.js"),
    processFactory: input => {
      const child = spawn(process.execPath, [input.command, ...input.args], {
        cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: false,
      });
      ownedChild = child;
      return child;
    },
    signalChildProcess: (child, signal) => { child.kill(signal); },
    sourceEnv: {},
    session: { home, codexHome, env: { HOME: home, CODEX_HOME: codexHome,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TEST_DUMMY_MIMO_KEY: "TEST_DUMMY_ONLY" }, release: async () => undefined },
    workspacePath: workspace,
    executionProfile: resolveCodexExecutionProfile({ kind: "custom", disableTools: false, historyMode: "none" }),
    nativeToolSurface: "disabled", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    timeoutMs: 20_000, startupTimeoutMs: 10_000, reconnectGraceMs: 5_000,
    maxOutputBytes: 1_000_000, abortSignal: abort.signal,
  });
  const deadline = setTimeout(() => abort.abort(), 40_000);
  try {
    await client.start();
    const common = { workspacePath: workspace, model: "mimo-v2.6-pro", reasoningEffort: "high" as const,
      sandboxMode: "read-only" as const, timeoutMs: 20_000, abortSignal: abort.signal };
    const threadId = await client.startThread(common);
    return { result: await client.startTurn({ ...common, threadId, prompt: "TEST stream retry" }), httpRows };
  } finally {
    clearTimeout(deadline);
    await client.stop();
    if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      await new Promise<void>(resolve => { ownedChild!.once("exit", () => resolve()); ownedChild!.kill("SIGKILL"); });
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

const post = { method: "POST", path: "/v1/responses" };
const sse = (res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  return (type: string, extra: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
};
const response = (id: string, output: unknown[], status = "completed") => ({ id, object: "response",
  created_at: Math.floor(Date.now() / 1000), model: "mimo-v2.6-pro", status, output,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });

it.skipIf(officialPackage === undefined)("retries a stream dropped mid-body inside the same turn with the 0.159.2 CLI", async () => {
  const { result, httpRows } = await withOfficialCodex(8, (rows, res) => {
    const emit = sse(res);
    emit("response.created", { response: response(`resp_TEST_${rows.length}`, [], "in_progress") });
    if (rows.length === 1) {
      // Same failure shape as the proxy: headers are sent, then the body dies.
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    const item = { type: "message", id: "msg_TEST_2", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "TEST_RETRY_DONE", annotations: [] }] };
    emit("response.output_item.added", { output_index: 0, item });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: response("resp_TEST_2", [item]) });
    res.end();
  });
  expect(result).toMatchObject({ outputText: "TEST_RETRY_DONE", completed: true, error: null });
  expect(httpRows).toEqual([post, post]);
}, 60_000);

// The proxy answers an upstream 429 with 502; Codex retries it and the final failure still reads as quota.
it.skipIf(officialPackage === undefined)("retries a proxied capacity 429 and still classifies the final failure as quota_limited", async () => {
  const { result, httpRows } = await withOfficialCodex(2, (_rows, res) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "proxy_upstream_failed", upstream_status: 429 } }));
  });
  expect(httpRows).toEqual([post, post, post]);
  expect(result.error).not.toBeNull();
  expect(classifyCodexRuntimeFailure(result.error!.message)).toBe("quota_limited");
}, 60_000);
