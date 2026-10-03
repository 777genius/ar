import type { RedactedTextStream } from "../ports";

const maxPendingChars = 8 * 1024;
const keywordCarryChars = 14;
const tokenFieldKey = /["']?\b(?:access_token|refresh_token|id_token|api_key|token)\b["']?/gi;
const bearerPrefix = "Bearer";
const completeTokenField = /["']?\b(?:access_token|refresh_token|id_token|api_key|token)\b["']?\s*[:=]\s*["']?[^"',}\s]+["']?/gi;
const completeBearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

type Redact = (input: string, previousInputChar?: string) => string;

/**
 * Emits only a prefix which cannot become a known secret or a built-in token
 * pattern once a following text chunk arrives. Potential token values stay in
 * a bounded private carry until their delimiter is observed.
 */
export class DefaultRedactedTextStream implements RedactedTextStream {
  private pending = "";
  private closed = false;
  private previousInputContext = "";

  constructor(
    private readonly redact: Redact,
    private readonly secrets: () => readonly string[],
  ) {}

  push(input: string): string {
    this.assertOpen();
    this.pending += input;
    return this.emitSafePrefix();
  }

  flush(): string {
    this.assertOpen();
    this.closed = true;
    const output = this.redact(this.pending, this.previousInputContext.at(-1));
    this.pending = "";
    return output;
  }

  discard(): void {
    this.pending = "";
    this.closed = true;
  }

  private emitSafePrefix(): string {
    const secrets = this.secrets();
    const secretCarry = longestSecretPrefixSuffix(this.pending, secrets)
      .length;
    const patternStart = earliestPotentialPatternStart(
      this.pending,
      this.previousInputContext.at(-1),
    );
    let safeEnd = Math.min(
      Math.max(0, this.pending.length - secretCarry),
      Math.max(0, this.pending.length - keywordCarryChars),
      patternStart ?? this.pending.length,
    );
    for (const secret of secrets) {
      for (
        let start = this.pending.indexOf(secret);
        start !== -1;
        start = this.pending.indexOf(secret, start + 1)
      ) {
        if (start < safeEnd && start + secret.length > safeEnd) {
          safeEnd = start;
          break;
        }
      }
    }
    safeEnd = avoidSplittingRedactionMatch(
      this.pending,
      safeEnd,
      completeTokenField,
      this.previousInputContext.at(-1),
      true,
    );
    safeEnd = avoidSplittingRedactionMatch(
      this.pending,
      safeEnd,
      completeBearer,
      this.previousInputContext.at(-1),
    );
    const safePrefix = this.pending.slice(0, safeEnd);
    const output = this.redactSafePrefix(safePrefix);
    if (safePrefix) {
      this.previousInputContext = (this.previousInputContext + safePrefix).slice(
        -keywordCarryChars,
      );
    }
    this.pending = this.pending.slice(safeEnd);
    if (this.pending.length > maxPendingChars) {
      this.discard();
      throw new Error("redacted_text_stream_pending_limit_exceeded");
    }
    return output;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("redacted_text_stream_closed");
  }

  private redactSafePrefix(input: string): string {
    return this.redact(input, this.previousInputContext.at(-1));
  }
}

function longestSecretPrefixSuffix(
  input: string,
  secrets: readonly string[],
): string {
  let longest = "";
  for (const secret of secrets) {
    const maximum = Math.min(secret.length - 1, input.length);
    for (let length = maximum; length > longest.length; length -= 1) {
      const suffix = input.slice(-length);
      if (secret.startsWith(suffix)) {
        longest = suffix;
        break;
      }
    }
  }
  return longest;
}

function avoidSplittingRedactionMatch(
  input: string,
  safeEnd: number,
  pattern: RegExp,
  previousInputChar: string | undefined,
  quotedStartHasBoundary = false,
): number {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  let adjusted = safeEnd;
  while ((match = pattern.exec(input)) !== null) {
    if (
      !hasWordBoundaryBefore(
        input,
        match.index,
        previousInputChar,
        quotedStartHasBoundary,
      )
    ) continue;
    if (match.index < adjusted && match.index + match[0].length > adjusted) {
      adjusted = match.index;
    }
  }
  return adjusted;
}

function earliestPotentialPatternStart(
  input: string,
  previousInputChar: string | undefined,
): number | undefined {
  const candidates = [
    earliestTokenFieldStart(input, previousInputChar),
    earliestBearerStart(input, previousInputChar),
  ].filter((value): value is number => value !== undefined);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function earliestTokenFieldStart(
  input: string,
  previousInputChar: string | undefined,
): number | undefined {
  tokenFieldKey.lastIndex = 0;
  let match: RegExpExecArray | null;
  let earliest: number | undefined;
  while ((match = tokenFieldKey.exec(input)) !== null) {
    if (!hasWordBoundaryBefore(input, match.index, previousInputChar, true)) continue;
    const tail = input.slice(match.index + match[0].length);
    if (
      /^\s*$/.test(tail) ||
      /^\s*(?::|=)(?:\s|["'])*[^"',}\s]*$/.test(tail)
    ) {
      earliest = Math.min(earliest ?? match.index, match.index);
    }
  }
  return earliest;
}

function earliestBearerStart(
  input: string,
  previousInputChar: string | undefined,
): number | undefined {
  let earliest: number | undefined;
  for (let index = input.indexOf(bearerPrefix); index !== -1; index = input.indexOf(bearerPrefix, index + 1)) {
    if (!hasWordBoundaryBefore(input, index, previousInputChar)) continue;
    const tail = input.slice(index);
    if (
      bearerPrefix.startsWith(tail) ||
      /^Bearer\s+[A-Za-z0-9._~+/=-]*$/.test(tail)
    ) {
      earliest = Math.min(earliest ?? index, index);
    }
  }
  return earliest;
}

function hasWordBoundaryBefore(
  input: string,
  start: number,
  previousInputChar: string | undefined,
  quotedStartHasBoundary = false,
): boolean {
  if (quotedStartHasBoundary && (input[start] === '"' || input[start] === "'")) {
    return true;
  }
  const previous = start === 0 ? previousInputChar : input[start - 1];
  return previous === undefined || !/[A-Za-z0-9_]/.test(previous);
}
