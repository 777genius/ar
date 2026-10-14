import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { codexAppServerToolConfig } from "../../app-server/domain/app-server-tool-config";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { CodexModelBackend } from "../../codex-model-backend";
import { HostedControllerToolName } from "../../app-server/domain/hosted-controller-dynamic-tools";

// Official installed CLI, synthetic loopback Responses only. No credentials,
// inherited HOME/configuration, real jobs, guest qualification or live MiMo E2E.
// Opt-in installed qualification: normal CI does not provide this host package.
// Explicit missing paths and wrong versions fail before any request.
const officialPackage = process.env.SUBSCRIPTION_RUNTIME_CODEX_01592_PACKAGE;

it.skipIf(officialPackage === undefined)("closes the actual 0.159.2 HTTP inventory through the production client while retaining external ACTIVE GoalAPI", async () => {
  assert(officialPackage, "explicit official Codex qualification package is required");
  expect(JSON.parse(await readFile(join(officialPackage, "package.json"), "utf8")).version).toBe("0.159.2");
  const root = await mkdtemp(join(tmpdir(), "NEWTEST-native-empty-wire-"));
  const home = join(root, "TEST-home"), codexHome = join(root, "TEST-codex-home"), workspace = join(root, "TEST-workspace");
  for (const path of [home, codexHome, workspace]) await mkdir(path, { mode: 0o700 });
  const httpRows: { method: string | undefined; path: string | undefined; body: any; dummyAuthorization: boolean }[] = [];
  const calls: Record<string, unknown>[] = [], sent: Record<string, any>[] = [], dispatches: unknown[] = [];
  const upgrades: string[] = [];
  const response = (output: unknown[], status = "completed") => ({ id: `resp_TEST_${httpRows.length}`,
    object: "response", created_at: Math.floor(Date.now() / 1000), model: "mimo-v2.6-pro", status, output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    httpRows.push({ method: req.method, path: req.url, body: data,
      dummyAuthorization: req.headers.authorization === "Bearer TEST_DUMMY_ONLY" });
    if (httpRows.length > 2) { res.writeHead(429); res.end("finite TEST budget exhausted"); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const output = httpRows.length === 1
      ? [{ type: "function_call", id: "fc_TEST_1", call_id: "call_TEST_1", name: "observe",
          arguments: JSON.stringify({ handle: "TEST-opaque" }) }]
      : [{ type: "message", id: "msg_TEST_2", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "TEST_WIRE_DONE", annotations: [] }] }];
    const emit = (type: string, extra: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
    emit("response.created", { response: response([], "in_progress") });
    output.forEach((item, output_index) => {
      emit("response.output_item.added", { output_index, item });
      emit("response.output_item.done", { output_index, item });
    });
    emit("response.completed", { response: response(output) });
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
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
stream_max_retries = 0
`);
  const abort = new AbortController();
  let ownedChild: ReturnType<typeof spawn> | undefined;
  const client = new CodexAppServerClient({
    // Invoke the official package launcher directly: restricted installations
    // may expose @openai/codex but omit the equivalent node_modules/.bin symlink.
    codexBinaryPath: join(officialPackage, "bin/codex.js"),
    processFactory: input => {
      const child = spawn(process.execPath, [input.command, ...input.args], {
        cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: false,
      });
      ownedChild = child;
      createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line);
        if (message.method === "item/tool/call") calls.push(message.params);
      });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: string) => { sent.push(JSON.parse(String(chunk))); return write(chunk); }) as typeof child.stdin.write;
      return child;
    },
    signalChildProcess: (child, signal) => { child.kill(signal); },
    sourceEnv: {},
    session: { home, codexHome, env: { HOME: home, CODEX_HOME: codexHome,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TEST_DUMMY_MIMO_KEY: "TEST_DUMMY_ONLY" }, release: async () => undefined },
    workspacePath: workspace,
    executionProfile: resolveCodexExecutionProfile({ kind: "custom", disableTools: false, historyMode: "none" }),
    nativeToolSurface: "disabled", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    hostedControllerTools: { dispatch: async (call, signal) => {
      expect(signal.aborted).toBe(false);
      dispatches.push(call);
      return { status: "disabled" }; // Synthetic response; no job effects.
    } },
    timeoutMs: 10_000, startupTimeoutMs: 10_000, reconnectGraceMs: 100,
    maxOutputBytes: 1_000_000, abortSignal: abort.signal,
  });
  let goalSet: unknown, goalRead: unknown, goalReadAfterTurn: unknown, result: unknown;
  const deadline = setTimeout(() => abort.abort(), 30_000);
  try {
    await client.start();
    const common = { workspacePath: workspace, model: "mimo-v2.6-pro", reasoningEffort: "high" as const,
      sandboxMode: "read-only" as const, timeoutMs: 10_000, abortSignal: abort.signal, goalMode: true };
    const threadId = await client.startThread(common);
    const goalInput = { threadId, timeoutMs: 10_000, abortSignal: abort.signal };
    goalSet = await client.setGoal({ ...goalInput, objective: "TEST bounded diagnostic only", status: "active" });
    goalRead = await client.getGoal(goalInput);
    expect(goalSet).toMatchObject({ threadId, objective: "TEST bounded diagnostic only", status: "active" });
    expect(goalRead).toMatchObject({ threadId, objective: "TEST bounded diagnostic only", status: "active" });
    result = await client.startTurn({ ...common, threadId, prompt: "TEST protocol diagnostic" });
    expect(result).toMatchObject({ outputText: "TEST_WIRE_DONE" });
    goalReadAfterTurn = await client.getGoal(goalInput);
    expect(goalReadAfterTurn).toMatchObject({ threadId, objective: "TEST bounded diagnostic only", status: "active" });
    expect(httpRows).toHaveLength(2);
    expect(httpRows.every(row => row.method === "POST" && row.path === "/v1/responses" && row.dummyAuthorization)).toBe(true);
    expect(upgrades).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(["arguments", "callId", "namespace", "threadId", "tool", "turnId"]);
    expect(calls[0]).toMatchObject({ namespace: null, threadId, callId: "call_TEST_1", tool: "observe", arguments: { handle: "TEST-opaque" } });
    expect(dispatches).toEqual([{ tool: HostedControllerToolName.Observe, arguments: { handle: "TEST-opaque" } }]);
    expect(httpRows[1]!.body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call_output", call_id: "call_TEST_1", output: expect.stringContaining("hosted_controller_disabled") }),
    ]));
    const start = sent.find(message => message.method === "thread/start")!;
    expect(start.params.ephemeral).toBe(false);
    // Inventory assertions deliberately come last: unchanged production source
    // records GoalAPI and the complete dynamic round trip before failing red.
    for (const row of httpRows) {
      expect(row.body.tools.map((tool: any) => tool.name).sort()).toEqual(["launch", "observe", "stop"]);
      expect(row.body.tools.every((tool: any) => tool.type === "function")).toBe(true);
    }
    expect(start.params.config.features).toMatchObject({ goals: false, default_mode_request_user_input: false });
    expect(start.params.config.tools.experimental_request_user_input).toEqual({ enabled: false });
    for (const row of httpRows) {
      expect(row.body.reasoning).toMatchObject({ effort: "high" });
    }
  } finally {
    clearTimeout(deadline);
    await client.stop();
    if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      await new Promise<void>(resolve => { ownedChild!.once("exit", () => resolve()); ownedChild!.kill("SIGKILL"); });
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const receipt = { officialVersion: "0.159.2", launcher: join(officialPackage, "bin/codex.js"),
      httpRows, calls, dispatches, sent, goalSet, goalRead, goalReadAfterTurn, result, upgrades,
      limits: "Synthetic NEWTEST HTTP protocol only; no hosted qualification or real MiMo E2E." };
    if (process.env.TEST_NATIVE_WIRE_RECEIPT) await writeFile(process.env.TEST_NATIVE_WIRE_RECEIPT, JSON.stringify(receipt, null, 2));
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

it("preserves ordinary/default goal configuration and trusted hooks", () => {
  for (const nativeToolSurface of [undefined, "default"] as const) {
    for (const goalMode of [false, true]) {
      for (const trustedHooksEnabled of [false, true]) {
        const config = codexAppServerToolConfig({ nativeToolSurface, goalMode, trustedHooksEnabled, fastMode: false });
        expect(config).toEqual({ features: { apps: false, hooks: trustedHooksEnabled, memories: false,
          multi_agent: false, shell_snapshot: false, skill_mcp_dependency_install: false,
          ...(goalMode ? { goals: true } : {}) } });
      }
    }
  }
});
