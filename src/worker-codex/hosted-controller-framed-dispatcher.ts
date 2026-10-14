import { Duplex, type Readable, type Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { HostedControllerToolName, parseHostedControllerToolCall, type HostedControllerDynamicToolAdapter, type HostedControllerDynamicToolCall, type HostedControllerToolResult, parseHostedControllerToolResult } from "@vioxen/subscription-runtime/provider-codex";

import { assertHostedControllerKeyedToolAdapter, HostedControllerKeyedToolAdapter } from "./hosted-controller/tool-adapter";

export const hostedControllerFrameLimit = 16 * 1024;
/** Adapts systemd-run --pipe's separate stdout and stdin to one framed stream. */
export function hostedControllerPipe(readable: Readable, writable: Writable): Duplex {
  return Duplex.from({ readable, writable });
}
/** One bootstrap handoff. The relay does not parse or transform requests;
 * bounded endpoint decoders retain protocol authority. Closure is symmetric. */
export function relayHostedControllerPipe(upstream: Duplex, downstream: Duplex): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    upstream.unpipe(downstream);
    downstream.unpipe(upstream);
    upstream.destroy(); downstream.destroy();
  };
  upstream.on("error", close).on("end", close).on("close", close);
  downstream.on("error", close).on("end", close).on("close", close);
  upstream.pipe(downstream);
  downstream.pipe(upstream);
  return close;
}
export enum HostedControllerFrameKind {
  Request = "request",
  Response = "response",
  Cancel = "cancel",
}

type RequestFrame = { readonly version: 1; readonly kind: HostedControllerFrameKind.Request;
  readonly requestId: string; readonly deadlineMs: number; readonly tool: HostedControllerToolName;
  readonly arguments: Readonly<Record<string, string>> };
type ResponseFrame = { readonly version: 1; readonly kind: HostedControllerFrameKind.Response;
  readonly requestId: string; readonly status: "disabled" | "unavailable" };
type CancelFrame = { readonly version: 1; readonly kind: HostedControllerFrameKind.Cancel; readonly requestId: string };
type ResultFrame = { readonly version: 1; readonly kind: HostedControllerFrameKind.Response;
  readonly requestId: string; readonly result: HostedControllerToolResult };
type Reply = "disabled" | "unavailable" | HostedControllerToolResult;
type Frame = RequestFrame | ResponseFrame | ResultFrame | CancelFrame;

/** Stdio-only full-duplex protocol. The host must recheck the retained process
 * origin and private grant for every call; neither is accepted on wire. */
export class HostedControllerFramedDispatcher {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, { resolve: (status: Reply) => void; timer: NodeJS.Timeout }>();
  private readonly seen = new Set<string>();
  private readonly cancelledOutbound = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private closed = false;

  constructor(private readonly stream: Duplex, private readonly options: {
    readonly verifyRetainedOriginAndGrant?: () => boolean;
    readonly retainedTools?: HostedControllerKeyedToolAdapter;
  } = {}) {
    stream.on("data", (chunk: Buffer) => this.receive(Buffer.from(chunk)));
    stream.once("end", () => this.close());
    stream.once("close", () => this.close());
    stream.once("error", () => this.close());
  }

  async request(call: HostedControllerDynamicToolCall, signal: AbortSignal, timeoutMs = 5_000): Promise<Reply> {
    if (this.closed || signal.aborted || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000 || this.pending.size >= 16) return "unavailable";
    const requestId = randomUUID();
    const deadlineMs = Date.now() + timeoutMs;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (status: Reply, cancel = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(requestId);
        if (cancel) {
          if (this.cancelledOutbound.size >= 512) this.close();
          else this.cancelledOutbound.add(requestId);
          this.send({ version: 1, kind: HostedControllerFrameKind.Cancel, requestId });
        }
        resolve(status);
      };
      const abort = () => finish("unavailable", true);
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, { resolve: (status) => finish(status), timer });
      if (!this.send({ version: 1, kind: HostedControllerFrameKind.Request,
        requestId, deadlineMs, tool: call.tool, arguments: call.arguments })) finish("unavailable");
    });
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    if (chunk.length > hostedControllerFrameLimit * 16 + 64 ||
        this.buffer.length + chunk.length > hostedControllerFrameLimit * 16 + 64) return this.close();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > hostedControllerFrameLimit) return this.close();
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let frame: unknown;
      try { frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { return this.close(); }
      if (!this.accept(frame)) return this.close();
    }
  }

  private accept(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const frame = raw as Record<string, unknown>;
    if (frame.version !== 1 || typeof frame.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(frame.requestId)) return false;
    if (frame.kind === HostedControllerFrameKind.Response) {
      const typed = Object.keys(frame).sort().join(",") === "kind,requestId,result,version"
        ? parseHostedControllerToolResult(frame.result) : null;
      if (!typed && (Object.keys(frame).sort().join(",") !== "kind,requestId,status,version" ||
          (frame.status !== "disabled" && frame.status !== "unavailable"))) return false;
      const pending = this.pending.get(frame.requestId);
      if (!pending) return this.cancelledOutbound.has(frame.requestId);
      this.pending.delete(frame.requestId);
      pending.resolve(typed ?? frame.status as "disabled" | "unavailable");
      return true;
    }
    if (frame.kind === HostedControllerFrameKind.Cancel) {
      if (Object.keys(frame).sort().join(",") !== "kind,requestId,version") return false;
      const active = this.active.get(frame.requestId);
      if (!active) return this.seen.has(frame.requestId);
      active.abort();
      this.active.delete(frame.requestId);
      return true;
    }
    if (frame.kind !== HostedControllerFrameKind.Request ||
        Object.keys(frame).sort().join(",") !== "arguments,deadlineMs,kind,requestId,tool,version" ||
        !Number.isSafeInteger(frame.deadlineMs) || (frame.deadlineMs as number) <= Date.now() ||
        (frame.deadlineMs as number) > Date.now() + 5_000 || this.seen.has(frame.requestId) || this.seen.size >= 512 ||
        this.active.size >= 16) return false;
    if (frame.tool !== HostedControllerToolName.Launch && frame.tool !== HostedControllerToolName.Observe && frame.tool !== HostedControllerToolName.Stop) return false;
    if (!parseHostedControllerToolCall(frame.tool, frame.arguments)) return false;
    this.seen.add(frame.requestId);
    const controller = new AbortController();
    this.active.set(frame.requestId, controller);
    const delay = Math.max(1, (frame.deadlineMs as number) - Date.now());
    const timer = setTimeout(() => controller.abort(), delay);
    void (async () => {
      let status: Reply = "unavailable";
      try {
        if (this.options.retainedTools) {
          assertHostedControllerKeyedToolAdapter(this.options.retainedTools);
          status = await this.options.retainedTools.dispatch(parseHostedControllerToolCall(frame.tool, frame.arguments)!, controller.signal);
        } else if (this.options.verifyRetainedOriginAndGrant?.() === true) status = "disabled";
      } catch { /* Fail closed without exposing host detail. */ }
      finally { clearTimeout(timer); this.active.delete(frame.requestId as string); }
      if (!this.closed && !controller.signal.aborted) this.send({ version: 1,
        kind: HostedControllerFrameKind.Response, requestId: frame.requestId as string,
        ...(typeof status === "string" ? { status } : { result: status }) });
    })();
    return true;
  }

  private send(frame: Frame): boolean {
    if (this.closed) return false;
    const body = Buffer.from(JSON.stringify(frame));
    if (body.length > hostedControllerFrameLimit) { this.close(); return false; }
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
    try { if (!this.stream.write(Buffer.concat([prefix, body]))) { this.close(); return false; } return true; }
    catch { this.close(); return false; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve("unavailable"); }
    this.pending.clear();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.stream.destroy();
  }
}

/** The bootstrap owns this object and the private pipe. It carries no identity
 * parameter that a model request or inherited environment can substitute. */
export function hostedControllerAdapterFromFramedDispatcher(channel: HostedControllerFramedDispatcher): HostedControllerDynamicToolAdapter {
  return { dispatch: async (call, signal) => {
    const result = await channel.request(call, signal);
    return typeof result === "string" ? { status: result } : result;
  } };
}
