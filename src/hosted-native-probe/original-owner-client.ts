import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { retainedResourceCanonicalJson } from "../core/scoped-retained-resource-contract.js";
import { decodeNativeProbeRequest } from "./protocol.js";
import { NativeProbeOperation, type NativeProbeRequest } from "../worker-core/hosted-custody/domain/native-probe.js";
const executable = "/opt/subscription-runtime/native-probe/native-root-client";
const header = 20, capacity = 65536;
const operations = Object.freeze({ [NativeProbeOperation.Start]: 1, [NativeProbeOperation.Status]: 2, [NativeProbeOperation.Stop]: 3 });
export function encodeOriginalDataRequest(input: NativeProbeRequest, correlation: bigint): Buffer {
  const request = decodeNativeProbeRequest(input);
  if (correlation < 1n || correlation > (1n << 64n) - 1n) throw new Error("invalid DATA correlation");
  const bytes = Buffer.alloc(117 + request.jobId.length);
  bytes.write("NPR3", 0, "ascii"); bytes[4] = 3; bytes[5] = operations[request.operation];
  bytes.writeUInt32BE(bytes.length - header, 8); bytes.writeBigUInt64BE(correlation, 12);
  bytes.write(request.allocationDigest, 20, "ascii"); bytes.write(request.machineId, 84, "ascii");
  bytes[116] = request.jobId.length; bytes.write(request.jobId, 117, "ascii"); return bytes;
}
export function decodeOriginalDataResponse(bytes: Buffer, request: NativeProbeRequest, correlation: bigint): unknown {
  if (bytes.length < header || bytes.length > capacity || !bytes.subarray(0, 4).equals(Buffer.from("NPD3", "ascii")) || bytes[4] !== 3 || bytes[5] !== operations[request.operation] || bytes[6]! > 1 || bytes[7] !== 0 || bytes.readUInt32BE(8) !== bytes.length - header || bytes.readBigUInt64BE(12) !== correlation) throw new Error("invalid original DATA response");
  if (bytes[6] !== 0) throw new Error("original NativeProbe unavailable");
  const payload = bytes.subarray(header), data: unknown = JSON.parse(payload.toString("utf8"));
  if (!payload.equals(Buffer.from(retainedResourceCanonicalJson(data), "utf8"))) throw new Error("noncanonical original DATA response");
  return data; // Never an owning port, registry member, issuance or closure proof.
}
function checkedExecutable(): void {
  for (let path = dirname(executable); ; path = dirname(path)) {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw new Error("untrusted original DATA client ancestor");
    if (path === "/") break;
  }
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = fstatSync(fd), named = lstatSync(executable);
    if (!held.isFile() || held.uid !== 0 || held.gid !== 0 || held.nlink !== 1 || (held.mode & 0o022) || !(held.mode & 0o111) || held.dev !== named.dev || held.ino !== named.ino) throw new Error("untrusted original DATA client");
  } finally { closeSync(fd); }
}
// Fixed client callables and bytes only. Caller DATA cannot choose a socket,
// namespace, executable, native handle, environment or success supplier.
export async function requestOriginalData(input: NativeProbeRequest): Promise<unknown> {
  const request = decodeNativeProbeRequest(input);
  const correlation = randomBytes(8).readBigUInt64BE() || 1n;
  const bytes = encodeOriginalDataRequest(request, correlation); checkedExecutable();
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  const chunks: Buffer[] = []; let count = 0, failure: Error | null = null;
  const timer = setTimeout(() => { failure = new Error("original DATA client deadline"); child.kill("SIGKILL"); }, 2500);
  child.stdout.on("data", (chunk: Buffer) => { count += chunk.length; if (count > capacity) { failure = new Error("original DATA response capacity"); child.kill("SIGKILL"); } else chunks.push(chunk); });
  child.stderr.resume(); child.stdin.on("error", error => { failure = error; });
  child.on("error", error => { failure = error; }); child.stdin.end(bytes);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(accept => child.once("close", (code, signal) => accept({ code, signal })));
  clearTimeout(timer);
  if (failure || result.code !== 0 || result.signal !== null) throw failure ?? new Error("original NativeProbe unavailable");
  return decodeOriginalDataResponse(Buffer.concat(chunks), request, correlation);
}
