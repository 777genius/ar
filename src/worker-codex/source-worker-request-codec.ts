import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { SourceWorkerOperation, SourceWorkerState, SourceWorkerOutcome, ProjectAdmissionWorkerRole,
  type SourceWorkerBinding, type SourceWorkerRequestIdentity, type SourceWorkerRequestRecord, type SourceWorkerReadModel } from "@vioxen/subscription-runtime/worker-core";
import { workerLaunchAdmissionSchema } from "./application/project-control/worker-launch-spec";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const duration = z.number().int().positive().max(24 * 60 * 60_000);
const path = z.string().max(4096).refine(value => value.startsWith("/") && posix.normalize(value) === value && !/[\u0000-\u001f\\]/.test(value));
const base = { schemaVersion: z.literal(1), requestId: id, workstreamId: id, expectedMachineId: id };
const refill = z.object({ sourceWorkspacePath: path, workspacePath: path, newBranch: z.string().min(1).max(256),
  promptBody: z.string().min(1).max(256 * 1024), workerRole: z.enum([ProjectAdmissionWorkerRole.Producer, ProjectAdmissionWorkerRole.Fastgate, ProjectAdmissionWorkerRole.Reviewer, ProjectAdmissionWorkerRole.Adoption]),
  reasoningEffort: z.enum(["medium", "high", "xhigh"]), preStartAdmission: workerLaunchAdmissionSchema,
  model: z.literal("gpt-6.1-sol").default("gpt-6.1-sol"), serviceTier: z.literal("default").default("default"),
  executionMode: z.literal("sync").default("sync"), timeoutMs: duration, cleanupTimeoutMs: duration,
}).strict();
const start = z.object({ ...base, operation: z.literal(SourceWorkerOperation.Start), workerJobId: id,
  sourceSha: sha, expectedConfigSha256: hash, deadlineMs: z.number().int().positive().safe(), refill }).strict();
const lookup = z.object({ ...base, operation: z.enum([SourceWorkerOperation.Status, SourceWorkerOperation.Stop, SourceWorkerOperation.Reconcile]) }).strict();
export type SourceWorkerStartEnvelope = z.infer<typeof start>;
export type SourceWorkerEnvelope = SourceWorkerStartEnvelope | z.infer<typeof lookup>;
export function decodeSourceWorkerEnvelope(value: unknown): SourceWorkerEnvelope {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 512 * 1024) throw new Error("source_worker_envelope_too_large");
  return z.union([start, lookup]).parse(value);
}
const bindingSchema = z.object({ installationId: id, runtimeSha: sha, runtimeManifestSha256: hash, configSha256: hash, policySha256: hash, scopeSha256: hash }).strict();
const identitySchema = bindingSchema.extend({ schemaVersion: z.literal(1), requestId: id, workstreamId: id,
  expectedMachineId: id, workerJobId: id, sourceSha: sha, businessSha256: hash, fingerprint: hash,
  deadlineMs: z.number().int().positive().safe(), timeoutMs: duration, cleanupTimeoutMs: duration }).strict();
/** Sorted JSON keys make business identity independent of caller object ordering.
 * Values are already normalized by closed schemas; arrays retain semantic order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) as string;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function fingerprintSourceWorkerRequest(identity: Omit<SourceWorkerRequestIdentity, "fingerprint">): string { return digest(identity); }
export function sourceWorkerAcceptedBinding(identity: SourceWorkerRequestIdentity): SourceWorkerBinding {
  const parsed = parseSourceWorkerIdentity(identity);
  return { installationId: parsed.installationId, runtimeSha: parsed.runtimeSha, runtimeManifestSha256: parsed.runtimeManifestSha256,
    configSha256: parsed.configSha256, policySha256: parsed.policySha256, scopeSha256: parsed.scopeSha256 };
}
export function normalizeSourceWorkerStart(envelope: SourceWorkerStartEnvelope, binding: SourceWorkerBinding): SourceWorkerRequestIdentity {
  const request = start.parse(envelope), installed = bindingSchema.parse(binding);
  if (request.expectedConfigSha256 !== installed.configSha256) throw new Error("source_worker_config_mismatch");
  const identity = { ...installed, schemaVersion: 1 as const, requestId: request.requestId, workstreamId: request.workstreamId,
    expectedMachineId: request.expectedMachineId, workerJobId: request.workerJobId, sourceSha: request.sourceSha,
    businessSha256: digest(request.refill), deadlineMs: request.deadlineMs,
    timeoutMs: request.refill.timeoutMs, cleanupTimeoutMs: request.refill.cleanupTimeoutMs };
  return Object.freeze({ ...identity, fingerprint: fingerprintSourceWorkerRequest(identity) });
}
export function parseSourceWorkerIdentity(value: unknown): SourceWorkerRequestIdentity {
  const identity = identitySchema.parse(value), { fingerprint, ...fields } = identity;
  if (fingerprintSourceWorkerRequest(fields) !== fingerprint) throw new Error("source_worker_fingerprint_invalid");
  return Object.freeze(identity);
}
const recordSchema = z.object({ identity: identitySchema, revision: z.number().int().positive().safe(),
  state: z.enum(SourceWorkerState), outcome: z.enum(SourceWorkerOutcome).nullable(), brokerEpochId: id.nullable(),
  runtimeStartId: id.nullable(), sourceSpecSha256: hash.nullable(), terminationFenceSha256: hash.nullable(), terminalReceiptSha256: hash.nullable() }).strict();
export function parseSourceWorkerRequestRecord(value: unknown): SourceWorkerRequestRecord {
  const record = recordSchema.parse(value);
  if ((record.state === SourceWorkerState.Terminal) !== (record.outcome !== null && record.terminalReceiptSha256 !== null) ||
      (record.state !== SourceWorkerState.Terminal && (record.outcome !== null || record.terminalReceiptSha256 !== null)) ||
      (record.state === SourceWorkerState.StopRequested && record.terminationFenceSha256 === null) ||
      ((record.state === SourceWorkerState.Starting || record.state === SourceWorkerState.Running) && record.terminationFenceSha256 !== null) ||
      (record.state === SourceWorkerState.Running && (record.runtimeStartId === null || record.sourceSpecSha256 === null || record.brokerEpochId === null))) throw new Error("source_worker_record_invalid");
  return Object.freeze({ ...record, identity: parseSourceWorkerIdentity(record.identity) });
}
export function sourceWorkerReadModel(record: SourceWorkerRequestRecord): SourceWorkerReadModel {
  const { identity, ...phase } = parseSourceWorkerRequestRecord(record);
  return { ...phase, requestId: identity.requestId, workstreamId: identity.workstreamId, workerJobId: identity.workerJobId,
    fingerprint: identity.fingerprint, deadlineMs: identity.deadlineMs };
}
