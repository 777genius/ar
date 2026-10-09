import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";
const peer = vi.hoisted(() => ({ requests: [] as MimoProjectBridgeRequest[] }));
vi.mock("../mimo-project-bridge-client", async importOriginal => {
  const original = await importOriginal<typeof import("../mimo-project-bridge-client")>();
  return { ...original, delegateMimoProjectOperation: (operation: Parameters<typeof original.delegateMimoProjectOperation>[0], args: Parameters<typeof original.delegateMimoProjectOperation>[1]) =>
    original.delegateMimoProjectOperation(operation, args, {
      routes: [{ projectId: "test-project", workstreamId: "test-work", host: "test-host", machineId: "a".repeat(32), socketDir: "/private/tmp/test-mimo-sockets" }],
      transport: async () => ({ request: async request => {
        peer.requests.push(request);
        return { ok: true, jobId: request.jobId, pending: true, operation: request.operation };
      } }),
    }),
  };
});
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
beforeEach(() => { peer.requests = []; });
describe("public MCP schema for remote MiMo project workers", () => {
  it("accepts real create/refill/start/status/stop calls without local paths or controller IDs", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "test-remote-mimo-schema", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const identity = { mimoProjectId: "test-project", mimoWorkstreamId: "test-work", jobId: "test-worker" };
      const calls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }> = [
        { name: "codex_goal_project_create_job", arguments: { ...identity, promptBody: "Harmless TEST edit", sourceCommit: "b".repeat(40), confirmCreate: true } },
        { name: "codex_goal_project_refill_worker", arguments: { ...identity, promptBody: "Harmless TEST edit", expectedSourceCommit: "b".repeat(40), confirmRefill: true, startWorker: false } },
        { name: "codex_goal_project_start", arguments: { ...identity, confirmStart: true } },
        { name: "codex_goal_status_by_id", arguments: identity },
        { name: "codex_goal_project_stop", arguments: { ...identity, confirmStop: true } },
      ];
      const inventory = await client.listTools();
      for (const call of calls) {
        const metadata = inventory.tools.find(tool => tool.name === call.name);
        expect(metadata?.inputSchema.properties).toHaveProperty("mimoProjectId");
        expect(metadata?.inputSchema.properties).toHaveProperty("mimoWorkstreamId");
        const result = await client.callTool(call);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, pending: true });
      }
      expect(peer.requests.map(request => request.operation)).toEqual(["create", "create", "start", "status", "stop"]);
      for (const request of peer.requests) {
        expect(request).not.toHaveProperty("workspacePath"); expect(request).not.toHaveProperty("controllerJobId");
      }
      expect(peer.requests[0]).toMatchObject({ prompt: "Harmless TEST edit", sourceCommit: "b".repeat(40) });
    } finally { await client.close(); await server.close(); }
  });
});
