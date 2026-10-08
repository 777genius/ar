import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Readable } from "node:stream";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readRequestBytes } from "../host-jobs/read-request.mjs";
import { routeProbeIngress } from "../../src/hosted-native-probe/ingress.js";
import { encodeOriginalDataRequest, decodeOriginalDataResponse } from "../../src/hosted-native-probe/original-owner-client.js";
import { NativeProbeKind, NativeProbeOperation, NativeProbeProfile, type NativeProbeAllocation, type NativeProbeFacts } from "../../src/worker-core/hosted-custody/domain/native-probe.js";
import { nativeProbe } from "../../src/worker-core/hosted-custody/application/native-probe.js";
import { OriginalNativeProbe } from "../../src/worker-core/hosted-custody/ports/native-probe.js";
const request = Object.freeze({ allocationDigest: "a".repeat(64), jobId: "sandbox", kind: NativeProbeKind.NativeProbe, machineId: "b".repeat(32), operation: NativeProbeOperation.Status });
const canonical = JSON.stringify(request);
// Red if original bytes are normalized before native routing, or escaped/duplicate
// native discriminators can reach a legacy effect after JSON.parse erased them.
test("raw collector preserves canonical bytes and refuses native legacy downgrade", async () => {
  let legacyDispatches = 0, nativeDispatches = 0;
  const dispatch = async (text: string): Promise<void> => {
    const route = routeProbeIngress(await readRequestBytes(Readable.from([Buffer.from(text.slice(0, 15)), Buffer.from(text.slice(15))])));
    if (route.native) nativeDispatches++; else legacyDispatches++;
  };
  await dispatch(canonical); assert.equal(nativeDispatches, 1);
  const invalid = [
    " " + canonical, canonical + "\n", canonical.replace('"jobId":"sandbox"', '"jobId":"old","jobId":"sandbox"'),
    canonical.replace('"kind"', '"ki\\u006ed"'),
    '{"kind":"NativeProbe","kind":"legacy","operation":"start"}',
    '{"allocationDigest":"bad","allocationDigest":null,"operation":"start"}',
    '{"alloca\\u0074ionDigest":"bad","operation":"start"}',
    canonical.slice(0, -1) + ',"argv":["/bin/true"]}', "{",
  ];
  for (const text of invalid) await assert.rejects(dispatch(text));
  assert.equal(nativeDispatches, 1); assert.equal(legacyDispatches, 0);
  await dispatch(' { "operation" : "status", "jobId": "sandbox", "machineId": "legacy" }\n');
  assert.equal(legacyDispatches, 1);
});
// Red if oversize or a never-EOF stream gets a second allowance or dispatches.
test("collector capacity and one EOF deadline precede dispatch", async () => {
  await assert.rejects(readRequestBytes(Readable.from([Buffer.alloc(65537)])), /too large/);
  const idle = new PassThrough(); idle.write(canonical);
  await assert.rejects(readRequestBytes(idle, { timeoutMs: 15 }), /deadline/);
  assert.equal(idle.destroyed, true);
});
// Red if DATA response correlation, shape, operation or byte spelling can change.
// These DATA-only bytes deliberately carry no owner/Root certificate.
test("DATA response wire rejects foreign correlation, reserved-header and noncanonical data", () => {
  const query = encodeOriginalDataRequest(request, 1n);
  const response = Buffer.alloc(22); response.write("NPD3"); response[4] = 3; response[5] = query[5]!; response.writeUInt32BE(2, 8); response.writeBigUInt64BE(1n, 12); response.write("{}", 20);
  assert.deepEqual(decodeOriginalDataResponse(response, request, 1n), {});
  const highBitMagic = Buffer.from(response); highBitMagic[0] = highBitMagic[0]! | 0x80;
  assert.throws(() => decodeOriginalDataResponse(highBitMagic, request, 1n), /invalid/);
  const invalidUtf8 = Buffer.concat([response.subarray(0, 20), Buffer.from('{"data":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  invalidUtf8.writeUInt32BE(invalidUtf8.length - 20, 8);
  assert.throws(() => decodeOriginalDataResponse(invalidUtf8, request, 1n), /noncanonical/);
  assert.throws(() => decodeOriginalDataResponse(response, request, 2n));
  const extra = Buffer.concat([response, Buffer.from("\n")]); extra.writeUInt32BE(3, 8);
  assert.throws(() => decodeOriginalDataResponse(extra, request, 1n), /noncanonical/);
  response[7] = 1; assert.throws(() => decodeOriginalDataResponse(response, request, 1n));
  response[7] = 0; response[6] = 1; assert.throws(() => decodeOriginalDataResponse(response, request, 1n), /unavailable/);
});
// Red if the actual native consumer accepts malformed input before socket lookup.
// No valid query is sent to any installed socket or real user infrastructure.
test("actual fixed native DATA client refuses malformed original packets without output", async () => {
  const client = process.env.NP_DATA_CLIENT; assert.ok(client, "owned harness must build the actual client");
  for (const bytes of [Buffer.from("{}"), Buffer.concat([encodeOriginalDataRequest(request, 1n), Buffer.from("x")]), Buffer.alloc(151)]) {
    const child = spawn(client, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    const output: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(bytes);
    const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
    assert.equal(result.code, 77); assert.equal(result.signal, null); assert.equal(Buffer.concat(output).length, 0);
  }
});

// Red if TypeScript and native serialization disagree, or native permits extras.
test("actual native DATA codec consumes exact TypeScript wire and rejects padding", async () => {
  const codec = process.env.NP_DATA_CODEC; assert.ok(codec, "owned harness must build actual codec");
  for (const [bytes, expected] of [[encodeOriginalDataRequest(request, 1n), 0], [Buffer.concat([encodeOriginalDataRequest(request, 1n), Buffer.from([0])]), 77]] as const) {
    const child = spawn(codec, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    const output: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(bytes);
    const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
    assert.equal(result.code, expected); assert.equal(result.signal, null);
    if (expected === 0) assert.throws(() => decodeOriginalDataResponse(Buffer.concat(output), request, 1n), /unavailable/);
    else assert.equal(Buffer.concat(output).length, 0);
  }
});

// Red if the installed composition sends canonical or downgrade native DATA
// into HostJobs. Run actual endpoint with a disposable home and inspect no ledger.
test("actual endpoint refuses native requests before any legacy ledger", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-ingress-home-"));
  try {
    for (const bytes of [canonical, '{"kind":"NativeProbe","kind":"legacy","operation":"start"}']) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../host-jobs/endpoint.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: home } });
      const output: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(bytes);
      const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
      assert.equal(result.code, 1); assert.equal(result.signal, null);
      const data: unknown = JSON.parse(Buffer.concat(output).toString()); assert.ok(data && typeof data === "object" && "ok" in data && data.ok === false && "error" in data && typeof data.error === "string");
      assert.match(data.error, bytes === canonical ? /producer unavailable/ : /noncanonical/);
      assert.deepEqual(await readdir(home), []);
    }
  } finally { await rm(home, { recursive: true, force: false }); }
});

// Red on the prior application: matching job/machine with a foreign complete
// allocation digest reaches start/stop/observe. This nominal fixture has no native
// handles and cannot prove privileged authority; it exercises DATA identity only.
test("application rejects foreign complete allocation digest before effects", async () => {
  const calls: string[] = [];
  const allocation: NativeProbeAllocation = {
    version: 1, kind: NativeProbeKind.NativeProbe, profile: NativeProbeProfile.OriginalFoundationV1,
    jobId: request.jobId, machineId: request.machineId, installationDigest: "1".repeat(64), profileDigest: "2".repeat(64), manifestDigest: "3".repeat(64),
    issuanceAnchorNs: "1000", preparationEndNs: "120000001000", absoluteCleanupEndNs: "180000001000", cleanupReservation: "sandbox-reservation",
    declarations: [{ identity: "root", ordinal: 0, lifetime: "main", parent: null, workEndNs: "120000001000", cleanupEndNs: "180000001000" }],
    limits: { infrastructureTasks: 64, infrastructureThreads: 16, messages: 128, journalEntries: 256, declarations: 1, targets: 1 },
  };
  class NominalIdentityFixture extends OriginalNativeProbe {
    constructor() { super(); }
    allocation(): NativeProbeAllocation { return allocation; }
    async startOnce(): Promise<void> { calls.push("start"); }
    async closeOnce(): Promise<void> { calls.push("stop"); }
    async observeOriginal(): Promise<NativeProbeFacts> { calls.push("observe"); throw new Error("fixture owns no native observation"); }
  }
  const original = new NominalIdentityFixture(), port = { resolveOriginal: async () => original, issueOriginal: async () => { throw new Error("no native issuer"); } };
  for (const operation of [NativeProbeOperation.Start, NativeProbeOperation.Stop, NativeProbeOperation.Status]) await assert.rejects(nativeProbe(port, { ...request, operation }), /foreign original allocation/);
  assert.deepEqual(calls, []);
});

// Red if the actual client accepts rights/foreign correlation/short replies,
// retries after reply loss, or fails to settle its original process/streams.
// Successful DATA framing here never claims NativeProbe or owning membership.
test("actual disposable native DATA IPC settles framing and refusal", async context => {
  const fixture = process.env.NP_DATA_IPC; assert.ok(fixture, "owned harness must build actual IPC peer");
  for (const mode of ["data", "rights", "peer", "version", "extra", "correlation", "short", "eof", "delay", "backpressure", "utf8", "magic"]) {
    const child = spawn(fixture, [mode], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    const out: Buffer[] = [], err: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => out.push(chunk)); child.stderr.on("data", (chunk: Buffer) => err.push(chunk)); child.stdin.on("error", () => {}); child.stdin.end(encodeOriginalDataRequest(request, 1n));
    const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
    if (result.code === 78 && mode === "data" && process.getuid?.() !== 0) { context.skip("DATA IPC needs UID0; no authority credit"); return; }
    assert.equal(result.code, 0, mode); assert.equal(result.signal, null); assert.equal(Buffer.concat(err).length, 0);
    if (mode === "utf8") {
      // The actual C client forwards bounded DATA bytes, then TS must reject
      // malformed UTF-8 instead of canonicalizing its lossy replacement string.
      const bytes = Buffer.concat(out); assert.equal(bytes.length, 32); assert.equal(bytes[29], 0xff);
      assert.throws(() => decodeOriginalDataResponse(bytes, request, 1n), /noncanonical/);
    } else assert.equal(Buffer.concat(out).length, 0);
  }
});
