import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), current: vi.fn(), credential: vi.fn(), start: vi.fn() }));
vi.mock("../hosted-mimo-worker-origin", () => ({ readHostedMimoCodingWorkerOrigin: mocks.read, assertHostedMimoCodingWorkerOriginCurrent: mocks.current }));
vi.mock("../hosted-mimo-credential-source", () => ({ resolveHostedMimoCodingProxyCredential: mocks.credential }));
vi.mock("../hosted-mimo-credential-proxy", () => ({ startMimoCredentialProxy: mocks.start }));
import { createHostedMimoCodingProxyMaterial } from "../hosted-mimo-coding-proxy-material";
import { hostedMimoCodingBootstrapForFrame } from "../hosted-mimo-coding-bootstrap-registry";
import { codexMimoApiKeyEnvVarDefault } from "../codex-model-backend";
import { AppServerExecutionLifetime } from "../app-server/application/app-server-child-lifetime";
afterEach(() => vi.clearAllMocks());
function setup(digest: string) {
  const origin = { digest, startId: "12345678-1234-1234-1234-123456789abc", homeRoot: "/job/home", workspacePath: "/workspace", model: "mimo-v2.6-pro", maxGoalTurns: 32, taskTimeoutMs: 60000, codexBinaryPath: "/opt/codex" };
  const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 50000, maxGoalTurns: 32, binding: { allocationId: "TEST", incarnationId: digest } });
  const proxy = { capability: "TEST-cap-" + digest, baseUrl: "http://127.0.0.1:1234/v1", revoke: vi.fn(), close: vi.fn(async () => {}) };
  mocks.read.mockReturnValue(origin); mocks.current.mockImplementation(() => {}); mocks.credential.mockReturnValue("TEST-real-key-never-bootstrap"); mocks.start.mockResolvedValue(proxy);
  const input = { model: origin.model, lifetime, redactor: { registerSecret: vi.fn(), redact: (value: string) => value, assertNoKnownSecret: vi.fn() } };
  return { origin, lifetime, proxy, input };
}
it("keeps key out of bootstrap, zeroes key bytes, binds executable/workspace and consumes start once", async () => {
  const f = setup("a".repeat(64)); const material = await createHostedMimoCodingProxyMaterial(f.input);
  try {
    expect(material?.capability).toBe(f.proxy.capability);
    expect(Buffer.from(mocks.start.mock.calls[0]![0].apiKey).every(byte => byte === 0)).toBe(true);
    const frame = { command: "/opt/codex", cwd: "/workspace", env: { CODEX_HOME: "/job/home/mimo-1/codex-home", [codexMimoApiKeyEnvVarDefault]: f.proxy.capability } };
    const bootstrap = hostedMimoCodingBootstrapForFrame(frame)!;
    expect(bootstrap.specSha256).toBe(f.origin.digest); expect(bootstrap.configToml).toContain(f.proxy.baseUrl);
    expect(bootstrap.configToml).toContain('[features.network_proxy]\nenabled = true\ndomains = { "*" = "allow" }');
    expect(bootstrap.configToml.match(/allow_local_binding = false/g)).toHaveLength(3);
    expect(bootstrap.configToml.match(/allow_upstream_proxy = false/g)).toHaveLength(3);
    expect(bootstrap.configToml).toContain('credential_broker = false');
    expect(bootstrap.configToml).toContain('request_max_retries = 0');
    expect(bootstrap.configToml).toContain('stream_max_retries = 0');
    expect(bootstrap.configToml).toContain('supports_websockets = false');
    expect(JSON.stringify(bootstrap)).not.toContain("TEST-real-key"); expect(JSON.stringify(bootstrap)).not.toContain(f.proxy.capability);
    expect(() => hostedMimoCodingBootstrapForFrame({ ...frame, command: "/bin/sh" })).toThrow("frame_invalid");
    await expect(createHostedMimoCodingProxyMaterial(f.input)).rejects.toThrow("start_consumed");
    f.lifetime.close(new Error("TEST-stop")); expect(f.proxy.revoke).toHaveBeenCalled();
  } finally { await material?.close(); }
  expect(f.proxy.close).toHaveBeenCalledOnce();
});
it("denies stale independent authority before credential read", async () => {
  const f = setup("b".repeat(64)); mocks.current.mockImplementation(() => { throw new Error("stale"); });
  await expect(createHostedMimoCodingProxyMaterial(f.input)).rejects.toThrow("stale"); expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});
it("does not select Coding credentials for ordinary worker origins", async () => {
  const f = setup("c".repeat(64)); mocks.read.mockReturnValue(null);
  expect(await createHostedMimoCodingProxyMaterial(f.input)).toBeNull(); expect(mocks.credential).not.toHaveBeenCalled();
});
it("shares one proxy flight and revokes it when disposal races listener startup", async () => {
  const { HostedMimoCodingProxyOwner } = await import("../hosted-mimo-coding-proxy-material");
  const f = setup("d".repeat(64));
  let resolve!: (value: typeof f.proxy) => void;
  mocks.start.mockReturnValue(new Promise(done => { resolve = done; }));
  const owner = new HostedMimoCodingProxyOwner();
  const first = owner.acquire(f.input), second = owner.acquire(f.input);
  owner.revoke(); f.lifetime.close(new Error("TEST-dispose")); resolve(f.proxy);
  const settled = await Promise.allSettled([first, second]);
  expect(settled.every(result => result.status === "rejected")).toBe(true);
  expect(mocks.start).toHaveBeenCalledOnce(); expect(f.proxy.revoke).toHaveBeenCalled(); expect(f.proxy.close).toHaveBeenCalledOnce();
});
it("joins concurrent listener closure instead of returning an early cleanup receipt", async () => {
  const f = setup("e".repeat(64)); let finish!: () => void;
  f.proxy.close.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const material = (await createHostedMimoCodingProxyMaterial(f.input))!;
  const first = material.close(), second = material.close();
  expect(first).toBe(second);
  let done = false; void second.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); finish(); await first;
  expect(f.proxy.close).toHaveBeenCalledOnce();
});
it("uses the already authenticated classified origin without a second full observation", async () => {
  const f = setup("f".repeat(64)); mocks.read.mockImplementation(() => { throw new Error("unexpected-second-full-read"); });
  const material = await createHostedMimoCodingProxyMaterial({ ...f.input, origin: f.origin as NonNullable<Parameters<typeof createHostedMimoCodingProxyMaterial>[0]["origin"]> });
  try { expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.current).toHaveBeenCalledWith(f.origin); expect(mocks.credential).toHaveBeenCalledWith(f.origin, f.input.redactor); }
  finally { await material?.close(); }
});
