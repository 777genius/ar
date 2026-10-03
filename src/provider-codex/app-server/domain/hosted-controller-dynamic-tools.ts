import { KeyedChildState, KeyedLaunchReason } from "@vioxen/subscription-runtime/core";
/** Codex CLI 0.155.1 experimental DynamicToolSpec and DynamicToolCallResponse. */
export enum HostedControllerToolName {
  Launch = "launch",
  Observe = "observe",
  Stop = "stop",
}

export type HostedControllerDynamicToolCall = {
  readonly tool: HostedControllerToolName;
  readonly arguments: Readonly<Record<string, string>>;
};

/** Host-owned transport port. This port conveys no caller-selected origin,
 * project, account, path, or command. The host must bind its peer to retained
 * origin and private grant before enabling the profile. */
export interface HostedControllerDynamicToolAdapter {
  dispatch(call: HostedControllerDynamicToolCall, signal: AbortSignal): Promise<HostedControllerToolResult>;
}

const stringField = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
export const hostedControllerDynamicToolSpecs = [
  { type: "function", name: HostedControllerToolName.Launch,
    description: "Request one preallocated child slot. Currently unavailable.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { key: stringField(128), profile: { type: "string", enum: ["isolated-write", "read-only"] }, task: stringField(4000) },
      required: ["key", "profile", "task"] } },
  { type: "function", name: HostedControllerToolName.Observe,
    description: "Read the brief status of an authorized opaque operation handle. Currently unavailable.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { handle: stringField(128) }, required: ["handle"] } },
  { type: "function", name: HostedControllerToolName.Stop,
    description: "Request stop for an authorized opaque operation handle. Currently unavailable.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { handle: stringField(128) }, required: ["handle"] } },
] as const;

export function parseHostedControllerToolCall(tool: unknown, args: unknown): HostedControllerDynamicToolCall | null {
  if (tool !== HostedControllerToolName.Launch && tool !== HostedControllerToolName.Observe && tool !== HostedControllerToolName.Stop) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const fields = args as Record<string, unknown>;
  const required = tool === HostedControllerToolName.Launch ? ["key", "profile", "task"] : ["handle"];
  if (Object.keys(fields).sort().join(",") !== [...required].sort().join(",")) return null;
  if (required.some((key) => typeof fields[key] !== "string" || !(fields[key] as string).length)) return null;
  if (tool === HostedControllerToolName.Launch) {
    if ((fields.key as string).length > 128 || (fields.task as string).length > 4000 ||
        (fields.profile !== "isolated-write" && fields.profile !== "read-only")) return null;
  } else if ((fields.handle as string).length > 128) return null;
  return { tool, arguments: fields as Record<string, string> };
}

/** Bounded shared projection. No private correlations, paths or error messages. */
export enum HostedControllerResultStatus { Accepted = "accepted", Observed = "observed", StopRequested = "stop_requested", Rejected = "rejected" }
export enum HostedControllerError { Denied = "denied", Conflict = "conflict", Occupied = "occupied", Unresolved = "unresolved" }
export type HostedControllerToolResult =
  | { readonly status: "disabled" | "unavailable" }
  | { readonly status: HostedControllerResultStatus.Rejected; readonly error: HostedControllerError }
  | { readonly status: HostedControllerResultStatus.Accepted | HostedControllerResultStatus.Observed | HostedControllerResultStatus.StopRequested;
      readonly view: import("@vioxen/subscription-runtime/core").KeyedLaunchView };

export function parseHostedControllerToolResult(raw: unknown): HostedControllerToolResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (["disabled", "unavailable"].includes(r.status as string)) return Object.keys(r).join(",") === "status" ? r as HostedControllerToolResult : null;
  if (r.status === HostedControllerResultStatus.Rejected) return Object.keys(r).sort().join(",") === "error,status" &&
    Object.values(HostedControllerError).includes(r.error as HostedControllerError) ? r as HostedControllerToolResult : null;
  if (![HostedControllerResultStatus.Accepted, HostedControllerResultStatus.Observed, HostedControllerResultStatus.StopRequested].includes(r.status as HostedControllerResultStatus) ||
      Object.keys(r).sort().join(",") !== "status,view" || !r.view || typeof r.view !== "object" || Array.isArray(r.view)) return null;
  const v = r.view as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "childHandle,deadlineEpochMs,maxGoalTurns,occupied,operationHandle,reason,state,stopRequested" ||
      ![v.childHandle, v.operationHandle].every(h => typeof h === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(h)) ||
      !Object.values(KeyedChildState).includes(v.state as KeyedChildState) ||
      !Object.values(KeyedLaunchReason).includes(v.reason as KeyedLaunchReason) ||
      typeof v.occupied !== "boolean" || typeof v.stopRequested !== "boolean" ||
      !Number.isSafeInteger(v.deadlineEpochMs) || (v.deadlineEpochMs as number) < 1 ||
      !Number.isSafeInteger(v.maxGoalTurns) || (v.maxGoalTurns as number) < 1 ||
      v.occupied !== (v.state !== "terminal") || v.stopRequested !== (v.state === "stop_requested")) return null;
  return r as HostedControllerToolResult;
}
