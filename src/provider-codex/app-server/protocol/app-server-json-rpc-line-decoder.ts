const defaultMaxJsonRpcFrameBytes = 4 * 1024 * 1024;
const maxJsonRpcFrameBytes = 64 * 1024 * 1024;

/**
 * Incrementally separates UTF-8 JSON-RPC frames without retaining an
 * unterminated provider payload beyond the configured bound. The app-server
 * stream has already decoded UTF-8, so byte accounting is still required for
 * non-ASCII frames.
 */
export class AppServerJsonRpcLineDecoder {
  private buffered = "";
  private bufferedBytes = 0;

  constructor(private readonly maxFrameBytes: number) {}

  write(chunk: string, onFrame: (line: string) => boolean | void): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) {
        this.appendPartial(chunk.slice(start));
        return;
      }
      const fragment = chunk.slice(start, newline);
      const frameBytes = this.bufferedBytes + Buffer.byteLength(fragment, "utf8");
      if (frameBytes > this.maxFrameBytes) throw this.limitError();
      const line = this.buffered ? this.buffered + fragment : fragment;
      this.clear();
      if (onFrame(line) === false) return;
      start = newline + 1;
    }
  }

  clear(): void {
    this.buffered = "";
    this.bufferedBytes = 0;
  }

  private appendPartial(fragment: string): void {
    const fragmentBytes = Buffer.byteLength(fragment, "utf8");
    if (this.bufferedBytes + fragmentBytes > this.maxFrameBytes) {
      throw this.limitError();
    }
    this.buffered += fragment;
    this.bufferedBytes += fragmentBytes;
  }

  private limitError(): Error {
    return new Error("codex_app_server_json_rpc_frame_limit_exceeded");
  }
}

/**
 * A completed item may contain JSON-escaped output. This leaves headroom for
 * the normal 512 KiB output contract while retaining a finite frame bound for
 * callers that explicitly choose a larger output limit.
 */
export function appServerJsonRpcFrameLimit(maxOutputBytes: number): number {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("codex_app_server_max_output_bytes_invalid");
  }
  // JSON may expand a byte into a six-character \uXXXX escape sequence.
  const outputHeadroom = maxOutputBytes * 6 + 64 * 1024;
  if (outputHeadroom > maxJsonRpcFrameBytes) {
    throw new Error("codex_app_server_max_output_bytes_frame_limit_exceeded");
  }
  return Math.max(defaultMaxJsonRpcFrameBytes, outputHeadroom);
}
