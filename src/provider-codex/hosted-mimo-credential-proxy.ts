import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent } from "undici";
import { codexMimoConfirmedBaseUrl } from "./codex-model-backend";
import { MimoProxyFailureReason as FailureReason, MimoProxyFailurePhase as FailurePhase,
  mimoProxyTransportCode, mimoProxyValidationCode, type MimoProxyFailure } from "./mimo-proxy-failure";

/** Trusted start owner supplies these limits; HTTP clients cannot change them. */
export type MimoCredentialProxyLimits = Readonly<{
  deadlineMs: number;
  maxRequests: number;
  maxConcurrency: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
}>;
export type MimoCredentialProxy = Readonly<{
  baseUrl: string;
  /** Disposable start-local authority, deliberately readable by its shell. */
  capability: string;
  /** Start-lifetime facts, not attribution to a particular turn or failure. */
  upstreamFailureObservation(): Readonly<{ count: number; lastStatus: number }> | undefined;
  revoke(): void;
  close(): Promise<void>;
  /** Retained even when a streaming response can no longer carry an error. */
  latestFailure(): MimoProxyFailure | undefined;
}>;

const upstream = codexMimoConfirmedBaseUrl + "/responses";
function invalid(): never { throw new Error("mimo_credential_proxy_configuration_invalid"); }
function reply(response: ServerResponse, status: number, code: string, upstreamStatus?: number, details?: MimoProxyFailure): void {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { code,
    ...(typeof upstreamStatus === "number" && bounded(upstreamStatus, 100, 599) ? { upstream_status: upstreamStatus } : {}),
    ...(details ? { details } : {}) } }));
}
function bounded(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Adapter only. The owner must bind its returned capability to one admitted
 * start and keep this process outside every model-controlled PID/root namespace.
 * The shared key is never returned, persisted or placed in a child environment. */
export async function startMimoCredentialProxy(input: {
  readonly apiKey: Uint8Array;
  readonly model: string;
  readonly limits: MimoCredentialProxyLimits;
  /** Trusted transport seam; production defaults to one non-retrying fetch. */
  readonly fetchUpstream?: typeof fetch;
  /** Retained owner observation, supplied by the trusted producer, not HTTP. */
  readonly assertCurrent?: () => void;
}): Promise<MimoCredentialProxy> {
  const limits = Object.freeze({ ...input.limits });
  const remaining = limits.deadlineMs - Date.now();
  if (!bounded(remaining, 1, 86400000) || !bounded(limits.maxRequests, 1, 4096) ||
      !bounded(limits.maxConcurrency, 1, 8) || !bounded(limits.maxBodyBytes, 1024, 16 * 1024 * 1024) ||
      !bounded(limits.maxResponseBytes, 1024, 64 * 1024 * 1024) || !bounded(limits.maxOutputTokens, 1, 131072) ||
      !bounded(limits.requestTimeoutMs, 1, 3600000) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.model) ||
      input.apiKey.byteLength < 8 || input.apiKey.byteLength > 4096) invalid();
  const key = Buffer.from(input.apiKey);
  // Token Plan keys use an ASCII token alphabet; reject decoding ambiguity.
  if (!/^[A-Za-z0-9._-]+$/.test(key.toString("utf8"))) { key.fill(0); invalid(); }
  const model = input.model;
  const capability = randomBytes(32).toString("base64url");
  const auth = Buffer.from(`Bearer ${capability}`);
  const active = new Set<AbortController>();
  // fetch's implicit five-minute body/header timers are independent of the
  // AbortController. Keep this start's transport within its existing budget.
  const dispatcher = input.fetchUpstream === undefined ? new Agent({
    bodyTimeout: limits.requestTimeoutMs, headersTimeout: limits.requestTimeoutMs,
  }) : undefined;
  let dispatcherClosing: Promise<void> | undefined;
  const destroyDispatcher = () => {
    dispatcherClosing ??= dispatcher?.destroy() ?? Promise.resolve();
    // revoke is synchronous; close joins the same retained cleanup below.
    void dispatcherClosing.catch(() => undefined);
    return dispatcherClosing;
  };
  let revoked = false, requests = 0, upstreamFailureCount = 0, lastUpstreamStatus: number | undefined;
  let latestFailure: MimoProxyFailure | undefined;
  const revoke = () => {
    revoked = true;
    for (const controller of active) controller.abort();
    key.fill(0);
    void destroyDispatcher();
  };
  const expiry = setTimeout(revoke, remaining);
  expiry.unref();
  const transport: typeof fetch = input.fetchUpstream ?? ((url, init) =>
    fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Agent }));
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    if (revoked || Date.now() >= limits.deadlineMs) { revoke(); reply(response, 503, "proxy_revoked"); return; }
    const header = request.headers.authorization;
    const supplied = Buffer.from(typeof header === "string" ? header : "");
    if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) { reply(response, 401, "proxy_unauthorized"); return; }
    if (request.method !== "POST" || request.url !== "/v1/responses") { reply(response, 404, "proxy_route_denied"); return; }
    if (request.headers["content-encoding"] !== undefined || request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      reply(response, 400, "proxy_request_invalid"); return;
    }
    try { input.assertCurrent?.(); } catch { revoke(); reply(response, 503, "proxy_revoked"); return; }
    if (requests >= limits.maxRequests || active.size >= limits.maxConcurrency) { reply(response, 429, "proxy_limit"); return; }
    requests += 1;
    const requestNumber = requests;
    const controller = new AbortController(); active.add(controller);
    const started = performance.now();
    let phase = FailurePhase.Input, timedOut = false, clientDisconnected = false, upstreamStreamFailed = false;
    let upstreamStatus: number | undefined;
    const failure = (reason: FailureReason, error?: unknown): MimoProxyFailure => {
      const elapsed = performance.now() - started;
      latestFailure = Object.freeze({ reason, phase, request_number: requestNumber,
        elapsed_ms: Number.isFinite(elapsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(elapsed))) : 0,
        ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
        ...(error !== undefined ? { transport_code: mimoProxyTransportCode(error) } : {}),
        ...(error !== undefined && phase === FailurePhase.Stream ? { validation_code: mimoProxyValidationCode(error) } : {}) });
      return latestFailure;
    };
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(limits.requestTimeoutMs, limits.deadlineMs - Date.now()));
    const disconnected = () => { if (!response.writableFinished) { clientDisconnected = true; controller.abort(); } };
    response.once("close", disconnected);
    const abortInput = () => { if (!request.complete) request.destroy(); };
    controller.signal.addEventListener("abort", abortInput, { once: true });
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        if (controller.signal.aborted) throw new Error("aborted");
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limits.maxBodyBytes) { reply(response, 413, "proxy_body_limit"); return; }
        chunks.push(bytes);
      }
      if (controller.signal.aborted || revoked) throw new Error("aborted");
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reply(response, 400, "proxy_request_invalid"); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { reply(response, 400, "proxy_request_invalid"); return; }
      const body = value as Record<string, unknown>;
      if (body.model !== model || (body.stream !== undefined && typeof body.stream !== "boolean") ||
          (body.max_output_tokens !== undefined && !bounded(Number(body.max_output_tokens), 1, limits.maxOutputTokens)) ||
          (body.max_output_tokens !== undefined && typeof body.max_output_tokens !== "number") ||
          (body.background !== undefined && body.background !== false) ||
          (body.previous_response_id !== undefined && body.previous_response_id !== null) ||
          (body.store !== undefined && body.store !== false)) {
        reply(response, 400, "proxy_request_invalid"); return;
      }
      body.max_output_tokens ??= limits.maxOutputTokens;
      body.store = false;
      try { input.assertCurrent?.(); } catch { revoke(); throw new Error("authority_revoked"); }
      if (Date.now() >= limits.deadlineMs) { revoke(); throw new Error("aborted"); }
      phase = FailurePhase.Transport;
      const upstreamResponse = await transport(upstream, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key.toString("utf8")}` },
        body: JSON.stringify(body),
      });
      phase = FailurePhase.Response;
      if (bounded(upstreamResponse.status, 100, 599)) upstreamStatus = upstreamResponse.status;
      if (!upstreamResponse.ok) {
        try { if (bounded(upstreamResponse.status, 100, 599)) {
          upstreamFailureCount = Math.min(upstreamFailureCount + 1, limits.maxRequests);
          lastUpstreamStatus = upstreamResponse.status;
        } } catch { /* Observation cannot replace the original HTTP response. */ }
        const details = failure(upstreamStatus === undefined ? FailureReason.Response : FailureReason.Http);
        try { await upstreamResponse.body?.cancel(); } catch { /* Keep the received HTTP failure. */ }
        reply(response, 502, "proxy_upstream_failed", upstreamStatus, details); return;
      }
      if (!upstreamResponse.body) {
        reply(response, 502, "proxy_upstream_failed", undefined, failure(FailureReason.EmptyBody)); return;
      }
      const contentType = upstreamResponse.headers.get("content-type")?.split(";")[0]?.trim();
      if (contentType !== "application/json" && contentType !== "text/event-stream") {
        const details = failure(FailureReason.ContentType);
        try { await upstreamResponse.body.cancel(); } catch { /* Preserve the response classification. */ }
        reply(response, 502, "proxy_upstream_failed", undefined, details); return;
      }
      if (revoked || controller.signal.aborted) { await upstreamResponse.body.cancel(); throw new Error("aborted"); }
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      phase = FailurePhase.Stream;
      // Keep only enough trailing bytes to detect a secret split across chunks.
      // Reconstruct matches, never forward any upstream headers or error bodies.
      const secrets = [Buffer.from(key), Buffer.from(capability)];
      const stream = Readable.from(redactedBody(upstreamResponse.body, secrets, limits.maxResponseBytes, contentType), { objectMode: false });
      // pipeline destroys the HTTP response on a source failure. That close is
      // a consequence, not evidence that the client caused the failure.
      stream.once("error", () => { if (!clientDisconnected && !controller.signal.aborted) upstreamStreamFailed = true; });
      try { await pipeline(stream, response, { signal: controller.signal }); }
      finally { for (const secret of secrets) secret.fill(0); }
    } catch (error) {
      const reason = revoked ? FailureReason.Revoked : timedOut ? FailureReason.Timeout
        : upstreamStreamFailed ? FailureReason.Stream : clientDisconnected ? FailureReason.Disconnected : phase === FailurePhase.Stream ? FailureReason.Stream
          : phase === FailurePhase.Input ? FailureReason.Input : phase === FailurePhase.Response ? FailureReason.Response : FailureReason.Transport;
      const details = failure(reason, error);
      reply(response, controller.signal.aborted || revoked ? 503 : 502,
        controller.signal.aborted || revoked ? "proxy_aborted" : "proxy_upstream_failed", undefined, details);
    } finally {
      clearTimeout(timeout); active.delete(controller);
      response.off("close", disconnected);
      controller.signal.removeEventListener("abort", abortInput);
    }
  };
  const server = createServer((request, response) => { void serve(request, response); });
  server.requestTimeout = Math.min(limits.requestTimeoutMs, 30000);
  server.headersTimeout = Math.min(limits.requestTimeoutMs, 10000);
  server.maxHeadersCount = 32;
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch { clearTimeout(expiry); revoke(); await destroyDispatcher(); throw new Error("mimo_credential_proxy_listen_failed"); }
  const address = server.address();
  if (!address || typeof address === "string") { clearTimeout(expiry); revoke(); server.close(); await destroyDispatcher(); invalid(); }
  let closing: Promise<void> | undefined;
  return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}/v1`, capability, revoke,
    latestFailure: () => latestFailure,
    upstreamFailureObservation: () => lastUpstreamStatus === undefined ? undefined :
      Object.freeze({ count: upstreamFailureCount, lastStatus: lastUpstreamStatus }),
    close() {
      if (closing) return closing;
      clearTimeout(expiry); revoke();
      closing = Promise.all([destroyDispatcher(), new Promise<void>(resolve => {
        server.close(() => resolve()); server.closeAllConnections();
      })]).then(() => undefined);
      return closing;
    },
  });
}

/** Message text parts and streamed fragments have the same plaintext projection.
 * Keep their boundaries while replacing a match that spans those boundaries. */
function redactTextFragments(texts: readonly string[], secrets: readonly string[]): string[] {
  const parts = [...texts];
  for (const secret of secrets) {
    for (;;) {
      const start = parts.join("").indexOf(secret);
      if (start < 0) break;
      const end = start + secret.length;
      let offset = 0, inserted = false;
      for (let index = 0; index < parts.length; index += 1) {
        const text = parts[index]!, next = offset + text.length;
        if (offset < end && next > start) {
          const begin = Math.max(0, start - offset), finish = Math.min(text.length, end - offset);
          parts[index] = text.slice(0, begin) + (inserted ? "" : "***") + text.slice(finish);
          inserted = true;
        }
        offset = next;
      }
    }
  }
  return parts;
}

function redactJson(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 64) throw new Error("response_depth");
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("***"), text);
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(item => redactJson(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redact(key), redactJson(item, secrets, depth + 1)]));
    if (result.type === "message" && Array.isArray(result.content)) {
      const parts = result.content.filter((part): part is Record<string, unknown> =>
        part !== null && typeof part === "object" && part.type === "output_text" && typeof part.text === "string");
      const text = redactTextFragments(parts.map(part => String(part.text)), secrets);
      parts.forEach((part, index) => { part.text = text[index]!; });
    }
    return result;
  }
  return value;
}

/** Decode the protocol before redaction: JSON unicode escapes must not hide a
 * credential. This guarantees literal/JSON-escaped secret removal, not detection
 * of arbitrary encodings inside user content (for example base64 ciphertext). */
async function* redactedBody(body: ReadableStream<Uint8Array>, secretBytes: readonly Buffer[], maxBytes: number,
  contentType: string): AsyncGenerator<Buffer> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const secrets = secretBytes.map(secret => secret.toString("utf8"));
  const frameLimit = Math.min(maxBytes, 1024 * 1024);
  let pending = "", total = 0;
  const serialize = (text: string) => JSON.stringify(redactJson(JSON.parse(text), secrets));
  type Frame = { event?: string; data: unknown; chain?: string; textField?: "delta" | "text"; messageText?: boolean };
  const queue: Frame[] = [];
  const sealedChains = new Set<string>();
  let queueBytes = 0;
  const tailLength = Math.max(...secrets.map(secret => secret.length)) - 1;
  const encodeFrame = (item: Frame) => Buffer.from(`${item.event ? `event: ${item.event}\n` : ""}data: ${item.data === "[DONE]" ? "[DONE]" : JSON.stringify(item.data)}\n\n`);
  const delta = (item: Frame): string => item.chain ? String((item.data as Record<string, unknown>)[item.textField ?? "delta"]) : "";
  const release = (flush = false): Buffer[] => {
    const output: Buffer[] = [];
    while (queue.length) {
      const first = queue[0]!;
      if (!flush && first.chain && !sealedChains.has(first.chain)) {
        // Another content part, including an earlier index, can still arrive.
        // Retain the bounded message projection until its exact item closes.
        if (first.messageText) break;
        const following = queue.slice(1).filter(item => item.chain === first.chain).reduce((size, item) => size + delta(item).length, 0);
        if (following < tailLength) break;
      }
      queue.shift(); const bytes = encodeFrame(first); queueBytes -= bytes.length; output.push(bytes);
    }
    return output;
  };
  const enqueue = (item: Frame): Buffer[] => {
    queue.push(item); queueBytes += encodeFrame(item).length;
    if (queueBytes > frameLimit) throw new Error("response_lookahead_limit");
    if (item.chain) {
      const parts = queue.filter(candidate => candidate.chain === item.chain);
      const redactParts = (projection: Frame[]): boolean => {
        const before = projection.map(delta), after = redactTextFragments(before, secrets);
        projection.forEach((part, index) => { (part.data as Record<string, unknown>)[part.textField ?? "delta"] = after[index]!; });
        return after.some((text, index) => text !== before[index]);
      };
      if (item.messageText) {
        // Consumers can append arriving deltas or assemble content-index order.
        // Check both without changing FIFO. Each replacement shortens text, so
        // convergence is bounded by the existing credential and queue limits.
        const ordered = [...parts].sort((left, right) => Number((left.data as Record<string, unknown>).content_index) -
          Number((right.data as Record<string, unknown>).content_index));
        for (;;) {
          const arrivalChanged = redactParts(parts), orderedChanged = redactParts(ordered);
          if (!arrivalChanged && !orderedChanged) break;
        }
      } else redactParts(parts);
      queueBytes = queue.reduce((size, candidate) => size + encodeFrame(candidate).length, 0);
    }
    const terminal = item.data === "[DONE]" || (item.data && typeof item.data === "object" &&
      ["response.completed", "response.failed", "response.incomplete"].includes(String((item.data as Record<string, unknown>).type)));
    return release(Boolean(terminal));
  };
  const frame = (text: string): Buffer[] => {
    if (Buffer.byteLength(text) > frameLimit) throw new Error("response_frame_limit");
    const data: string[] = []; let event: string | undefined; let comment = false;
    for (const line of text.split(/\r\n|\n|\r/)) {
      if (line.startsWith(":")) { comment = true; continue; }
      if (!line) continue;
      const separator = line.indexOf(":");
      const name = separator < 0 ? line : line.slice(0, separator);
      const raw = separator < 0 ? "" : line.slice(separator + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (name === "data") data.push(value);
      else if (name === "event") {
        if (!/^response\.[a-zA-Z0-9_.-]{1,120}$/.test(value) && value !== "error") throw new Error("response_event_invalid");
        event = value;
      } else if (name !== "id" && name !== "retry") throw new Error("response_event_invalid");
      // Responses does not need event IDs/retry metadata; never echo arbitrary fields.
    }
    // Comments have no Responses semantics and may contain secrets. Forward only
    // a fixed heartbeat, without releasing any pending credential lookahead.
    if (!data.length) return comment ? [Buffer.from(": ***\n\n")] : [];
    const textData = data.join("\n");
    const safeData: unknown = textData === "[DONE]" ? textData : redactJson(JSON.parse(textData), secrets);
    const safeEvent = event ? String(redactJson(event, secrets)) : undefined;
    const record = safeData && typeof safeData === "object" && !Array.isArray(safeData) ? safeData as Record<string, unknown> : undefined;
    const chainKey = (type: string) => JSON.stringify([type, record?.item_id ?? null,
      record?.output_index ?? null, record?.content_index ?? null, record?.summary_index ?? null]);
    const messageChain = (type: string, itemId: string, outputIndex: number) => JSON.stringify([type, itemId, outputIndex]);
    const outputTextType = [record?.type, safeEvent].find(type =>
      type === "response.output_text.delta" || type === "response.output_text.done");
    const outputTextPart = outputTextType !== undefined;
    const textField = outputTextType === "response.output_text.done" ? "text" : "delta";
    const validIndex = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    // Native Responses text events carry exact identities. Missing or mixed
    // identities cannot safely bind fragments to an item; fail closed.
    if (outputTextPart && (!record || record.type !== outputTextType ||
        typeof record.item_id !== "string" || !record.item_id.length ||
        !validIndex(record.output_index) || !validIndex(record.content_index) || typeof record[textField] !== "string")) {
      throw new Error("response_text_identity_invalid");
    }
    const chain = outputTextPart
      ? messageChain(String(record!.type), record!.item_id as string, record!.output_index as number)
      : record && typeof record.type === "string" && record.type.endsWith(".delta") && typeof record.delta === "string"
        ? chainKey(record.type) : undefined;
    if (chain && sealedChains.has(chain)) throw new Error("response_delta_after_done");
    // A text-part done cannot close the message: later content parts may
    // continue its plaintext. Only its exact item completion seals both text
    // projections. Other done events retain their per-chain fast release.
    if (record?.type === "response.output_item.done") {
      const item = record.item && typeof record.item === "object" ? record.item as Record<string, unknown> : undefined;
      if (item?.type === "message" && typeof item.id === "string" && item.id.length > 0 && validIndex(record.output_index)) {
        for (const type of ["response.output_text.delta", "response.output_text.done"]) {
          sealedChains.add(messageChain(type, item.id, record.output_index as number));
        }
      }
    } else if (record && typeof record.type === "string" && record.type.endsWith(".done") && record.type !== "response.output_text.done") {
      sealedChains.add(chainKey(record.type.slice(0, -5) + ".delta"));
    }
    return enqueue({ ...(safeEvent ? { event: safeEvent } : {}), data: safeData,
      ...(chain ? { chain, textField, ...(outputTextPart ? { messageText: true } : {}) } : {}) });
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("response_limit");
      pending += decoder.decode(next.value, { stream: true });
      if (contentType === "text/event-stream") {
        for (;;) {
          const delimiter = /\r\n\r\n|\n\n|\r\r/.exec(pending);
          if (!delimiter) break;
          const output = frame(pending.slice(0, delimiter.index));
          pending = pending.slice(delimiter.index + delimiter[0].length);
          for (const bytes of output) yield bytes;
        }
        if (Buffer.byteLength(pending) > frameLimit) throw new Error("response_frame_limit");
      }
    }
    pending += decoder.decode();
    if (contentType === "application/json") yield Buffer.from(serialize(pending));
    else {
      if (pending) for (const bytes of frame(pending)) yield bytes;
      for (const bytes of release(true)) yield bytes;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
