import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DurableHandoffPostStopError, DurableHandoffStopError } from "./codex-goal-preserve-before-stop";

type JsonObject = Readonly<Record<string, unknown>>;

export function mcpJson(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export async function withMcpErrors(
  action: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    const handoff = durableHandoffErrorEvidence(error);
    const value = {
      ok: false,
      error: error instanceof Error ? error.message : "codex_goal_mcp_error",
      ...handoff,
    };
    return {
      ...mcpJson(value),
      isError: true,
    };
  }
}

function durableHandoffErrorEvidence(
  error: unknown,
): Readonly<Record<string, string>> {
  if (!(error instanceof DurableHandoffStopError) &&
    !(error instanceof DurableHandoffPostStopError)) return {};
  const handoff = error instanceof DurableHandoffPostStopError
    ? error.preStopHandoff
    : error.handoff;
  const packetPath = handoff.packetPath;
  const manifestSha256 = handoff.manifestSha256;
  return typeof packetPath === "string" &&
      typeof manifestSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(manifestSha256)
    ? {
        handoffPacketPath: packetPath,
        handoffManifestSha256: manifestSha256,
        ...(error instanceof DurableHandoffPostStopError
          ? { handoffPacketProvenance: "PRE-STOP" }
          : {}),
      }
    : {};
}
