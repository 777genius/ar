import { mcpJson } from "./codex-goal-mcp-response";

type JsonObject = Readonly<Record<string, unknown>>;

export const MAX_CODEX_GOAL_BRIEF_COMPACT_MCP_ENVELOPE_BYTES = 64 * 1024;

export enum CodexGoalBriefCompactTruncationUnit {
  Bytes = "bytes",
  Items = "items",
  Keys = "keys",
  Depth = "depth",
}

type CompactLimits = Readonly<{
  stringBytes: number;
  arrayItems: number;
  objectKeys: number;
  depth: number;
  notices: number;
}>;

type TruncationNotice = Readonly<{
  field: string;
  omitted: number;
  unit: CodexGoalBriefCompactTruncationUnit;
}>;

type BoundedValue = Readonly<{
  value: unknown;
  notices: readonly TruncationNotice[];
  truncatedFieldCount: number;
}>;

const safetyKeys = new Set([
  "activeWriterRisk", "alive", "appServerProcessAlive", "blocked", "freshProgressAlive",
  "heartbeatOnlyNoOutput", "isStale", "risky", "safeToContinue", "silentStale", "stale",
  "tmuxAlive", "workerAlive", "workerFreshProgressAlive", "workerProcessAlive", "workspaceDirty",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateUtf8(value: string, maxBytes: number): readonly [string, number] {
  if (Buffer.byteLength(value) <= maxBytes) return [value, 0];
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return [value.slice(0, end), Buffer.byteLength(value) - bytes];
}

function isPreservedObjectPath(field: string): boolean {
  return field === "brief" || field === "brief.brief" || field === "brief.status" ||
    field === "brief.brief.workerHealth" || field === "brief.brief.statusView";
}

function boundedValue(
  value: unknown,
  limits: CompactLimits,
  field: string,
  depth = 0,
): BoundedValue {
  const notices: TruncationNotice[] = [];
  let truncatedFieldCount = 0;
  const note = (omitted: number, unit: CodexGoalBriefCompactTruncationUnit): void => {
    truncatedFieldCount += 1;
    if (notices.length < limits.notices) notices.push({ field, omitted, unit });
  };
  if (typeof value === "string") {
    if (field === "brief.revision") return { value, notices, truncatedFieldCount };
    const [truncated, omitted] = truncateUtf8(value, limits.stringBytes);
    if (omitted > 0) note(omitted, CodexGoalBriefCompactTruncationUnit.Bytes);
    return { value: truncated, notices, truncatedFieldCount };
  }
  if (Array.isArray(value)) {
    if (depth >= limits.depth) {
      if (value.length > 0) note(value.length, CodexGoalBriefCompactTruncationUnit.Depth);
      return { value: [], notices, truncatedFieldCount };
    }
    const retained = value.slice(0, limits.arrayItems);
    if (value.length > retained.length) {
      note(value.length - retained.length, CodexGoalBriefCompactTruncationUnit.Items);
    }
    const children = retained.map((item, index) => boundedValue(
      item, limits, `${field}[${index}]`, depth + 1,
    ));
    return {
      value: children.map((child) => child.value),
      notices: [...notices, ...children.flatMap((child) => child.notices)].slice(0, limits.notices),
      truncatedFieldCount: truncatedFieldCount + children.reduce(
        (total, child) => total + child.truncatedFieldCount, 0,
      ),
    };
  }
  if (!isObject(value)) return { value, notices, truncatedFieldCount };
  const entries = Object.entries(value);
  const safetyEntries = entries.filter(([key]) => safetyKeys.has(key));
  const preservedPath = isPreservedObjectPath(field);
  if (depth >= limits.depth && !preservedPath) {
    const retainedSafetyEntries = safetyEntries;
    if (entries.length > retainedSafetyEntries.length) {
      note(entries.length - retainedSafetyEntries.length, CodexGoalBriefCompactTruncationUnit.Depth);
    }
    return boundedEntries(retainedSafetyEntries, limits, field, depth, notices, truncatedFieldCount);
  }
  const regularEntries = entries.filter(([key]) => !safetyKeys.has(key));
  const retained = preservedPath
    ? [...safetyEntries, ...regularEntries]
    : [...safetyEntries, ...regularEntries.slice(0, limits.objectKeys)];
  if (entries.length > retained.length) {
    note(entries.length - retained.length, CodexGoalBriefCompactTruncationUnit.Keys);
  }
  return boundedEntries(retained, limits, field, depth, notices, truncatedFieldCount);
}

function boundedEntries(
  entries: readonly (readonly [string, unknown])[],
  limits: CompactLimits,
  field: string,
  depth: number,
  notices: TruncationNotice[],
  truncatedFieldCount: number,
): BoundedValue {
  const output: Record<string, unknown> = {};
  for (const [index, [key, item]] of entries.entries()) {
    const [boundedKey] = truncateUtf8(key, limits.stringBytes);
    const outputKey = output[boundedKey] === undefined ? boundedKey : `${boundedKey}_${index}`;
    const child = boundedValue(item, limits, `${field}.${outputKey}`, depth + 1);
    output[outputKey] = child.value;
    notices.push(...child.notices);
    truncatedFieldCount += child.truncatedFieldCount;
  }
  return { value: output, notices: notices.slice(0, limits.notices), truncatedFieldCount };
}

function compactEnvelopeBytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(mcpJson(value)));
}

/** Bound the compact brief's actual MCP envelope, including duplicated text content. */
export function boundCodexGoalBriefCompactMcpEnvelope(value: JsonObject): JsonObject {
  const limits: readonly CompactLimits[] = [
    { stringBytes: 2_048, arrayItems: 64, objectKeys: 32, depth: 5, notices: 32 },
    { stringBytes: 1_024, arrayItems: 32, objectKeys: 24, depth: 4, notices: 24 },
    { stringBytes: 512, arrayItems: 16, objectKeys: 16, depth: 4, notices: 16 },
    { stringBytes: 256, arrayItems: 8, objectKeys: 12, depth: 3, notices: 12 },
    { stringBytes: 128, arrayItems: 4, objectKeys: 8, depth: 3, notices: 8 },
    { stringBytes: 64, arrayItems: 2, objectKeys: 6, depth: 2, notices: 6 },
    { stringBytes: 32, arrayItems: 1, objectKeys: 4, depth: 2, notices: 4 },
  ];
  for (const limit of limits) {
    const bounded = boundedValue(value, limit, "brief");
    const response = bounded.value as Record<string, unknown>;
    const candidate: JsonObject = bounded.truncatedFieldCount === 0
      ? response
      : {
        ...response,
        truncation: {
          truncated: true,
          omitted: bounded.notices,
          truncatedFieldCount: bounded.truncatedFieldCount,
          retrieval: "Use detail: 'full' for complete diagnostics, or includeLogTail: true to request the log tail.",
        },
      };
    if (compactEnvelopeBytes(candidate) <= MAX_CODEX_GOAL_BRIEF_COMPACT_MCP_ENVELOPE_BYTES) {
      return candidate;
    }
  }
  throw new Error("codex_goal_brief_compact_envelope_limit_unreachable");
}
