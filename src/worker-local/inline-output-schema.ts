import { createHash } from "node:crypto";

export type InlineOutputSchemaTask = {
  readonly outputSchemaName?: string;
  readonly controls?: {
    readonly outputSchemaName?: string;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
  };
};

export function resolveInlineOutputSchemas(
  task: InlineOutputSchemaTask,
): {
  readonly name: string;
  readonly digest: string;
  readonly schemas: Readonly<Record<string, unknown>>;
} | undefined {
  const schema = task.controls?.outputSchema;
  const taskName = task.outputSchemaName;
  const controlName = task.controls?.outputSchemaName;
  const name = controlName ?? taskName;
  if (schema === undefined) return undefined;
  const digest = createHash("sha256")
    .update(canonicalJson(schema))
    .digest("hex");
  const resolvedName = name ?? `inline-${digest.slice(0, 16)}`;
  return {
    name: resolvedName,
    digest,
    schemas: { [resolvedName]: schema },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
