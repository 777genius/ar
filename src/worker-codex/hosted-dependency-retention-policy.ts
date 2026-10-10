import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { hostedDependencyObservationLimits } from "./hosted-dependency-materialization-context";
import { HostedManifestLimitsRevision } from "./hosted-dependency-manifest-placement";
import { assertHostedDependencyToolProfileFiles } from "../provider-codex/app-server/adapters/hosted-dependency-tool-files";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes,
  readHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";

export enum HostedRetentionPolicyStatus { Missing = "missing", Legacy = "legacy", ReferenceObserved = "reference_observed", Unknown = "unknown" }
export enum HostedRetentionPolicyReason {
  Missing = "policy_missing", Legacy = "legacy_policy", Invalid = "invalid_policy",
  UnsupportedProfile = "unsupported_profile", NativeProducerUnavailable = "native_producer_unavailable",
}
export enum HostedRetentionNativeScope { OrdinaryTestNpmV2 = "ordinary_test_npm_v2" }
export enum HostedRetentionNativeEvidenceKind { WholeLifeG1Accepted = "whole_life_g1_accepted" }
type Qualification = Readonly<{ installationId: string; runtimeSha: string; runtimeManifestSha256: string;
  inventorySha256: string; bootId: string; finiteProfileSha256: string;
  evidenceSha256: string; evidenceDev: string; evidenceIno: string }>;
export type HostedDependencyRetentionPolicy = Readonly<{ managedReadyRequired: true; evictionEnabled: boolean }> & (
  | Readonly<{ version: 1 }>
  | Readonly<{ version: 2; qualification: Qualification }>
);
export type HostedRetentionNativeEvidence = Readonly<Pick<Qualification,
  "installationId" | "runtimeSha" | "runtimeManifestSha256" | "inventorySha256" | "bootId" | "finiteProfileSha256"> & {
  version: 1; scope: HostedRetentionNativeScope.OrdinaryTestNpmV2;
  evidenceKind: HostedRetentionNativeEvidenceKind.WholeLifeG1Accepted; proofSha256: string;
}>;
export type HostedRetentionPolicyObservation = Readonly<{
  status: HostedRetentionPolicyStatus; reason: HostedRetentionPolicyReason; revision: string | null;
}>;
const root = "/var/lib/subscription-runtime-host-policy", policyPath = root + "/dependency-retention-policy.json";
const qualificationKeys = "installationId,runtimeSha,runtimeManifestSha256,inventorySha256,bootId,finiteProfileSha256,evidenceSha256,evidenceDev,evidenceIno";
const evidenceKeys = "version,scope,installationId,runtimeSha,runtimeManifestSha256,inventorySha256,bootId,finiteProfileSha256,evidenceKind,proofSha256";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function invalid(): never { throw new Error("dependency_retention_policy_invalid"); }
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",") ||
      Reflect.ownKeys(value).length !== keys.split(",").length) invalid();
  return value as Record<string, unknown>;
}
function hash(value: unknown, length = 64): asserts value is string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) invalid();
}
function joins(value: Record<string, unknown>): void {
  if (typeof value.installationId !== "string" || !uuid.test(value.installationId) ||
      typeof value.bootId !== "string" || !uuid.test(value.bootId)) invalid();
  hash(value.runtimeSha, 40);
  for (const name of ["runtimeManifestSha256", "inventorySha256", "finiteProfileSha256"]) hash(value[name]);
}
/** Structural configuration only. No parsed record qualifies a host or permits eviction. */
export function parseHostedDependencyRetentionPolicy(value: unknown): HostedDependencyRetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const version = "version" in value ? value.version : undefined;
  const v = record(value, version === 2 ? "version,managedReadyRequired,evictionEnabled,qualification" : "version,managedReadyRequired,evictionEnabled");
  if ((version !== 1 && version !== 2) || v.managedReadyRequired !== true || typeof v.evictionEnabled !== "boolean") invalid();
  if (version === 1) return Object.freeze({ version, managedReadyRequired: true, evictionEnabled: v.evictionEnabled });
  const q = record(v.qualification, qualificationKeys); joins(q); hash(q.evidenceSha256);
  if (typeof q.evidenceDev !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(q.evidenceDev) ||
      typeof q.evidenceIno !== "string" || !/^[1-9][0-9]{0,19}$/.test(q.evidenceIno)) invalid();
  return Object.freeze({ version, managedReadyRequired: true, evictionEnabled: v.evictionEnabled,
    qualification: Object.freeze({ ...q }) as Qualification });
}
/** Exact immutable rollup shape; only a genuine native issuer can publish accepted evidence. */
export function parseHostedRetentionNativeEvidence(value: unknown): HostedRetentionNativeEvidence {
  const v = record(value, evidenceKeys); joins(v); hash(v.proofSha256);
  if (v.version !== 1 || v.scope !== HostedRetentionNativeScope.OrdinaryTestNpmV2 ||
      v.evidenceKind !== HostedRetentionNativeEvidenceKind.WholeLifeG1Accepted) invalid();
  return Object.freeze({ ...v }) as HostedRetentionNativeEvidence;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k =>
    JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  const encoded = JSON.stringify(value); if (encoded === undefined) invalid(); return encoded;
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function pin(path: string) {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.uid !== 0n || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o600n || s.size > 4096n) invalid();
  return { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), size: String(s.size),
    ctime: String(s.ctimeNs), mtime: String(s.mtimeNs) };
}

/** Fixed-root read only. A valid reference is diagnostic until the genuine
 * native producer + effect gateway are implemented and qualified separately.
 * No caller path, qualification boolean, authorization callback or store writer. */
export function readHostedDependencyRetentionPolicy(fence: HostedActivationFence, jobId: string): HostedRetentionPolicyObservation {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  let revision: string | null = null;
  try {
    if (readHostedPrivateBytes(policyPath + ".next", 4096)) invalid();
    const bytes = readHostedPrivateBytes(policyPath, 4096);
    if (!bytes) return Object.freeze({ status: HostedRetentionPolicyStatus.Missing, reason: HostedRetentionPolicyReason.Missing, revision });
    const policyPin = pin(policyPath), parsed = parseHostedDependencyRetentionPolicy(decodeHostedActivationBytes(bytes));
    if (!readHostedPrivateBytes(policyPath, 4096)?.equals(bytes) || digest(pin(policyPath)) !== digest(policyPin)) invalid();
    revision = digest([policyPin, createHash("sha256").update(bytes).digest("hex")]);
    if (parsed.version === 1) return Object.freeze({ status: HostedRetentionPolicyStatus.Legacy, reason: HostedRetentionPolicyReason.Legacy, revision });
    const a = new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence, jobId);
    const inventoryBytes = readHostedActivationBytes("readonly-inventory.json");
    if (!inventoryBytes || a.binding.version !== 2) invalid();
    const inventory = decodeHostedActivationBytes(inventoryBytes) as Record<string, unknown>;
    const fd = readHostedFdProfile();
    if (inventory.schemaVersion !== 4 || !fd || fd.schemaVersion !== 1) invalid();
    assertHostedDependencyToolProfileFiles(a.binding.toolProfile, a.binding.jobRootDir);
    const { cache: _cache, ...tools } = a.binding.toolProfile;
    const finiteProfileSha256 = digest({ version: 1, scope: HostedRetentionNativeScope.OrdinaryTestNpmV2,
      fd, installer: readHostedDependencyInstallerProfile(), tools, observationLimits: hostedDependencyObservationLimits,
      manifestLimitsRevision: HostedManifestLimitsRevision.TestUnqualifiedV1 });
    const expected = { installationId: a.installation.installationId, runtimeSha: a.installation.runtimeSha,
      runtimeManifestSha256: a.installation.runtimeManifestSha256, inventorySha256: a.installation.inventorySha256,
      bootId: a.session.bootId, finiteProfileSha256 };
    for (const [key, value] of Object.entries(expected)) if (parsed.qualification[key as keyof Qualification] !== value) invalid();
    const path = `${root}/dependency-native-qualification.${a.installation.installationId}.json`, before = pin(path);
    if (before.dev !== parsed.qualification.evidenceDev || before.ino !== parsed.qualification.evidenceIno) invalid();
    const evidenceBytes = readHostedPrivateBytes(path, 4096);
    if (!evidenceBytes || createHash("sha256").update(evidenceBytes).digest("hex") !== parsed.qualification.evidenceSha256) invalid();
    const evidence = parseHostedRetentionNativeEvidence(decodeHostedActivationBytes(evidenceBytes));
    for (const [key, value] of Object.entries(expected)) if (evidence[key as keyof typeof expected] !== value) invalid();
    if (digest(pin(path)) !== digest(before) || !readHostedPrivateBytes(path, 4096)?.equals(evidenceBytes) ||
        digest(pin(policyPath)) !== digest(policyPin) || !readHostedPrivateBytes(policyPath, 4096)?.equals(bytes)) invalid();
    return Object.freeze({ status: HostedRetentionPolicyStatus.ReferenceObserved,
      reason: HostedRetentionPolicyReason.NativeProducerUnavailable, revision: digest([revision, expected, before, parsed.qualification.evidenceSha256]) });
  } catch {
    return Object.freeze({ status: HostedRetentionPolicyStatus.Unknown, reason: HostedRetentionPolicyReason.Invalid, revision });
  }
}
