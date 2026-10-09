import { NativeProbeKind, NativeProbeOperation, type NativeProbeRequest } from "../worker-core/hosted-custody/domain/native-probe.js";
import { retainedResourceCanonicalJson } from "../core/scoped-retained-resource-contract.js";

const fields = ["allocationDigest", "jobId", "kind", "machineId", "operation"] as const;
function exact(value: unknown): Record<string, unknown> {
  // Refuse getters, symbols and non-plain objects before reading caller DATA.
  retainedResourceCanonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid NativeProbe request");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) throw new Error("invalid NativeProbe request fields");
  return record;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function operation(value: unknown): value is NativeProbeOperation {
  return value === NativeProbeOperation.Start || value === NativeProbeOperation.Status || value === NativeProbeOperation.Stop;
}
// This decoder returns DATA. Neither digest nor request identity is an owner,
// issuance slot, clock association, channel or FoundationOnly handoff.
export function decodeNativeProbeRequest(value: unknown): NativeProbeRequest {
  const record = exact(value);
  if (record.kind !== NativeProbeKind.NativeProbe || !operation(record.operation) || !digest(record.allocationDigest) || !identifier(record.jobId) || record.jobId.length > 32 || typeof record.machineId !== "string" || !/^[a-f0-9]{32}$/.test(record.machineId)) throw new Error("invalid NativeProbe request");
  return Object.freeze({ kind: NativeProbeKind.NativeProbe, operation: record.operation, allocationDigest: record.allocationDigest, jobId: record.jobId, machineId: record.machineId });
}
export function readNativeProbeRequest(bytes: string): NativeProbeRequest {
  if (Buffer.byteLength(bytes, "utf8") > 65536) throw new Error("NativeProbe request capacity exceeded");
  let value: unknown;
  try { value = JSON.parse(bytes); }
  catch { throw new Error("invalid NativeProbe request JSON"); }
  // Request grammar has no LF. Byte equality rejects duplicate and escaped keys.
  if (retainedResourceCanonicalJson(value) !== bytes) throw new Error("noncanonical NativeProbe request");
  return decodeNativeProbeRequest(value);
}
