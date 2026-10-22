import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import { parseStoredCodexGoalJobManifest, type CodexGoalJobManifest } from "./codex-goal-jobs";
import { installedResearchRuntimeDirectory, researchJobAuthority } from "./research-launch-admission";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchHash, researchId, researchInvalid, researchJson, researchPath,
  researchRead, researchRecord } from "./research-launch-files";
import { researchProviderReservationLimit } from "./research-launch-lifecycle";
import { prepareRegisteredCodingTerminalObservation } from "./research-terminal-handoff-repair";

export enum NativeWriterClosureKind {
  RegisteredCodingTerminalV1 = "registered-coding-terminal-closure-v1",
}
export enum NativeWriterClosureIssuerContract {
  CurrentRootObservationV1 = "current-root-native-closure-observation-v1",
}
export interface NativeWriterClosureRow { readonly path: string; readonly sha256: string | null }
export interface NativeWriterClosureReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: NativeWriterClosureKind.RegisteredCodingTerminalV1;
  readonly issuer: { readonly contract: NativeWriterClosureIssuerContract.CurrentRootObservationV1;
    readonly runtimeDirectory: string; readonly artifactSha256: string };
  readonly identity: { readonly jobId: string; readonly taskId: string; readonly startId: string;
    readonly specSha256: string; readonly requestSha256: string; readonly grantSha256: string;
    readonly registryRootDir: string; readonly controllerJobId: string;
    readonly manifestRawSha256: string; readonly manifestNormalizedSha256: string; readonly registeredHandoffSha256: string };
  readonly origin: { readonly runtimeDirectory: string; readonly artifactSha256: string };
  readonly terminalSlotSha256: string;
  readonly closingSha256: string;
  readonly inputs: readonly NativeWriterClosureRow[];
  readonly starts: readonly string[];
  readonly providerUnits: readonly string[];
  readonly providerFiles: readonly string[];
  readonly published: readonly NativeWriterClosureRow[];
}
export declare const nativeClosurePreparationBrand: unique symbol;
export interface NativeClosureMutationPreparation { readonly [nativeClosurePreparationBrand]: true }
type WriterReader = () => Promise<ProjectAdmissionWriterObservation>;
type Observation = ReturnType<typeof prepareRegisteredCodingTerminalObservation>;
const leaf = "writer-closure-observation.v1.json";
const digest = (value: unknown): string => researchHash(JSON.stringify(value));
function optional(path: string): Buffer | undefined {
  try { return researchRead(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) researchInvalid();
  return value;
}
function strings(value: unknown, max: number, validate: (value: unknown) => string): readonly string[] {
  if (!Array.isArray(value) || value.length > max) researchInvalid();
  const rows = value.map(validate);
  if (rows.some((row, index) => index > 0 && rows[index - 1]! >= row)) researchInvalid();
  return rows;
}
function rows(value: unknown, nullable: boolean): readonly NativeWriterClosureRow[] {
  if (!Array.isArray(value) || value.length > 4096) researchInvalid();
  const result = value.map(value => {
    const row = researchRecord(value, "path,sha256");
    return { path: researchPath(row.path), sha256: nullable && row.sha256 === null ? null : sha(row.sha256) };
  });
  if (result.some((row, index) => index > 0 && result[index - 1]!.path >= row.path)) researchInvalid();
  return result;
}
/** Parse a fixed bounded record; its path fields never drive filesystem reads. */
function parse(bytes: Buffer): NativeWriterClosureReceiptV1 {
  if (bytes.length > 1024 * 1024) researchInvalid();
  const r = researchRecord(researchJson(bytes), "schemaVersion,kind,issuer,identity,origin,terminalSlotSha256,closingSha256,inputs,starts,providerUnits,providerFiles,published");
  if (r.schemaVersion !== 1 || r.kind !== NativeWriterClosureKind.RegisteredCodingTerminalV1) researchInvalid();
  const issuer = researchRecord(r.issuer, "contract,runtimeDirectory,artifactSha256");
  if (issuer.contract !== NativeWriterClosureIssuerContract.CurrentRootObservationV1) researchInvalid();
  researchPath(issuer.runtimeDirectory); sha(issuer.artifactSha256);
  const identity = researchRecord(r.identity, "jobId,taskId,startId,specSha256,requestSha256,grantSha256,registryRootDir,controllerJobId,manifestRawSha256,manifestNormalizedSha256,registeredHandoffSha256");
  researchId(identity.jobId); researchId(identity.taskId); researchId(identity.controllerJobId); researchPath(identity.registryRootDir);
  if (typeof identity.startId !== "string" || !/^[a-f0-9-]{36}$/.test(identity.startId)) researchInvalid();
  for (const key of ["specSha256", "requestSha256", "grantSha256", "manifestRawSha256", "manifestNormalizedSha256", "registeredHandoffSha256"]) sha(identity[key]);
  const origin = researchRecord(r.origin, "runtimeDirectory,artifactSha256");
  researchPath(origin.runtimeDirectory); sha(origin.artifactSha256); sha(r.terminalSlotSha256); sha(r.closingSha256);
  rows(r.inputs, true); rows(r.published, false);
  strings(r.starts, 1024, value => {
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) researchInvalid(); return value;
  });
  strings(r.providerUnits, researchProviderReservationLimit, researchId);
  strings(r.providerFiles, 4096, researchId);
  return r as unknown as NativeWriterClosureReceiptV1;
}
function canonicalRows(values: readonly NativeWriterClosureRow[]): readonly NativeWriterClosureRow[] {
  const result = new Map<string, NativeWriterClosureRow>();
  for (const row of values) {
    const previous = result.get(row.path);
    if (previous && previous.sha256 !== row.sha256) researchInvalid();
    result.set(row.path, row);
  }
  return [...result.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function facts(manifest: CodexGoalJobManifest, observation: Observation) {
  const { spec, bytes } = observation.current, binding = spec.registeredHandoff!;
  const manifestPath = join(binding.registryRootDir, researchId(manifest.jobId), "job.json");
  const manifestBytes = researchRead(manifestPath, false);
  const normalized = parseStoredCodexGoalJobManifest(researchJson(manifestBytes));
  if (!isDeepStrictEqual(normalized, parseStoredCodexGoalJobManifest(manifest)) ||
      digest(normalized) !== binding.manifestSha256 || observation.providerUnits.length < 1 ||
      observation.providerUnits.length > researchProviderReservationLimit) researchInvalid();
  const value = {
    identity: { jobId: manifest.jobId, taskId: manifest.taskId, startId: spec.startId,
      specSha256: researchHash(bytes), requestSha256: spec.requestSha256, grantSha256: spec.grantSha256,
      registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId,
      manifestRawSha256: researchHash(manifestBytes), manifestNormalizedSha256: digest(normalized), registeredHandoffSha256: digest(binding) },
    origin: { runtimeDirectory: spec.runtimeDirectory, artifactSha256: spec.artifactSha256 },
    terminalSlotSha256: observation.terminalSlotSha256, closingSha256: observation.closingSha256,
    inputs: canonicalRows(observation.inputs), starts: observation.starts,
    providerUnits: observation.providerUnits, providerFiles: observation.providerFiles, published: canonicalRows(observation.published),
  };
  // Apply the identical strict contract/bounds to the producer's rederived rows.
  parse(Buffer.from(JSON.stringify({ schemaVersion: 1, kind: NativeWriterClosureKind.RegisteredCodingTerminalV1,
    issuer: { contract: NativeWriterClosureIssuerContract.CurrentRootObservationV1,
      runtimeDirectory: installedResearchRuntimeDirectory(), artifactSha256: "0".repeat(64) }, ...value })));
  return value;
}
function sameFacts(receipt: NativeWriterClosureReceiptV1, current: ReturnType<typeof facts>): boolean {
  const { schemaVersion: _schema, kind: _kind, issuer: _issuer, ...retained } = receipt;
  return isDeepStrictEqual(retained, current);
}
export function prepareNativeWriterClosureObservation(manifest: CodexGoalJobManifest) {
  const observation = prepareRegisteredCodingTerminalObservation(manifest), expected = facts(manifest, observation);
  const assertCurrent = (): void => {
    observation.assertCurrent();
    if (!isDeepStrictEqual(facts(manifest, observation), expected)) researchInvalid();
    observation.assertCurrent();
  };
  assertCurrent();
  return { observation, expected, assertCurrent, path: join(observation.current.directory, leaf) };
}
/** A supported seal selects current fixed code before any foreign provenance
 * qualification. Every read still derives physical, byte, roster and pin facts. */
export function prepareNativeWriterClosureRead(manifest: CodexGoalJobManifest): WriterReader | undefined {
  try {
    assertResearchInitialRoot(true);
    // Probe only a validated terminal slot, without invoking lifecycle/old code.
    const root = researchJobAuthority(manifest.jobId);
    const slot = researchRecord(researchJson(researchRead(join(root, "last-terminal.json"))), "schemaVersion,startId,specSha256");
    if (slot.schemaVersion !== 1 || typeof slot.startId !== "string" || !/^[a-f0-9-]{36}$/.test(slot.startId)) return;
    const path = join(root, "starts", slot.startId, leaf), bytes = optional(path);
    if (!bytes) return;
    const receipt = parse(bytes), prepared = prepareNativeWriterClosureObservation(manifest);
    if (prepared.path !== path || !sameFacts(receipt, prepared.expected)) return;
    const read = (): void => {
      assertResearchInitialRoot(true); prepared.assertCurrent();
      if (!researchRead(path).equals(bytes) || !sameFacts(parse(researchRead(path)), prepared.expected)) researchInvalid();
      prepared.assertCurrent();
    };
    read();
    return async () => { try { read(); return { status: "released" }; } catch { return { status: "unknown" }; } };
  } catch { return; }
}

/** Pure strict comparison; caller-supplied bytes cannot publish authority. */
export function nativeWriterClosureReceiptMatches(bytes: Buffer, expected: ReturnType<typeof prepareNativeWriterClosureObservation>["expected"]): boolean {
  return sameFacts(parse(bytes), expected);
}
