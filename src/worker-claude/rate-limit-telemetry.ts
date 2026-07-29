import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ClaudeRateLimitWindowName = "five_hour" | "seven_day";

export type ClaudeRateLimitWindowSnapshot = {
  readonly usedPercentage: number;
  readonly remainingPercentage: number;
  readonly resetsAt: Date;
};

export type ClaudeRateLimitTelemetrySnapshot = {
  readonly observedAt: Date;
  readonly version?: string;
  readonly model?: string;
  readonly windows: Partial<
    Record<ClaudeRateLimitWindowName, ClaudeRateLimitWindowSnapshot>
  >;
};

export interface ClaudeRateLimitTelemetrySource {
  readonly settingsPath?: string;
  prepare?(): Promise<void>;
  latest(): ClaudeRateLimitTelemetrySnapshot | null;
}

export type FileClaudeRateLimitTelemetryOptions = {
  readonly directory: string;
};

export class FileClaudeRateLimitTelemetry
  implements ClaudeRateLimitTelemetrySource
{
  readonly scriptPath: string;
  readonly settingsPath: string;
  readonly snapshotPath: string;

  constructor(options: FileClaudeRateLimitTelemetryOptions) {
    this.scriptPath = join(options.directory, "claude-rate-limit-statusline.mjs");
    this.settingsPath = join(options.directory, "claude-settings.json");
    this.snapshotPath = join(options.directory, "claude-rate-limit-snapshot.json");
  }

  async prepare(): Promise<void> {
    await mkdir(this.directoryPath(), { recursive: true, mode: 0o700 });
    await writeFile(this.scriptPath, statusLineScriptSource(), {
      mode: 0o700,
    });
    await writeFile(
      this.settingsPath,
      `${JSON.stringify(
        {
          statusLine: {
            type: "command",
            command: `CLAUDE_RATE_LIMIT_SNAPSHOT=${shellQuote(
              this.snapshotPath,
            )} node ${shellQuote(this.scriptPath)}`,
          },
          worktree: {
            bgIsolation: "none",
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  latest(): ClaudeRateLimitTelemetrySnapshot | null {
    let raw: string;
    try {
      raw = readFileSync(this.snapshotPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }

    return parseClaudeRateLimitTelemetry(raw);
  }

  private directoryPath(): string {
    return dirname(this.settingsPath);
  }
}

export function parseClaudeRateLimitTelemetry(
  raw: string,
): ClaudeRateLimitTelemetrySnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const observedAt = dateFromIso(parsed.observedAt);
  if (!observedAt) return null;
  const windowsInput = parsed.windows;
  if (!isRecord(windowsInput)) return null;

  const windows: Partial<
    Record<ClaudeRateLimitWindowName, ClaudeRateLimitWindowSnapshot>
  > = {};
  for (const name of ["five_hour", "seven_day"] as const) {
    const window = parseWindowSnapshot(windowsInput[name]);
    if (window) windows[name] = window;
  }

  return {
    observedAt,
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    windows,
  };
}

function parseWindowSnapshot(
  value: unknown,
): ClaudeRateLimitWindowSnapshot | null {
  if (!isRecord(value)) return null;
  const usedPercentage = finiteNumber(value.usedPercentage);
  const resetsAt = dateFromIso(value.resetsAt);
  if (usedPercentage === null || !resetsAt) return null;
  return {
    usedPercentage,
    remainingPercentage: Math.max(0, 100 - usedPercentage),
    resetsAt,
  };
}

function statusLineScriptSource(): string {
  return `import fs from "node:fs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw);
    const windows = {};
    for (const name of ["five_hour", "seven_day"]) {
      const source = input.rate_limits?.[name];
      if (
        source &&
        Number.isFinite(source.used_percentage) &&
        Number.isFinite(source.resets_at)
      ) {
        windows[name] = {
          usedPercentage: source.used_percentage,
          resetsAt: new Date(source.resets_at * 1000).toISOString(),
        };
      }
    }
    if (Object.keys(windows).length > 0) {
      const snapshot = {
        observedAt: new Date().toISOString(),
        version: typeof input.version === "string" ? input.version : undefined,
        model: typeof input.model?.id === "string" ? input.model.id : undefined,
        windows,
      };
      const path = process.env.CLAUDE_RATE_LIMIT_SNAPSHOT;
      if (path) {
        const tmp = \`\${path}.\${process.pid}.tmp\`;
        fs.writeFileSync(tmp, JSON.stringify(snapshot));
        fs.renameSync(tmp, path);
      }
    }
  } catch {
    // Status line scripts must never break the Claude session.
  }
});
`;
}

function dateFromIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
