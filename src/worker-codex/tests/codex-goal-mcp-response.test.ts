import { describe, expect, it } from "vitest";

import { preserveTerminalHandoffBeforeStop, DurableHandoffStopError } from
  "../codex-goal-preserve-before-stop";
import { withMcpErrors } from "../codex-goal-mcp-response";

describe("codex goal MCP error response", () => {
  it.each(["throw", "missing_refs"] as const)(
    "returns retained PRE-STOP refs after terminal capture fails (%s)", async (mode) => {
      let captures = 0;
      let stops = 0;
      const result = await withMcpErrors(async () => {
        await preserveTerminalHandoffBeforeStop({
          materialize: async () => {
            if (++captures === 1) return {
              packetPath: "/durable/pre-stop.packet", manifestSha256: "b".repeat(64),
            };
            if (mode === "throw") throw new Error("terminal capture failed");
            return { errorCode: "capture_failed" };
          },
          stop: () => { stops++; return "terminated"; },
        });
        throw new Error("unexpected success");
      });
      expect(stops).toBe(1);
      expect(captures).toBe(2);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        handoffPacketPath: "/durable/pre-stop.packet",
        handoffManifestSha256: "b".repeat(64),
        handoffPacketProvenance: "PRE-STOP",
      });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
    },
  );

  it("preserves verified durable handoff evidence on stop failure", async () => {
    const result = await withMcpErrors(async () => {
      throw new DurableHandoffStopError({
        packetPath: "/durable/task.packet",
        manifestSha256: "a".repeat(64),
      }, new Error("tmux stop failed"));
    });

    expect(result.structuredContent).toEqual({
      ok: false,
      error: "tmux stop failed",
      handoffPacketPath: "/durable/task.packet",
      handoffManifestSha256: "a".repeat(64),
    });
  });
});
