import { readRecord } from "../domain/app-server-record";

export { readRecord } from "../domain/app-server-record";

export function nestedString(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    const record = readRecord(current);
    current = record?.[segment];
  }
  return typeof current === "string" ? current : null;
}

export function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

export function stringArrayField(
  record: Record<string, unknown> | null,
  field: string,
): readonly string[] | null {
  const value = record?.[field];
  if (!Array.isArray(value)) return null;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length === value.length ? values : null;
}

export function agentMessageText(item: Record<string, unknown>): string | null {
  if (typeof item.text === "string") return item.text;
  return stringifyContent(item.text) ?? stringifyContent(item.content);
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyContentEntry(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (!isAssistantContentRecord(record)) return null;
    return stringifyContent(
      record.text ?? record.output_text ?? record.content ?? record.output,
    );
  }
  return null;
}

function stringifyContentEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (!isAssistantContentRecord(record)) return null;
  return stringifyContent(
    record.text ?? record.output_text ?? record.content ?? record.output,
  );
}

function isAssistantContentRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : null;
  if (!hasAssistantRole(record)) return false;
  return (
    !type ||
    type === "agentMessage" ||
    type === "agent_message" ||
    type === "assistant_message" ||
    type === "message" ||
    type === "output_text" ||
    type === "text"
  );
}

function hasAssistantRole(record: Record<string, unknown>): boolean {
  const role = record.role;
  return typeof role !== "string" || role === "assistant";
}
