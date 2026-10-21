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

it("never dispatches unauthorized model/path requests", async () => {
  const transport = vi.fn<typeof fetch>();
  const relay = await startProviderUsageRelay({ upstreamBaseUrl: "https://provider.test/v1", model: "allowed", observe: () => {}, fetchUpstream: transport });
  try {
    expect((await fetch(relay.baseUrl + "/responses", { method: "POST", body: '{"model":"foreign"}' })).status).toBe(400);
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
