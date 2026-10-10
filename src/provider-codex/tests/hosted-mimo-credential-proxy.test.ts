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
