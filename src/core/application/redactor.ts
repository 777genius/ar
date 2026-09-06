import { BoundaryViolationError } from "../domain/errors";
import type { RedactedTextStream, RedactorPort } from "../ports";
import { DefaultRedactedTextStream } from "./redacted-text-stream";

const textDecoder = new TextDecoder();

export class DefaultRedactor implements RedactorPort {
  private readonly secrets = new Map<string, string>();

  registerSecret(value: string | Uint8Array, label = "secret"): void {
    const normalized =
      typeof value === "string" ? value : textDecoder.decode(value);
    if (normalized.length === 0) {
      return;
    }
    this.secrets.set(normalized, label);
  }

  redact(input: string): string {
    return this.redactWithPreviousCharacter(input);
  }

  private redactWithPreviousCharacter(
    input: string,
    previousInputChar?: string,
  ): string {
    let output = input;
    for (const [secret, label] of this.secrets.entries()) {
      output = output.split(secret).join(`[redacted:${label}]`);
    }
    output = output.replace(
      /["']?\b(?:access_token|refresh_token|id_token|api_key|token)\b["']?\s*[:=]\s*["']?[^"',}\s]+["']?/gi,
      (match, offset: number) => {
        if (
          offset === 0 &&
          isWordCharacter(previousInputChar) &&
          !startsWithQuote(match)
        ) return match;
        const key = match.match(/["']?([A-Za-z_]+)["']?\s*[:=]/)?.[1];
        return `${key ?? "token"}=[redacted:token-field]`;
      },
    );
    output = output.replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
      (match, offset: number) =>
        offset === 0 && isWordCharacter(previousInputChar)
          ? match
          : "Bearer [redacted]",
    );
    return output;
  }

  createTextStream(): RedactedTextStream {
    return new DefaultRedactedTextStream(
      (input, previousInputChar) =>
        this.redactWithPreviousCharacter(input, previousInputChar),
      () => Array.from(this.secrets.keys()),
    );
  }

  assertNoKnownSecret(input: string, context: string): void {
    for (const secret of this.secrets.keys()) {
      if (input.includes(secret)) {
        throw new BoundaryViolationError(
          `Known secret leaked through ${context}`,
        );
      }
    }
  }
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function startsWithQuote(value: string): boolean {
  return value.startsWith('"') || value.startsWith("'");
}

export class NullObservability {
  emit(): void {}
  count(): void {}
  timing(): void {}
}

export class SystemClock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    return performance.now();
  }
}

export class DeterministicIdGenerator {
  private next = 1;

  leaseId(): string {
    return `lease-${this.next++}`;
  }

  idempotencyKey(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly purpose: string;
  }): string {
    return [
      input.providerInstanceId,
      input.runId,
      String(input.attempt),
      input.purpose,
    ].join(":");
  }

  operationId(prefix: string): string {
    return `${prefix}-${this.next++}`;
  }
}
