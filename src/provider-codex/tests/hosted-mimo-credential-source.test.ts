import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { captureHostedMimoCodingProxyCredential, assertHostedMimoCodingCredentialCapture, readHostedMimoCredentialAtPath, resolveHostedMimoCodingProxyCredential } from "../hosted-mimo-credential-source";
import { startMimoCredentialProxy } from "../hosted-mimo-credential-proxy";
import { createHash } from "node:crypto";
import type { HostedMimoCodingWorkerOrigin } from "../hosted-mimo-worker-origin";

const originFence = vi.hoisted(() => ({ current: vi.fn(), pathReads: 0 }));
vi.mock("../hosted-mimo-worker-origin", () => ({
  assertHostedMimoCodingWorkerOriginCurrent: originFence.current,
  readHostedMimoWorkerOrigin: () => null,
}));

const syntheticOwner = vi.hoisted(() => ({ root: "", fixedCredentialPath: "", ancestorUid: 0, fileUid: 0 }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (path: Parameters<typeof fs.openSync>[0], flags: number) => fs.openSync(
      path === "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key" && syntheticOwner.fixedCredentialPath
        ? syntheticOwner.fixedCredentialPath : path, flags),
    lstatSync: (path: string) => {
      if (syntheticOwner.fixedCredentialPath &&
          (path === "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key" ||
           "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key".startsWith(path.endsWith("/") ? path : path + "/"))) {
        const file = path === "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key";
        const stat = fs.lstatSync(file ? syntheticOwner.fixedCredentialPath : syntheticOwner.root);
        return Object.assign(stat, { uid: 0, mode: stat.mode & ~0o022 });
      }
      originFence.pathReads++;
      const stat = fs.lstatSync(path);
      const ancestor = syntheticOwner.root !== "" &&
        syntheticOwner.root.startsWith(path.endsWith("/") ? path : `${path}/`);
      const within = syntheticOwner.root !== "" &&
        (path === syntheticOwner.root || path.startsWith(`${syntheticOwner.root}/`));
      return ancestor || within
        ? Object.assign(stat, { uid: syntheticOwner.ancestorUid,
          mode: ancestor ? stat.mode & ~0o022 : stat.mode })
        : stat;
    },
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: syntheticOwner.fileUid }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  syntheticOwner.root = "";
  syntheticOwner.fixedCredentialPath = "";
  syntheticOwner.ancestorUid = 0;
  syntheticOwner.fileUid = 0;
  originFence.current.mockReset();
  originFence.pathReads = 0;
});

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".synthetic-mimo-source-"));
  // Keep real symlink, mode, link, size and rotation behavior; only synthetic
  // ownership and checkout ancestry metadata are normalized for user CI.
  syntheticOwner.root = directory;
  directories.push(directory);
  const path = join(directory, "key");
  await writeFile(path, "synthetic-token-a\n", { mode: 0o600 });
  return { directory, path };
}

describe("hosted MiMo credential filesystem boundary", () => {
  it("does not inspect the credential path after its origin check closes the original lifetime", () => {
    let active = true;
    originFence.current.mockImplementationOnce(() => { active = false; });
    const assertActive = () => { if (!active) throw new Error("TEST-original-expired"); };
    expect(() => resolveHostedMimoCodingProxyCredential({} as HostedMimoCodingWorkerOrigin,
      new DefaultRedactor(), assertActive)).toThrow("TEST-original-expired");
    expect(originFence.pathReads).toBe(0);
  });
  it("opens the rotated file afresh and registers each synthetic value before returning it", async () => {
    // Regression: caching the first open or registering redaction after return
    // exposes the old key or a downstream error string.
    const { directory, path } = await fixture();
    const redactor = new DefaultRedactor();
    expect(readHostedMimoCredentialAtPath(path, redactor)).toBe("synthetic-token-a");
    const replacement = join(directory, "next-key");
    await writeFile(replacement, "synthetic-token-b\n", { mode: 0o600 });
    await rename(replacement, path);
    expect(readHostedMimoCredentialAtPath(path, redactor)).toBe("synthetic-token-b");
    expect(redactor.redact("synthetic-token-a synthetic-token-b")).not.toMatch(/synthetic-token-[ab]/);
  });

  it("rejects a symlink, hard link, oversized file, loose mode, and non-root owner", async () => {
    // Regression: a substituted or readable shared source becomes launch authority.
    const { directory, path } = await fixture();
    const reject = (target: string) => expect(() => readHostedMimoCredentialAtPath(target, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    const symlinkPath = join(directory, "symlink");
    await symlink(path, symlinkPath); reject(symlinkPath);
    const hardlinkPath = join(directory, "hardlink");
    await link(path, hardlinkPath); reject(path);
    await rm(hardlinkPath);
    await writeFile(path, "x".repeat(4097), { mode: 0o600 }); reject(path);
    await writeFile(path, "synthetic-token\n", { mode: 0o600 });
    await chmod(path, 0o644); reject(path);
    await chmod(path, 0o600);
    syntheticOwner.fileUid = 1;
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    syntheticOwner.fileUid = 0;
  });

  it("rejects writable or symlinked ancestry", async () => {
    // Regression: a rename-capable ancestor can redirect the fixed lookup.
    const { directory, path } = await fixture();
    await chmod(directory, 0o777);
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    await chmod(directory, 0o700);
    syntheticOwner.ancestorUid = 1;
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    syntheticOwner.ancestorUid = 0;
    const alias = join(process.cwd(), `.synthetic-mimo-link-${process.pid}`);
    try {
      await symlink(directory, alias);
      expect(() => readHostedMimoCredentialAtPath(join(alias, "key"), new DefaultRedactor()))
        .toThrow("hosted_mimo_credential_invalid");
    } finally { await rm(alias, { force: true }); }
  });
});


// These transport contracts fail if HTTP success/text is treated as completion,
// a later quota/error reuses old success, rotation sends a stale key, or cleanup
// returns proof while an owned proxy request is still running.
async function proofFixture(responses: Response[]) {
  const source = await fixture();
  syntheticOwner.fixedCredentialPath = source.path;
  let lifetimeActive = true;
  const assertActive = () => { if (!lifetimeActive) throw Error("TEST execution lifetime closed"); };
  const capture = captureHostedMimoCodingProxyCredential({} as HostedMimoCodingWorkerOrigin, new DefaultRedactor(), assertActive);
  const transport = vi.fn<typeof fetch>(async () => responses.shift()!);
  const proxy = await startMimoCredentialProxy({ apiKey: capture.bytes, credentialCapture: capture,
    model: "mimo-v2.6-pro", fetchUpstream: transport, assertCurrent: assertActive,
    limits: { deadlineMs: Date.now() + 10000, maxRequests: 10, maxConcurrency: 1,
      maxBodyBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 100, requestTimeoutMs: 2000 } });
  capture.bytes.fill(0);
  const post = () => fetch(proxy.baseUrl + "/responses", { method: "POST",
    headers: { authorization: `Bearer ${proxy.capability}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-v2.6-pro", input: "synthetic task" }) });
  return { ...source, capture, proxy, transport, post, endLifetime() { lifetimeActive = false; } };
}
const complete = (id = "resp_synthetic") => ({ object: "response", id, status: "completed", model: "mimo-v2.6-pro", error: null });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const sse = (...values: unknown[]) => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });

it("retains source-minted proof for multiple admitted HTTP rounds and joins real proxy disposal", async () => {
  const f = await proofFixture([json(complete("resp_one")), sse({ type: "response.completed", response: complete("resp_two") })]);
  try {
    expect(f.capture.credentialFingerprint).toBe(createHash("sha256")
      .update("subscription-runtime:mimo-current-credential:v1\0").update("synthetic-token-a").digest("hex"));
    expect(() => assertHostedMimoCodingCredentialCapture({ ...f.capture }, Buffer.from("synthetic-token-a"))).toThrow("capture_invalid");
    expect(f.proxy.capacityRecoveryProof()).toBeUndefined();
    await (await f.post()).text();
    await vi.waitFor(() => expect(f.proxy.capacityRecoveryProof()?.completedResponses).toBe(1));
    const first = f.proxy.capacityRecoveryProof()!;
    expect(() => first.assertDisposed()).toThrow("not_disposed");
    await (await f.post()).text();
    await vi.waitFor(() => expect(f.proxy.capacityRecoveryProof()?.completedResponses).toBe(2));
    expect(() => first.assertCurrent()).toThrow("proof_invalid");
    const proof = f.proxy.capacityRecoveryProof()!;
    expect(proof.requestedModel).toBe("mimo-v2.6-pro");
    expect(proof.requestSha256).toBe(createHash("sha256").update("subscription-runtime:mimo-request:v1\0")
      .update(String(f.transport.mock.calls[1]![1]!.body)).digest("hex"));
    expect(proof.responseIdSha256).toBe(createHash("sha256").update("subscription-runtime:mimo-response-id:v1\0").update("resp_two").digest("hex"));
    const closing = f.proxy.close();
    expect(() => proof.assertDisposed()).toThrow("not_disposed");
    await closing; f.endLifetime();
    expect(() => proof.assertDisposed()).not.toThrow();
    expect(() => proof.assertCurrent()).not.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(2);
    await expect(f.post()).rejects.toThrow(); // Closed listener cannot regain request authority.
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(proof)).not.toContain("synthetic-token-a");
    expect(JSON.stringify(proof)).not.toContain("resp_two");
  } finally { await f.proxy.close(); }
});

it.each([
  json({ error: { code: "insufficient_quota" } }),
  json({ status: "completed", usage: { output_tokens: 1 } }),
  sse({ type: "response.completed" }),
  new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
  sse({ type: "response.completed", response: complete() }, { type: "error", error: { code: "quota" } }),
  sse({ type: "response.incomplete", response: { ...complete(), status: "incomplete" } }),
  sse({ type: "response.completed", response: complete() }, { type: "response.created", response: { error: { code: "quota" } } }),
  sse({ type: "response.completed", response: complete() }, { type: "response.error" }),
])("never mints proof from weak completion or HTTP 200 protocol errors", async response => {
  const f = await proofFixture([response]);
  try { expect((await (await f.post()).text()).length).toBeGreaterThan(0); expect(f.proxy.capacityRecoveryProof()).toBeUndefined(); }
  finally { await f.proxy.close(); }
});

it.each([429, 200])("invalidates earlier positive proof on later quota (%i) and remains closed after another completion", async status => {
  const quota = status === 429 ? new Response("synthetic quota", { status }) : json({ error: { code: "insufficient_quota" } });
  const f = await proofFixture([json(complete()), quota, json(complete("resp_later"))]);
  try {
    await (await f.post()).text();
    await vi.waitFor(() => expect(f.proxy.capacityRecoveryProof()).toBeDefined());
    const proof = f.proxy.capacityRecoveryProof()!;
    const response = await f.post(); await response.text();
    expect(response.status).toBe(status === 429 ? 502 : 200);
    await vi.waitFor(() => expect(f.proxy.capacityRecoveryProof()).toBeUndefined());
    expect(() => proof.assertCurrent()).toThrow("proof_invalid");
    await (await f.post()).text();
    expect(f.proxy.capacityRecoveryProof()).toBeUndefined();
    expect(f.proxy.upstreamFailureObservation()).toEqual(status === 429 ? { count: 1, lastStatus: 429 } : undefined);
  } finally { await f.proxy.close(); }
});

it("rechecks the actual source key before dispatch and before returning or validating proof", async () => {
  for (const rotateAfterCompletion of [false, true]) {
    const f = await proofFixture([json(complete())]);
    try {
      let proof: ReturnType<typeof f.proxy.capacityRecoveryProof>;
      if (rotateAfterCompletion) {
        await (await f.post()).text();
        await vi.waitFor(() => expect(f.proxy.capacityRecoveryProof()).toBeDefined());
        proof = f.proxy.capacityRecoveryProof();
        await f.proxy.close(); f.endLifetime();
        expect(() => proof!.assertCurrent()).not.toThrow();
      }
      const replacement = join(f.directory, "rotated");
      await writeFile(replacement, "synthetic-token-b", { mode: 0o600 }); await rename(replacement, f.path);
      if (rotateAfterCompletion) {
        expect(() => proof!.assertCurrent()).toThrow("credential_changed");
        expect(f.proxy.capacityRecoveryProof()).toBeUndefined();
      } else {
        expect((await f.post()).status).toBe(503);
        expect(f.transport).not.toHaveBeenCalled();
      }
    } finally { await f.proxy.close(); }
  }
});

it("joins cancellation of an active upstream body before closing and never grants incomplete-response proof", async () => {
  let finishCancel!: () => void, startedCancel!: () => void;
  const cancelled = new Promise<void>(resolve => { startedCancel = resolve; });
  const releaseCancel = new Promise<void>(resolve => { finishCancel = resolve; });
  const cancel = vi.fn(async () => { startedCancel(); await releaseCancel; });
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"object":"response","id":"resp_pending","status":"in_progress"}}\n\n')); },
    cancel,
  });
  const f = await proofFixture([new Response(upstream, { headers: { "content-type": "text/event-stream" } })]);
  try {
    const response = await f.post(), reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(f.proxy.capacityRecoveryProof()).toBeUndefined();
    const reading = reader.read().catch(() => undefined);
    let closed = false;
    const closing = f.proxy.close().then(() => { closed = true; });
    await cancelled; await reading;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    expect(f.proxy.capacityRecoveryProof()).toBeUndefined();
    finishCancel(); await closing;
    expect(closed).toBe(true); expect(upstream.locked).toBe(false);
    expect(f.proxy.capacityRecoveryProof()).toBeUndefined();
    expect(f.transport).toHaveBeenCalledOnce();
    await expect(f.post()).rejects.toThrow();
    reader.releaseLock();
  } finally { finishCancel(); await f.proxy.close(); }
});
