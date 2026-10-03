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
  dispatch(call: HostedControllerDynamicToolCall, signal: AbortSignal): Promise<{
    readonly status: "disabled" | "unavailable";
  }>;
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
