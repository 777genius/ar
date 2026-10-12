import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { DefaultRedactor } from "../../../core/index";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";
import { CodexModelBackend } from "../../codex-model-backend";
import { StaticRunner } from "../codex-provider-test-support";

// Real installed Codex, synthetic loopback Responses, dummy credentials only.
// The native tool must update GoalAPI; a scripted app-server status is insufficient.
const officialPackage = process.env.SUBSCRIPTION_RUNTIME_CODEX_01592_PACKAGE;

it.skipIf(officialPackage === undefined)("completes bounded workspace Goal through actual native goal controls without native IO", async () => {
  assert(officialPackage, "explicit official Codex qualification package is required");
  expect(JSON.parse(await readFile(join(officialPackage, "package.json"), "utf8")).version).toBe("0.159.2");
  const root = await mkdtemp(join(tmpdir(), "NEWTEST-bounded-goal-controls-"));
  const home = join(root, "TEST-home"), codexHome = join(root, "TEST-codex-home"), workspace = join(root, "TEST-workspace");
  for (const path of [home, codexHome, workspace]) await mkdir(path, { mode: 0o700 });
  const toolInventories: string[][] = [];
  const requests: { id: number; method: string; params?: Record<string, any> }[] = [];
  const goalStatuses: string[] = [];
  let nativeFunctionResultObserved = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const tools = data.tools as { name: string }[];
    toolInventories.push(tools.map(tool => tool.name).sort());
    if (toolInventories.length > 2) { res.writeHead(429); res.end("finite TEST budget exhausted"); return; }
    if (toolInventories.length === 2) nativeFunctionResultObserved = data.input.some(
      (item: { type: string; call_id?: string }) => item.type === "function_call_output" && item.call_id === "call_TEST_complete",
    );
    const output = toolInventories.length === 1
      ? [{ type: "function_call", id: "fc_TEST_complete", call_id: "call_TEST_complete", name: "update_goal",
          arguments: JSON.stringify({ status: "complete" }) }]
      : [{ type: "message", id: "msg_TEST_complete", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "TEST_GOAL_COMPLETE", annotations: [] }] }];
    const response = (items: unknown[], status: string) => ({ id: `resp_TEST_${toolInventories.length}`,
      object: "response", created_at: Math.floor(Date.now() / 1000), model: "mimo-v2.6-pro", status, output: items,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (type: string, extra: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
    emit("response.created", { response: response([], "in_progress") });
    output.forEach((item, output_index) => {
      emit("response.output_item.added", { output_index, item });
      emit("response.output_item.done", { output_index, item });
    });
    emit("response.completed", { response: response(output, "completed") });
    res.end();
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
  const runStore = new InMemoryManagedRunStore();
  let ownedChild: ReturnType<typeof spawn> | undefined;
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: join(officialPackage, "bin/codex.js"), sourceEnv: {},
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    goalMode: true, maxGoalTurns: 4, cleanThreadPrewarm: false,
    nativeToolSurface: "disabled", nativeGoalControls: true,
    rolloutBudget: { weightedTokenLimit: 100_000 }, runStore,
    executionProfile: { kind: "custom", disableTools: false, historyMode: "none",
      developerInstructions: "Use native goal-status controls only to mark the active Goal complete. Native filesystem, shell, web and delegation tools are unavailable." },
    processFactory: input => {
      const child = spawn(process.execPath, [input.command, ...input.args], {
        cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: false,
      });
      ownedChild = child;
      createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line);
        if (typeof message.id === "number" && requests.some(request => request.id === message.id && request.method === "thread/goal/get")) {
          if (typeof message.result?.goal?.status === "string") goalStatuses.push(message.result.goal.status);
        }
      });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: string) => { requests.push(JSON.parse(String(chunk))); return write(chunk); }) as typeof child.stdin.write;
      return child;
    }, timeoutMs: 10_000, startupTimeoutMs: 10_000, reconnectGraceMs: 100,
  });
  const deadline = setTimeout(() => abort.abort(), 30_000);
  try {
    const result = await engine.run({ runId: "TEST-bounded-native-goal", prompt: "Mark the active TEST Goal complete and summarize.",
      goalObjective: "Exercise native Goal completion only.", workspacePath: workspace,
      model: "mimo-v2.6-pro", reasoningEffort: "high", sandboxMode: "read-only",
      session: { home, codexHome, env: { HOME: home, CODEX_HOME: codexHome,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TEST_DUMMY_MIMO_KEY: "TEST_DUMMY_ONLY" }, release: async () => undefined },
      runner: new StaticRunner(""), redactor: new DefaultRedactor(), abortSignal: abort.signal,
    });
    expect(result.outputText).toBe("TEST_GOAL_COMPLETE");
    expect((await runStore.get({ runId: "TEST-bounded-native-goal" }))?.status).toBe("completed");
    expect(goalStatuses).toContain("complete");
    expect(requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(nativeFunctionResultObserved).toBe(true);
    expect(toolInventories).toHaveLength(2);
    for (const inventory of toolInventories) {
      expect(inventory).toContain("update_goal");
      expect(inventory.every(name => ["create_goal", "get_goal", "update_goal"].includes(name))).toBe(true);
    }
    const params = requests.find(request => request.method === "thread/start")!.params!;
    expect(params.environments).toEqual([]);
    expect(params.config.web_search).toBe("disabled");
    expect(params.config.features).toMatchObject({ goals: true, shell_tool: false, unified_exec: false,
      apps: false, multi_agent: false, default_mode_request_user_input: false,
      rollout_budget: { enabled: true, limit_tokens: 100_000 } });
    expect(params.config.tools.experimental_request_user_input).toEqual({ enabled: false });
  } finally {
    clearTimeout(deadline);
    try {
      await engine.dispose();
    } finally {
      if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
        await new Promise<void>(resolve => { ownedChild!.once("exit", () => resolve()); ownedChild!.kill("SIGKILL"); });
      }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 40_000);
