import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HostedControllerFramedDispatcher, HostedControllerFrameKind, hostedControllerFrameLimit, hostedControllerPipe, relayHostedControllerPipe } from "../hosted-controller-framed-dispatcher";
import { HostedControllerToolName } from "@vioxen/subscription-runtime/provider-codex";

function pair(): [Duplex, Duplex] {
  const left = new PassThrough(); const right = new PassThrough();
  const a = hostedControllerPipe(left, right);
  const b = hostedControllerPipe(right, left);
  a.on("error", () => undefined); b.on("error", () => undefined);
  return [a, b];
}
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}
const call = { tool: HostedControllerToolName.Observe, arguments: { handle: "opaque" } };

describe("private framed dispatcher protocol", () => {
  it("acknowledges through two live bootstrap pipe handoffs", async () => {
    const [controllerPipe, firstInbound] = pair();
    const [firstOutbound, secondInbound] = pair();
    const [secondOutbound, hostPipe] = pair();
    const closeFirst = relayHostedControllerPipe(firstInbound, firstOutbound);
    const closeSecond = relayHostedControllerPipe(secondInbound, secondOutbound);
    const controller = new HostedControllerFramedDispatcher(controllerPipe);
    const host = new HostedControllerFramedDispatcher(hostPipe, { verifyRetainedOriginAndGrant: () => true });
    expect(await controller.request(call, new AbortController().signal)).toBe("disabled");
    expect(controllerPipe.destroyed).toBe(false);
    expect(hostPipe.destroyed).toBe(false);
    closeFirst(); closeSecond(); controller.close(); host.close();
  });
  it("exchanges one bounded request and response over split duplex chunks", async () => {
    const [clientStream, serverStream] = pair();
    let authorized = 0;
    let grantCurrent = true;
    const client = new HostedControllerFramedDispatcher(clientStream);
    const server = new HostedControllerFramedDispatcher(serverStream, {
      verifyRetainedOriginAndGrant: () => { authorized += 1; return grantCurrent; },
    });
    expect(await client.request(call, new AbortController().signal)).toBe("disabled");
    grantCurrent = false;
    expect(await client.request(call, new AbortController().signal)).toBe("unavailable");
    expect(authorized).toBe(2);
    server.close();
    expect(await client.request(call, new AbortController().signal)).toBe("unavailable");
    client.close();
  });

  it("closes on malformed, replayed, oversized, and foreign response frames", async () => {
    for (const malicious of [
      frame({ version: 1, kind: HostedControllerFrameKind.Request, requestId: "00000000-0000-0000-0000-000000000001",
        deadlineMs: Date.now() + 1000, tool: "shell", arguments: {} }),
      frame({ version: 1, kind: HostedControllerFrameKind.Response, requestId: "00000000-0000-0000-0000-000000000001", status: "disabled" }),
      Buffer.from([0, 1, 0, 0]),
      frame({ version: 1, kind: HostedControllerFrameKind.Cancel, requestId: "00000000-0000-0000-0000-000000000001" }),
    ]) {
      const [clientStream, serverStream] = pair();
      const server = new HostedControllerFramedDispatcher(serverStream);
      clientStream.write(malicious.subarray(0, 2));
      clientStream.write(malicious.subarray(2));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await server.request(call, new AbortController().signal)).toBe("unavailable");
      server.close(); clientStream.destroy();
    }
    expect(hostedControllerFrameLimit).toBe(16 * 1024);
  });

  it("does not invoke a handler without verified retained origin and cancels pending requests", async () => {
    const [clientStream, serverStream] = pair();
    const client = new HostedControllerFramedDispatcher(clientStream);
    const server = new HostedControllerFramedDispatcher(serverStream, {
      verifyRetainedOriginAndGrant: () => false,
    });
    expect(await client.request(call, new AbortController().signal)).toBe("unavailable");
    const abort = new AbortController(); abort.abort();
    expect(await client.request(call, abort.signal)).toBe("unavailable");
    client.close(); server.close();
  });

  it("emits a typed cancel for a pending request and denies its late response", async () => {
    const [clientStream, peer] = pair();
    const client = new HostedControllerFramedDispatcher(clientStream);
    const received: Buffer[] = [];
    peer.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
    const abort = new AbortController();
    const result = client.request(call, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    expect(await result).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bytes = Buffer.concat(received);
    const firstSize = bytes.readUInt32BE(0);
    const first = JSON.parse(bytes.subarray(4, firstSize + 4).toString()) as { requestId: string };
    const second = JSON.parse(bytes.subarray(firstSize + 8).toString()) as { kind: string; requestId: string };
    expect(second).toMatchObject({ kind: HostedControllerFrameKind.Cancel, requestId: first.requestId });
    peer.write(frame({ version: 1, kind: HostedControllerFrameKind.Response,
      requestId: first.requestId, status: "disabled" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await client.request(call, new AbortController().signal)).toBe("unavailable");
    client.close(); peer.destroy();
  });

  it("rejects replayed request IDs after one host authorization", async () => {
    const [clientStream, serverStream] = pair();
    let authorizations = 0;
    const server = new HostedControllerFramedDispatcher(serverStream, {
      verifyRetainedOriginAndGrant: () => { authorizations += 1; return true; },
    });
    const request = frame({ version: 1, kind: HostedControllerFrameKind.Request,
      requestId: "00000000-0000-0000-0000-000000000001", deadlineMs: Date.now() + 2_000,
      tool: HostedControllerToolName.Observe, arguments: { handle: "opaque" } });
    clientStream.write(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clientStream.write(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(authorizations).toBe(1);
    expect(await server.request(call, new AbortController().signal)).toBe("unavailable");
    server.close(); clientStream.destroy();
  });
});
