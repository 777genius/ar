import { expect, it, vi } from "vitest";
import { startMimoCredentialProxy, type MimoCredentialProxyLimits } from "../hosted-mimo-credential-proxy";

const key = "TEST-mimo-shared-key-do-not-expose";
const limits = (): MimoCredentialProxyLimits => ({ deadlineMs: Date.now() + 10000,
  maxRequests: 10, maxConcurrency: 1, maxBodyBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 100, requestTimeoutMs: 2000 });
async function fixture(transport: typeof fetch, overrides: Partial<MimoCredentialProxyLimits> = {}) {
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from(key), model: "mimo-v2.6-pro", limits: { ...limits(), ...overrides }, fetchUpstream: transport });
  const post = (body: unknown = { model: "mimo-v2.6-pro", input: "TEST", stream: false }, path = "/responses", headers: Record<string, string> = {}) => fetch(proxy.baseUrl + path, {
    method: "POST", headers: { authorization: `Bearer ${proxy.capability}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { proxy, post };
}

it("pins upstream/model, bounds output tokens, and forwards no client headers or real key to caller", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response('{"output":[]}', { headers: { "content-type": "application/json", "x-secret": key } }));
  const f = await fixture(transport);
  try {
    const response = await f.post(undefined, "/responses", { "x-injected": key });
    expect(response.status).toBe(200); expect(await response.text()).toBe('{"output":[]}');
    expect(response.headers.get("x-secret")).toBeNull();
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("https://token-plan-sgp.xiaomimimo.com/v1/responses");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
    expect(Object.keys(init!.headers!)).toEqual(["content-type", "authorization"]);
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "mimo-v2.6-pro", max_output_tokens: 100, store: false });
    expect(f.proxy.capability).not.toBe(key);
  } finally { await f.proxy.close(); }
});

it("rejects changed route, auth, model, token ceiling, remote state and encoded/oversized input before upstream", async () => {
  const transport = vi.fn<typeof fetch>(); const f = await fixture(transport);
  try {
    expect((await f.post(undefined, "/responses?url=https://evil.test")).status).toBe(404);
    expect((await f.post(undefined, "/responses", { authorization: "Bearer wrong" })).status).toBe(401);
    for (const extra of [{ model: "other" }, { max_output_tokens: 101 }, { max_output_tokens: "10" }, { previous_response_id: "other-start" }, { background: true }]) {
      expect((await f.post({ model: "mimo-v2.6-pro", ...extra })).status).toBe(400);
    }
    expect((await f.post(undefined, "/responses", { "content-encoding": "gzip" })).status).toBe(400);
    expect((await f.post({ model: "mimo-v2.6-pro", input: "x".repeat(5000) })).status).toBe(413);
    expect(transport).not.toHaveBeenCalled();
  } finally { await f.proxy.close(); }
});

it("sends the 128K budget and preserves incomplete SSE token usage without retrying or fabricating completion", async () => {
  const terminal = { type: "response.incomplete", response: { status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: { output_tokens: 131072, output_tokens_details: { reasoning_tokens: 130900 } } } };
  const transport = vi.fn<typeof fetch>(async () => new Response(
    `event: response.incomplete\ndata: ${JSON.stringify(terminal)}\n\n`,
    { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport, { maxOutputTokens: 131072 });
  try {
    const response = await f.post({ model: "mimo-v2.6-pro", stream: true });
    const text = await response.text();
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body)).max_output_tokens).toBe(131072);
    expect(JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6))).toEqual(terminal);
    expect(text).not.toContain("response.completed");
    expect(transport).toHaveBeenCalledOnce();
    expect((await f.post({ model: "mimo-v2.6-pro", max_output_tokens: 131073 })).status).toBe(400);
    expect(transport).toHaveBeenCalledOnce();
  } finally { await f.proxy.close(); }
});

it("streams SSE across chunks and removes upstream key/capability echoes spanning chunks", async () => {
  let capability = "";
  const transport = vi.fn<typeof fetch>(async () => {
    const body = `data: {"text":"${key}/${capability}"}\n\ndata: [DONE]\n\n`;
    const split = body.indexOf(key) + 7;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(body.slice(0, split))); controller.enqueue(Buffer.from(body.slice(split))); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const f = await fixture(transport); capability = f.proxy.capability;
  try {
    const response = await f.post({ model: "mimo-v2.6-pro", stream: true });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe('data: {"text":"***/***"}\n\ndata: [DONE]\n\n');
  } finally { await f.proxy.close(); }
});

it.each([302, 401, 500])("never retries or forwards upstream error/redirect credentials (%s)", async status => {
  const transport = vi.fn<typeof fetch>(async () => new Response(key, { status, headers: { location: "https://evil.test/" + key } }));
  const f = await fixture(transport);
  try {
    const response = await f.post(); expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":{"code":"proxy_upstream_failed"}}');
    expect(transport).toHaveBeenCalledOnce(); expect(response.headers.get("location")).toBeNull();
  } finally { await f.proxy.close(); }
});

it("enforces concurrency, revokes active upstream and refuses further requests", async () => {
  let signal: AbortSignal | undefined;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error(key)), { once: true }));
  });
  const f = await fixture(transport);
  try {
    const first = f.post(); await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    expect((await f.post()).status).toBe(429);
    f.proxy.revoke(); expect(signal!.aborted).toBe(true);
    const response = await first; expect(response.status).toBe(503); expect(await response.text()).not.toContain(key);
    expect((await f.post()).status).toBe(503); expect(transport).toHaveBeenCalledOnce();
  } finally { await f.proxy.close(); }
});

it("request allowance is consumed once and does not reset after completion", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  const f = await fixture(transport, { maxRequests: 1 });
  try { await (await f.post()).text(); expect((await f.post()).status).toBe(429); expect(transport).toHaveBeenCalledOnce(); }
  finally { await f.proxy.close(); }
});

it("deadline aborts active requests without hidden retry", async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error(key)), { once: true });
  }));
  const f = await fixture(transport, { requestTimeoutMs: 40 });
  try { const response = await f.post(); expect(response.status).toBe(503); expect(await response.text()).not.toContain(key); expect(transport).toHaveBeenCalledOnce(); }
  finally { await f.proxy.close(); }
});

it("caps successful upstream response bytes and cancels the body", async () => {
  const cancelled = vi.fn();
  const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(2048, 120)); }, cancel: cancelled,
  }), { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport, { maxResponseBytes: 1024 });
  try {
    await expect(f.post().then(response => response.text())).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
  } finally { await f.proxy.close(); }
});

it("a disconnected streaming client aborts the upstream request", async () => {
  let signal: AbortSignal | undefined;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from("data: " + JSON.stringify({ text: "x".repeat(256) }) + "\n\n"));
      signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const f = await fixture(transport);
  try {
    const response = await f.post(); await response.body!.cancel();
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    expect(transport).toHaveBeenCalledOnce();
  } finally { await f.proxy.close(); }
});

it.each(["application/json", "text/event-stream"])("redacts JSON-escaped key/capability in nested values and keys (%s)", async contentType => {
  let capability = "";
  const escape = (text: string) => [...text].map(c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const transport = vi.fn<typeof fetch>(async () => {
    const json = `{"${escape(key)}":{"nested":["${escape(key)}","${escape(capability)}"]}}`;
    const data = contentType === "text/event-stream" ? `event: response.output_text.delta\r\ndata: ${json}\r\n\r\n` : json;
    return new Response(new ReadableStream({ start(controller) {
      const bytes = Buffer.from(data); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close();
    } }), { headers: { "content-type": contentType } });
  });
  const f = await fixture(transport); capability = f.proxy.capability;
  try {
    const text = await (await f.post()).text();
    const json = contentType === "application/json" ? text : text.split("\n").find(line => line.startsWith("data: "))!.slice(6);
    expect(JSON.parse(json)).toEqual({ "***": { nested: ["***", "***"] } });
    if (contentType === "text/event-stream") expect(text).toContain("event: response.output_text.delta\n");
  } finally { await f.proxy.close(); }
});

it("preserves multiline SSE JSON and own __proto__ data without prototype mutation", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(
    'event: response.completed\ndata: {"__proto__":\ndata: {"safe":true},"number":4,"nil":null}\n\n',
    { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport);
  try {
    const text = await (await f.post()).text();
    expect(JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6)))
      .toEqual(JSON.parse('{"__proto__":{"safe":true},"number":4,"nil":null}'));
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  } finally { await f.proxy.close(); }
});

it.each([Buffer.from([0xff]), Buffer.from('data: {"partial":"TEST')])("rejects malformed UTF8 or incomplete SSE without raw fallback", async bytes => {
  const transport = vi.fn<typeof fetch>(async () => new Response(bytes, { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport);
  try { await expect(f.post().then(response => response.text())).rejects.toThrow(); expect(transport).toHaveBeenCalledOnce(); }
  finally { await f.proxy.close(); }
});

it("redacts a key split across normal Responses delta events while preserving sequence order and text", async () => {
  const chunks = ["prefix ", key.slice(0, 10), key.slice(10), " suffix ", "z".repeat(100)];
  const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) {
    chunks.forEach((delta, sequence_number) => controller.enqueue(Buffer.from("event: response.output_text.delta\ndata: " + JSON.stringify({
      type: "response.output_text.delta", item_id: "item-1", output_index: 0, content_index: 0, sequence_number, delta,
    }) + "\n\n")));
    controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed"}\n\n')); controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport);
  try {
    const events = (await (await f.post()).text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(events.filter(event => typeof event.delta === "string").map(event => event.delta).join("")).toBe("prefix *** suffix " + "z".repeat(100));
    expect(events.slice(0, 5).map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4]);
    expect(events.at(-1)?.type).toBe("response.completed");
  } finally { await f.proxy.close(); }
});

it("uses heartbeat text outside the credential alphabet even for the valid key keepalive", async () => {
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from("keepalive"), model: "mimo-v2.6-pro", limits: limits(),
    fetchUpstream: async () => new Response(': keepalive\n\n', { headers: { "content-type": "text/event-stream" } }) });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: {
      authorization: `Bearer ${proxy.capability}`, "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-v2.6-pro" }) });
    const text = await response.text();
    expect(text).toBe(": ***\n\n");
    expect(text).not.toContain("keepalive");
  } finally { await proxy.close(); }
});

it.each(["output_text", "function_call_arguments"])("releases a completed %s chain before terminal and forwards only a fixed heartbeat", async kind => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { upstream = controller; } }),
    { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport);
  let output = ""; let reading: Promise<void> | undefined;
  const emit = (data: Record<string, unknown>) => upstream.enqueue(Buffer.from("data: " + JSON.stringify(data) + "\n\n"));
  const identity = { item_id: "item-1", output_index: 0, ...(kind === "output_text" ? { content_index: 0 } : {}) };
  try {
    const posted = f.post();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    emit({ type: "response.created" });
    const response = await posted;
    reading = (async () => {
      const reader = response.body!.getReader();
      try { for (;;) { const part = await reader.read(); if (part.done) break; output += Buffer.from(part.value).toString("utf8"); } }
      finally { reader.releaseLock(); }
    })();
    emit({ type: `response.${kind}.delta`, ...identity, delta: "prefix " + key.slice(0, 10) });
    emit({ type: `response.${kind}.done`, ...identity, item_id: "other-item" });
    upstream.enqueue(Buffer.from(`: ${key}\n\n`));
    await vi.waitFor(() => expect(output).toContain(": ***\n\n"));
    expect(output).not.toContain("prefix ");
    emit({ type: `response.${kind}.delta`, ...identity, delta: key.slice(10) + " suffix" });
    emit({ type: `response.${kind}.done`, ...identity });
    emit({ type: "response.output_item.added", item: { id: "tool-1", type: "function_call" } });
    await vi.waitFor(() => expect(output).toContain('"id":"tool-1"'));
    expect(output).not.toContain("response.completed");
    expect(output).not.toContain(key);
    const events = output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(events.filter(event => typeof event.delta === "string").map(event => event.delta).join("")).toBe("prefix *** suffix");
    expect(events.map(event => event.type)).toEqual(["response.created", `response.${kind}.delta`, `response.${kind}.done`,
      `response.${kind}.delta`, `response.${kind}.done`, "response.output_item.added"]);
    emit({ type: "response.completed" }); upstream.close(); await reading;
  } finally { await f.proxy.close(); await reading?.catch(() => {}); }
});

it("releases done chains before response completion while redacting split secrets in the following chain", async () => {
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { upstreamController = controller; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const received = (async () => {
      const response = await f.post({ model: "mimo-v2.6-pro", stream: true });
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes('"type":"response.function_call_arguments.done"')) {
        const part = await reader.read();
        if (part.done) throw new Error("stream ended before chain completion");
        text += new TextDecoder().decode(part.value);
      }
      return text;
    })();
    // Wait for the upstream call without requiring any response bytes.
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    const emit = (type: string, item: string, fields: Record<string, unknown> = {}) => upstreamController.enqueue(Buffer.from(
      `event: ${type}\ndata: ${JSON.stringify({ type, item_id: item, output_index: 0, ...fields })}\n\n`));
    emit("response.reasoning_summary_text.delta", "reasoning", { summary_index: 0, delta: "short" });
    emit("response.reasoning_summary_text.done", "reasoning", { summary_index: 0, text: "short" });
    for (const [index, secret] of [key, f.proxy.capability].entries()) {
      emit("response.function_call_arguments.delta", "tool", { delta: secret.slice(0, 10) });
      // A different completed chain must not release the tool's secret prefix.
      emit("response.output_text.delta", `other-${index}`, { content_index: 0, delta: "ok" });
      emit("response.output_text.done", `other-${index}`, { content_index: 0, text: "ok" });
      emit("response.function_call_arguments.delta", "tool", { delta: secret.slice(10) });
    }
    emit("response.function_call_arguments.done", "tool", { arguments: key + f.proxy.capability });
    const text = await Promise.race([received, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("completed chains remained buffered")), 500);
    })]);
    expect(text).toContain('"delta":"short"');
    expect(text).not.toContain(key); expect(text).not.toContain(f.proxy.capability);
    expect(text).not.toContain("response.completed");
    const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("")).toBe("******");
    expect(transport).toHaveBeenCalledOnce();
  } finally { if (timer) clearTimeout(timer); await f.proxy.close(); }
});

it("fails closed on a delta after its matching done event", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(
    'data: {"type":"response.output_text.done","item_id":"item-1"}\n\n' +
    'data: {"type":"response.output_text.delta","item_id":"item-1","delta":"late"}\n\n',
    { headers: { "content-type": "text/event-stream" } }));
  const f = await fixture(transport);
  try { await expect(f.post().then(response => response.text())).rejects.toThrow(); }
  finally { await f.proxy.close(); }
});

it("uses a replacement outside the credential alphabet, so redaction cannot match itself", async () => {
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from("redacted"), model: "mimo-v2.6-pro", limits: limits(),
    fetchUpstream: async () => new Response('data: {"type":"response.output_text.delta","delta":"redacted"}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } }) });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: {
      authorization: `Bearer ${proxy.capability}`, "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-v2.6-pro" }) });
    expect(await response.text()).toContain('"delta":"***"');
  } finally { await proxy.close(); }
});

it("revokes start authority before upstream when the retained owner becomes stale", async () => {
  const transport = vi.fn<typeof fetch>();
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from(key), model: "mimo-v2.6-pro", limits: limits(), fetchUpstream: transport,
    assertCurrent: () => { throw new Error("TEST-owner-stale-secret"); } });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${proxy.capability}`, "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-v2.6-pro" }) });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("TEST-owner-stale-secret"); expect(transport).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});
it("revokes if authority changes while reading the admitted request body", async () => {
  const transport = vi.fn<typeof fetch>(); let observations = 0;
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from(key), model: "mimo-v2.6-pro", limits: limits(), fetchUpstream: transport,
    assertCurrent: () => { if (++observations === 2) throw new Error("TEST-lost-owner"); } });
  const post = () => fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${proxy.capability}`, "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-v2.6-pro" }) });
  try { expect((await post()).status).toBe(503); expect((await post()).status).toBe(503); expect(observations).toBe(2); expect(transport).not.toHaveBeenCalled(); }
  finally { await proxy.close(); }
});
it("rejects unauthenticated callers without consulting retained custody", async () => {
  const current = vi.fn(); const transport = vi.fn<typeof fetch>();
  const proxy = await startMimoCredentialProxy({ apiKey: Buffer.from(key), model: "mimo-v2.6-pro", limits: limits(), fetchUpstream: transport, assertCurrent: current });
  try {
    expect((await fetch(proxy.baseUrl + "/responses", { method: "POST" })).status).toBe(401);
    expect(current).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});
