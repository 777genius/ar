import type { RedactorPort } from "@vioxen/subscription-runtime/core";

const maxLegacyBufferedChars = 512 * 1024;

function providerStreamError(error: unknown): unknown {
  return error instanceof Error &&
      error.message.includes("redacted_text_stream_pending_limit_exceeded")
    ? new Error("codex_stream_output_invalid:pending_limit_exceeded", {
        cause: error,
      })
    : error;
}

/** Adapts the core stream capability and fails closed for legacy redactors. */
export function createCodexTextDeltaRedactor(input: {
  readonly redactor: RedactorPort;
  readonly onTextDelta: (text: string) => void;
  readonly abortController: AbortController;
}): {
  push(text: string): void;
  flush(): void;
  discard(): void;
} {
  const stream = input.redactor.createTextStream?.();
  let legacyBuffer = "";
  let closed = false;

  const emit = (text: string): void => {
    if (!text) return;
    try {
      input.redactor.assertNoKnownSecret(text, "codex-app-server-text-delta");
      input.onTextDelta(text);
    } catch (error) {
      input.abortController.abort(error);
      throw error;
    }
  };

  return {
    push(text): void {
      if (closed) throw new Error("codex_text_delta_redactor_closed");
      try {
        if (stream) {
          emit(stream.push(text));
          return;
        }
        legacyBuffer += text;
        if (legacyBuffer.length > maxLegacyBufferedChars) {
          legacyBuffer = "";
          throw new Error("codex_stream_output_invalid:legacy_buffer_limit_exceeded");
        }
      } catch (error) {
        const providerError = providerStreamError(error);
        input.abortController.abort(providerError);
        throw providerError;
      }
    },
    flush(): void {
      if (closed) return;
      closed = true;
      try {
        emit(stream ? stream.flush() : input.redactor.redact(legacyBuffer));
      } catch (error) {
        const providerError = providerStreamError(error);
        input.abortController.abort(providerError);
        throw providerError;
      } finally {
        legacyBuffer = "";
      }
    },
    discard(): void {
      legacyBuffer = "";
      closed = true;
      stream?.discard();
    },
  };
}
