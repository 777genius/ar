import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DependencyInstallProfile } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyInstallProofKind, DependencyReceiptState, DependencyUnverifiedReason } from "../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyLegacyComparisonRecipe, type DependencyLegacyComparisonRecord } from "../../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import type { DependencyLegacyComparedReady } from "../../worker-core/dependency-environment/ports/dependency-legacy-comparison";
import { assertHostedDependencyLegacyComparedReady } from "../hosted-dependency-legacy-comparison-record";

const operations = "/var/lib/subscription-runtime-host-policy/dependency-transactions";
const digest = "4".repeat(64);
const workspace = { canonicalPath: "/srv/TEST-n5-original", dev: "1", ino: "91" };
const tree = { dev: "1", ino: "92" };
// Failure-only fixed-leaf tests. No receipt/callback is treated as genuine
// installation. Positive historical chain and N3 entries require native TEST.
// Removing record authentication or predecessor/revision binding makes these red.
// Opt-in only on a freshly provisioned disposable TEST host. Never run this
// fixed-namespace fixture on an enrolled user installation.
describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0 || process.env.SUBSCRIPTION_RUNTIME_N5_DISPOSABLE_HOST_TEST !== "1")("fixed protected legacy comparison denial", () => {
  const created: string[] = [];
  afterEach(() => { for (const path of created.splice(0)) unlinkSync(path); });
  function fixture() {
    const operationId = randomUUID(), generation = randomUUID(), installationId = randomUUID();
    const reference = (name: string) => ({ path: `${operations}/${operationId}.${name}.json`, identity: { dev: "1", ino: "2" }, sha256: digest });
    const original = { version: 1 as const, state: DependencyReceiptState.Unverified as const, revision: 1,
      generation, workspace, coverageRevision: digest, tree, reason: DependencyUnverifiedReason.BaselineMissing };
    const refWorkspace = { canonicalPath: "/srv/TEST-n5-reference", dev: "1", ino: "93" };
    const record: DependencyLegacyComparisonRecord = { version: 1, operationId, comparisonEvidenceId: operationId,
      referenceInstallationId: installationId, profile: DependencyInstallProfile.TestNpmQualification,
      recipe: DependencyLegacyComparisonRecipe.NpmRegistryNoScriptsV1, original: { receipt: original, reference: reference("original") },
      reference: { workspace: refWorkspace, generation: randomUUID(), coverageRevision: digest, tree: { dev: "1", ino: "94" },
        manifestVersion: 1, manifestDigest: digest, installationId, output: reference("output"), mapping: reference("mapping"),
        start: reference("start"), creator: reference("creator"), completion: reference("completion"), terminal: reference("terminal") },
      installKey: digest, inputSha256: digest, profileSha256: digest, originalManifestDigest: digest, referenceManifestDigest: digest,
      relation: reference("reference"), referenceStart: reference("reference-start"), referenceEntry: reference("reference-entry"),
      referenceResult: reference("reference-result"), referenceRelease: reference("reference-release") };
    const binding = { generation, workspace, coverageRevision: digest, installKey: digest, tree, manifestDigest: digest };
    const ready: DependencyLegacyComparedReady = { version: 1, state: DependencyReceiptState.Ready, revision: 2, ...binding,
      provenance: { ...binding, kind: DependencyInstallProofKind.LegacyCompared, comparisonEvidenceId: operationId, referenceInstallationId: installationId } };
    return { record, ready, path: `${operations}/${operationId}.comparison.json` };
  }
  function publish(path: string, value: unknown): void {
    try { mkdirSync(operations, { recursive: true, mode: 0o700 }); } catch { /* Existing protected directory must validate below. */ }
    const stat = lstatSync(operations);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o700) throw new Error("TEST protected directory invalid");
    writeFileSync(path, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); created.push(path);
  }
  it("does not accept the enum label when its fixed comparison leaf is missing", () => {
    const { ready } = fixture();
    let failure: unknown;
    try { assertHostedDependencyLegacyComparedReady(ready); } catch (error) { failure = error; }
    expect((failure as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });
  it("rejects a protected canonical record with an extra attestation field", () => {
    const { record, ready, path } = fixture(); publish(path, { ...record, verified: true });
    expect(() => assertHostedDependencyLegacyComparedReady(ready)).toThrow("dependency_legacy_comparison:invalid_record");
  });
  it("rejects old r1 evidence for a later r3 predecessor even with unchanged generation and tree", () => {
    const { record, ready, path } = fixture(); publish(path, record);
    expect(() => assertHostedDependencyLegacyComparedReady({ ...ready, revision: 4 })).toThrow("dependency_legacy_comparison_unresolved");
  });
  it("rejects a substituted original tree before its inert referenced files can confer authority", () => {
    const { record, ready, path } = fixture(); publish(path, { ...record,
      original: { ...record.original, receipt: { ...record.original.receipt, tree: { dev: "1", ino: "999" } } } });
    expect(() => assertHostedDependencyLegacyComparedReady(ready)).toThrow("dependency_legacy_comparison_unresolved");
  });
});
