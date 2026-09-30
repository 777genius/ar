import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { HostedControllerToolName } from "../../app-server/domain/hosted-controller-dynamic-tools";
import { handleAppServerServerRequest } from "../../app-server/application/app-server-server-request-handler";

describe("Codex 0.155.1 dynamic tool contract", () => {
  it("keeps the nonhosted unsupported request response", () => {
    const errors: string[] = [];
    handleAppServerServerRequest({ id: 1, method: "item/tool/call", params: null,
      warn: () => undefined, respond: () => { throw new Error("unexpected result"); },
      respondError: (_id, message) => errors.push(message) });
    expect(errors).toEqual(["unsupported_server_request:item/tool/call"]);
  });
  it("advertises only three bounded tools and replies to string and numeric IDs with no submission", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dynamic-tool-contract-"));
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true });
    const abort = new AbortController();
    let submissions = 0;
    let cancelled = 0;
    const client = new CodexAppServerClient({
      codexBinaryPath: "/bin/codex-test", sourceEnv: {}, processFactory: factory.create,
      signalChildProcess: (child, signal) => { child.kill(signal); },
      session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
      workspacePath: workspace, executionProfile: resolveCodexExecutionProfile({
        kind: "custom", disableTools: false, historyMode: "none",
      }),
      nativeToolSurface: "disabled", timeoutMs: 2_000, startupTimeoutMs: 2_000,
      reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal: abort.signal,
      hostedControllerTools: { dispatch: async (call, signal) => {
        submissions += 1;
        if (call.arguments.handle === "cancel") return await new Promise((resolve) => {
          signal.addEventListener("abort", () => { cancelled += 1; resolve({ status: "unavailable" }); }, { once: true });
        });
        return { status: "disabled" };
      } },
    });
    try {
      await client.start();
      const threadId = await client.startThread({ workspacePath: workspace, model: "test",
        reasoningEffort: "low", timeoutMs: 2_000, abortSignal: abort.signal, goalMode: true });
      const start = factory.requests.find((request) => request.method === "thread/start");
      expect(start?.params?.dynamicTools).toHaveLength(3);
      expect((start?.params?.config as Record<string, any>).features).toMatchObject({ shell_tool: false, unified_exec: false });
      expect(start?.params?.environments).toEqual([]);
      const turn = client.startTurn({ threadId, prompt: "test", model: "test", reasoningEffort: "low",
        workspacePath: workspace, timeoutMs: 2_000, abortSignal: abort.signal, goalMode: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const send = (id: string | number, params: Record<string, unknown>) => factory.processes[0]!.stdout.emit("data",
        `${JSON.stringify({ id, method: "item/tool/call", params })}\n`);
      const valid = { threadId, turnId: "turn-1", callId: "call-1", namespace: null,
        tool: HostedControllerToolName.Observe, arguments: { handle: "opaque" } };
      send("request-a", valid);
      send(19, { ...valid, callId: "call-2" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => response.id === "request-a" || response.id === 19))
        .toEqual([{ id: "request-a", result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } },
          { id: 19, result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } }]);
      send(20, { ...valid, callId: "call-2" });
      send("request-a", { ...valid, callId: "call-replayed-request" });
      send(21, { ...valid, callId: "call-3", threadId: "foreign" });
      send(22, { ...valid, callId: "call-4", arguments: { handle: "opaque", command: "sh" } });
      send(23, { ...valid, callId: "call-5", arguments: { handle: "x".repeat(129) } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => [20, 21, 22, 23].includes(response.id as number)).map((r) =>
        (r.result as any).contentItems[0].text)).toEqual([
          "hosted_controller_unavailable", "hosted_controller_unavailable",
          "hosted_controller_unavailable", "hosted_controller_unavailable",
        ]);
      expect(Math.max(...factory.responses.map((response) => Buffer.byteLength(JSON.stringify(response))))).toBeLessThan(256);
      expect(factory.responses.filter((response) => response.id === "request-a").at(-1)?.result as any)
        .toMatchObject({ success: false, contentItems: [{ text: "hosted_controller_unavailable" }] });
      send(24, { ...valid, callId: "call-7", tool: HostedControllerToolName.Launch,
        arguments: { key: "slot-key", profile: "isolated-write", task: "Synthetic task" } });
      send(25, { ...valid, callId: "call-8", tool: HostedControllerToolName.Stop });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => response.id === 24 || response.id === 25).map((r) =>
        (r.result as any).contentItems[0].text)).toEqual(["hosted_controller_disabled", "hosted_controller_disabled"]);
      expect(submissions).toBe(4);
      send("cancelled", { ...valid, callId: "call-6", arguments: { handle: "cancel" } });
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ method: "serverRequest/resolved",
        params: { threadId: "foreign", requestId: "cancelled" } })}\n`);
      expect(cancelled).toBe(0);
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ method: "serverRequest/resolved",
        params: { threadId, requestId: "cancelled" } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cancelled).toBe(1);
      expect(factory.responses.some((response) => response.id === "cancelled")).toBe(false);
      expect(submissions).toBe(5);
      abort.abort();
      await turn.catch(() => undefined);
    } finally {
      await client.stop(); await rm(workspace, { recursive: true, force: true });
    }
  });
});
