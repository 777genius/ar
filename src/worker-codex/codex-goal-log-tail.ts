import { open } from "node:fs/promises";

export const CODEX_GOAL_LOG_TAIL_MAX_READ_BYTES = 64 * 1024;
export const CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES = 16 * 1024;
export const CODEX_GOAL_LOG_TAIL_MAX_LINES = 1_000;

export const CODEX_GOAL_LOG_TAIL_TRUNCATION_MARKER =
  "[log tail truncated: earlier or oversized content omitted]\n";

export async function readBoundedCodexGoalLogTail(
  logPath: string,
  requestedLines: number,
): Promise<string> {
  const { lineLimit, hardCapApplied } = normalizedLineLimit(requestedLines);
  if (lineLimit === 0) return "";

  const handle = await open(logPath, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return "";

    const readLength = Math.min(size, CODEX_GOAL_LOG_TAIL_MAX_READ_BYTES);
    const start = Math.max(0, size - readLength);
    const buffer = Buffer.allocUnsafe(readLength);
    let bytesRead = 0;
    while (bytesRead < readLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        readLength - bytesRead,
        start + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    return formatBoundedTail(
      buffer.subarray(0, bytesRead),
      start > 0,
      lineLimit,
      hardCapApplied,
    );
  } finally {
    await handle.close();
  }
}

function normalizedLineLimit(requestedLines: number): {
  readonly lineLimit: number;
  readonly hardCapApplied: boolean;
} {
  if (Number.isNaN(requestedLines) || requestedLines <= 0) {
    return { lineLimit: 0, hardCapApplied: false };
  }
  if (!Number.isFinite(requestedLines)) {
    return { lineLimit: CODEX_GOAL_LOG_TAIL_MAX_LINES, hardCapApplied: true };
  }
  const floored = Math.floor(requestedLines);
  return {
    lineLimit: Math.min(floored, CODEX_GOAL_LOG_TAIL_MAX_LINES),
    hardCapApplied: floored > CODEX_GOAL_LOG_TAIL_MAX_LINES,
  };
}

function formatBoundedTail(
  bytes: Buffer,
  startsMidFile: boolean,
  lineLimit: number,
  hardCapApplied: boolean,
): string {
  let safeBytes = bytes;
  let truncated = startsMidFile;
  if (startsMidFile) {
    const firstNewline = bytes.indexOf(0x0a);
    if (firstNewline < 0) return CODEX_GOAL_LOG_TAIL_TRUNCATION_MARKER;
    safeBytes = bytes.subarray(firstNewline + 1);
  }

  const text = safeBytes.toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (hardCapApplied && lines.length > lineLimit) truncated = true;

  const selected = lines.slice(-lineLimit);
  return boundCodexGoalLogTailText(
    selected.length > 0 ? `${selected.join("\n")}\n` : "",
    truncated,
  );
}

export function boundCodexGoalLogTailText(
  text: string,
  contentWasTruncated = false,
): string {
  let body = text;
  let truncated = contentWasTruncated;
  while (body.startsWith(CODEX_GOAL_LOG_TAIL_TRUNCATION_MARKER)) {
    truncated = true;
    body = body.slice(CODEX_GOAL_LOG_TAIL_TRUNCATION_MARKER.length);
  }

  const lines = body.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const markerBytes = Buffer.byteLength(CODEX_GOAL_LOG_TAIL_TRUNCATION_MARKER);
  const contentBudget = CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES - markerBytes;
  const retained: string[] = [];
  let retainedBytes = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line) + 1;
    if (lineBytes > contentBudget || retainedBytes + lineBytes > contentBudget) {
      truncated = true;
      break;
    }
    retained.unshift(line);
    retainedBytes += lineBytes;
  }

  const content = retained.length > 0 ? `${retained.join("\n")}\n` : "";
  return truncated
    ? `${CODEX_GOAL_LOG_TAIL_TRUNCATION_MARKER}${content}`
    : content;
}
