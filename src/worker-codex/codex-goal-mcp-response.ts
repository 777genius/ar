import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProjectAdmissionDecisionReason, ProjectControlAdmissionDeniedError } from "@vioxen/subscription-runtime/worker-core";
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
      ...(error instanceof ProjectControlAdmissionDeniedError ? {
        admission: {
          allowed: false,
          reason: error.decision.reason,
          ...(error.decision.summary?.target.canonicalPath ? {
            resource: error.decision.summary.target.canonicalPath
              .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240),
          } : {}),
          examples: error.decision.debt.slice(0, 2).map((item) => ({
            reason: item.reason,
            subject: item.subject.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240),
          })),
          action: admissionDeniedAction(error.decision.reason),
        },
      } : {}),
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

function admissionDeniedAction(reason: ProjectAdmissionDecisionReason): string {
  switch (reason) {
    case ProjectAdmissionDecisionReason.DiskPressure:
      return "Free space on the reported storage before retrying.";
    case ProjectAdmissionDecisionReason.SnapshotStale:
    case ProjectAdmissionDecisionReason.SnapshotUnavailable:
      return "Refresh project state before retrying; the current observation cannot authorize this operation.";
    case ProjectAdmissionDecisionReason.UnreadableProjectState:
      return "Inspect the reported target or control registry and restore readable state before retrying.";
    default:
      return "Inspect the reported resource and owner; use an independent sibling workspace for conflicting writes.";
  }
}
