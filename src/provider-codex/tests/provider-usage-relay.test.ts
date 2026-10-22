import { expect, it, vi } from "vitest";
import { startProviderUsageRelay } from "../../provider-usage/provider-usage-relay";
import type { ProviderCallObservation } from "../../provider-usage/provider-call-observation";

it("records distinct failed and successful network attempts without response/credential fields", async () => {
  const facts: ProviderCallObservation[] = [];
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("secret error body", { status: 429 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed", output: [{ text: "private response" }], usage: {
      input_tokens: 90, output_tokens: 12, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 4 },
    } }), { headers: { "content-type": "application/json" } }));
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "test-model", observe: f => { facts.push(f); }, fetchUpstream: transport });
  try {
    for (const status of [429, 200]) {
      const response = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer private-key" }, body: JSON.stringify({ model: "test-model", input: "private prompt" }) });
      expect(response.status).toBe(status); await response.text();
    }
  } finally { await relay.close(); }
  expect(facts.map(f => f.state)).toEqual(["dispatched", "failed", "dispatched", "completed"]);
  expect(facts[0]?.callId).toBe(facts[1]?.callId); expect(facts[0]?.callId).not.toBe(facts[2]?.callId);
  expect(facts[3]?.tokens).toEqual({ inputTotal: 90, outputTotal: 12, cacheRead: 30, cacheWrite: null, reasoning: 4, total: 102 });
  expect(JSON.stringify(facts)).not.toMatch(/private|secret error/);
  expect(transport.mock.calls[0]?.[0]).toBe("https://provider.test/v1/responses");
});

it("retains Anthropic inclusive tokens across split SSE frames and ignores observer failure", async () => {
  const facts: ProviderCallObservation[] = [];
  const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":0}}}\n\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\ndata: {"type":"message_stop"}\n\n';
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "claude-test", observe: f => { facts.push(f); throw new Error("delivery unavailable"); },
    fetchUpstream: async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(sse.slice(0, 43))); c.enqueue(Buffer.from(sse.slice(43))); c.close(); } }), { headers: { "content-type": "text/event-stream" } }) });
  try {
    const response = await fetch(relay.baseUrl + "/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", messages: [] }) });
    expect(await response.text()).toBe(sse);
  } finally { await relay.close(); }
  expect(facts[1]).toMatchObject({ state: "completed", completeness: "complete", tokens: { inputTotal: 35, outputTotal: 7, total: 42, cacheRead: 20 } });
});

it("never dispatches malformed model or unauthorized path requests", async () => {
  const transport = vi.fn<typeof fetch>();
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "allowed", observe: () => {}, fetchUpstream: transport });
  try {
    expect((await fetch(relay.baseUrl + "/responses", { method: "POST", body: '{"model":42}' })).status).toBe(400);
    expect((await fetch(relay.baseUrl + "/../../admin", { method: "POST" })).status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  } finally { await relay.close(); }
});

it("does not invent an absent Anthropic cache bucket or inclusive input total", async () => {
  const facts: ProviderCallObservation[] = [];
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "claude-test", observe: fact => { facts.push(fact); },
    fetchUpstream: async () => new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } }) });
  try {
    const response = await fetch(relay.baseUrl + "/messages", { method: "POST", body: '{"model":"claude-test"}' });
    await response.text();
  } finally { await relay.close(); }
  expect(facts[1]).toMatchObject({ state: "completed", completeness: "partial", tokens: { inputTotal: null, cacheRead: 20, cacheWrite: null, outputTotal: 7, total: null } });
});

 it("projects standard Chat Completions usage through the real HTTP relay", async () => {
  const facts: ProviderCallObservation[] = [];
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "chat-test", observe: fact => { facts.push(fact); }, fetchUpstream: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 3 } } }), { headers: { "content-type": "application/json" } }) });
  try { const response = await fetch(relay.baseUrl + "/chat/completions", { method: "POST", body: '{"model":"chat-test"}' }); expect(response.status).toBe(200); await response.text(); } finally { await relay.close(); }
  expect(facts[1]).toMatchObject({ state: "completed", tokens: { inputTotal: 40, outputTotal: 8, cacheRead: 12, cacheWrite: null, reasoning: 3, total: 48 } });
});
it("bounds a never-settling observer before upstream dispatch and cleanup", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "test", observe: () => new Promise<void>(() => {}), fetchUpstream: transport });
  const started = performance.now();
  try { const response = await fetch(relay.baseUrl + "/responses", { method: "POST", body: '{"model":"test"}' }); await response.text(); expect(transport).toHaveBeenCalledOnce(); } finally { await relay.close(); }
  expect(performance.now() - started).toBeLessThan(4000);
});

it("passes resolved aliases and auxiliary token counting without changing bytes or inventing models", async () => {
  const facts: ProviderCallObservation[] = [];
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"usage":{"input_tokens":2,"output_tokens":1}}', { headers: { "content-type": "application/json" } }));
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test", model: "sonnet", observe: fact => { facts.push(fact); }, fetchUpstream: transport });
  const body = '{"model":"claude-sonnet-4-6","messages":[]}';
  try {
    for (const suffix of ["/v1/messages/count_tokens", "/v1/messages"]) {
      const response = await fetch(relay.baseUrl + suffix, { method: "POST", body });
      expect(response.status).toBe(200); await response.text();
    }
  } finally { await relay.close(); }
  expect(transport.mock.calls.map(call => call[1]?.body)).toEqual([body, body]);
  expect(facts).toHaveLength(2);
  expect(facts[1]).toMatchObject({ requestedModel: "sonnet", actualModel: null });
});

it("forwards only the supported beta query upstream and still rejects unknown queries", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "claude-test", observe: () => {}, fetchUpstream: transport });
  try {
    const beta = await fetch(relay.baseUrl + "/messages?beta=true", { method: "POST", body: '{"model":"claude-test","messages":[]}' });
    expect(beta.status).toBe(200); await beta.text();
    for (const query of ["beta=false", "x=1", "beta=true&x=1"]) {
      const rejected = await fetch(relay.baseUrl + "/messages?" + query, { method: "POST", body: '{"model":"claude-test"}' });
      expect(rejected.status).toBe(404);
    }
  } finally { await relay.close(); }
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[0]).toBe("https://provider.test/v1/messages?beta=true");
});

it("marks a non-streaming Anthropic message with stop_reason completed", async () => {
  const facts: ProviderCallObservation[] = [];
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "claude-test", observe: fact => { facts.push(fact); },
    fetchUpstream: async () => new Response(JSON.stringify({ type: "message", model: "claude-test", stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } }), { headers: { "content-type": "application/json" } }) });
  try {
    const response = await fetch(relay.baseUrl + "/messages", { method: "POST", body: '{"model":"claude-test","messages":[]}' });
    expect(response.status).toBe(200); await response.text();
  } finally { await relay.close(); }
  expect(facts[1]).toMatchObject({ state: "completed", completeness: "complete", tokens: { inputTotal: 10, outputTotal: 5, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 15 } });
});
