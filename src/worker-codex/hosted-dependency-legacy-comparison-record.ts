import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { lstatSync } from "node:fs";
import { DependencyInstallProofKind, DependencyReceiptState, sameDependencyTree, sameDependencyWorkspace } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyReceiptParseStatus, parseDependencyReceipt } from "../worker-core/dependency-environment/domain/parse-dependency-receipt";
import { parseDependencyLegacyComparisonRecord, type DependencyLegacyComparisonRecord } from "../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import type { DependencyLegacyComparisonVerifier, DependencyLegacyComparedReady } from "../worker-core/dependency-environment/ports/dependency-legacy-comparison";
import type { DependencyCommittedReceiptReference } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
import { DependencyOwnerKind, DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyOwner, sameDependencyAttempt } from "../worker-core/dependency-environment/domain/dependency-owner";
import { readDependencyProtectedReference } from "../worker-local/dependency-environment/dependency-source-binding";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { assertHostedDependencyLegacyReferenceHistory } from "./hosted-dependency-legacy-reference-history";

const operations = "/var/lib/subscription-runtime-host-policy/dependency-transactions";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
const hash = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
function fail(): never { throw new Error("dependency_legacy_comparison_unresolved"); }
function decode(bytes: Buffer): unknown {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!encode(value).equals(bytes)) fail();
  return value;
}
function fields(value: unknown, expected: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== expected) fail();
}
function custody(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o7777n) !== 0o700n) fail();
  return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) };
}
function read(reference: DependencyCommittedReceiptReference, root: string, fixedPath: string): Buffer {
  if (reference.path !== fixedPath) fail();
  const hosted = readHostedPrivateBytes(fixedPath, 65536);
  const bytes = readDependencyProtectedReference(reference, custody(root), 0n);
  if (!hosted || !hosted.equals(bytes)) fail();
  return bytes;
}
function receipt(reference: DependencyCommittedReceiptReference, workspace: { dev: string; ino: string }, revision?: number) {
  // The producer seals a store-captured committed reference. Do not duplicate
  // the store's filename codec or reopen a public same-store read under CAS.
  if (dirname(reference.path) !== hostedDependencyReceiptHistoryRoot) fail();
  const result = parseDependencyReceipt(decode(read(reference, hostedDependencyReceiptHistoryRoot, reference.path)));
  if (result.status !== DependencyReceiptParseStatus.Valid || !sameDependencyTree(result.receipt.workspace, workspace) ||
      (revision !== undefined && result.receipt.revision !== revision)) fail();
  return result.receipt;
}

/** Fixed protected leaf, not an issuer. IDs select only one operation namespace.
 * Every read reauthenticates immutable old generation facts; current tree/key
 * checks belong to current entry/eviction and never enter historical proof. */
export function assertHostedDependencyLegacyComparedReady(ready: DependencyLegacyComparedReady): DependencyLegacyComparisonRecord {
  assertReadonlyHostOperator();
  const parsedReady = parseDependencyReceipt(ready);
  if (parsedReady.status !== DependencyReceiptParseStatus.Valid || parsedReady.receipt.state !== DependencyReceiptState.Ready) fail();
  if (ready.provenance.kind !== DependencyInstallProofKind.LegacyCompared || !uuid.test(ready.provenance.comparisonEvidenceId)) fail();
  const path = `${operations}/${ready.provenance.comparisonEvidenceId}.comparison.json`;
  const before = lstatSync(path, { bigint: true }), raw = readHostedPrivateBytes(path, 65536);
  if (!raw || !before.isFile() || before.nlink !== 1n) fail();
  const comparisonReference = { path, identity: { dev: String(before.dev), ino: String(before.ino) }, sha256: hash(raw) };
  const bytes = read(comparisonReference, operations, path), record = parseDependencyLegacyComparisonRecord(decode(bytes));
  if (record.operationId !== ready.provenance.comparisonEvidenceId || record.comparisonEvidenceId !== record.operationId ||
      record.referenceInstallationId !== ready.provenance.referenceInstallationId || ready.revision !== record.original.receipt.revision + 1 ||
      ready.generation !== record.original.receipt.generation || ready.coverageRevision !== record.original.receipt.coverageRevision ||
      !sameDependencyWorkspace(ready.workspace, record.original.receipt.workspace) || !sameDependencyTree(ready.tree, record.original.receipt.tree) ||
      ready.installKey !== record.installKey || ready.manifestDigest !== record.originalManifestDigest) fail();
  const original = receipt(record.original.reference, ready.workspace, record.original.receipt.revision);
  if (!encode(original).equals(encode(record.original.receipt))) fail();
  const output = receipt(record.reference.output, record.reference.workspace);
  if (output.state !== DependencyReceiptState.Ready || output.provenance.kind !== DependencyInstallProofKind.CompletedInstall ||
      output.generation !== record.reference.generation || output.coverageRevision !== record.reference.coverageRevision ||
      !sameDependencyWorkspace(output.workspace, record.reference.workspace) || !sameDependencyTree(output.tree, record.reference.tree) ||
      output.installKey !== record.installKey || output.manifestDigest !== record.referenceManifestDigest ||
      output.provenance.operationId !== record.reference.generation || output.provenance.verificationEvidenceId !== output.manifestDigest ||
      output.provenance.installerDrainEvidenceId !== record.reference.completion.sha256) fail();
  const refs = record.reference;
  const mappingBytes = read(refs.mapping, hostedDependencyInstallerRoot, `${hostedDependencyInstallerRoot}/attempt-${refs.generation}.json`);
  const mapping = decode(mappingBytes); fields(mapping, "attempt,schemaVersion,startId,unit");
  if (mapping.schemaVersion !== 1 || typeof mapping.startId !== "string" || !uuid.test(mapping.startId) ||
      mapping.startId !== record.referenceInstallationId || mapping.unit !== `subscription-runtime-installer-${mapping.startId}.service`) fail();
  const owner = parseDependencyOwner({ version: 2, workspace: refs.workspace, revision: 1,
    epoch: mapping.attempt && typeof mapping.attempt === "object" && "epoch" in mapping.attempt ? mapping.attempt.epoch : undefined,
    owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.Fenced, attempt: mapping.attempt } });
  if (!isDependencyConsumerOwner(owner.owner) || owner.owner.attempt.attemptId !== refs.generation) fail();
  const directory = `${hostedDependencyInstallerRoot}/${mapping.startId}`;
  const startBytes = read(refs.start, hostedDependencyInstallerRoot, `${directory}/start.json`);
  const creatorBytes = read(refs.creator, hostedDependencyInstallerRoot, `${directory}/creator.json`);
  const completionBytes = read(refs.completion, hostedDependencyInstallerRoot, `${directory}/creator-completion.json`);
  const terminalBytes = read(refs.terminal, hostedDependencyInstallerRoot, `${directory}/terminal.json`);
  const start = decode(startBytes); fields(start, "attempt,inputSha256,profileSha256,recipe,schemaVersion,startId,unit,workspace");
  if (start.schemaVersion !== 1 || start.recipe !== HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1 ||
      start.startId !== mapping.startId || start.unit !== mapping.unit || !encode(start.workspace).equals(encode(refs.workspace)) ||
      !sameDependencyAttempt(start.attempt as typeof owner.owner.attempt, owner.owner.attempt) ||
      start.inputSha256 !== record.inputSha256 || start.profileSha256 !== record.profileSha256) fail();
  const creator = decode(creatorBytes); fields(creator, "controlGroup,pidBirth,schemaVersion,startId,startSha256");
  if (creator.schemaVersion !== 1 || creator.startId !== mapping.startId || creator.startSha256 !== refs.start.sha256 ||
      typeof creator.pidBirth !== "string" || !creator.pidBirth ||
      creator.controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${owner.owner.attempt.launch.unit}` ||
      !completionBytes.equals(encode({ schemaVersion: 1, startId: mapping.startId, startSha256: refs.start.sha256,
        creatorSha256: refs.creator.sha256, status: 0, creatorWaitReturned: true }))) fail();
  // Terminal is historical generated evidence. Authenticate retained future-
  // enqueue consumption/revocation without re-running present-day OS drain.
  const consumedPath = `${directory}/consumed.json`, revokedPath = `${directory}/revoked.json`;
  const consumed = readHostedPrivateBytes(consumedPath, 4096), revoked = readHostedPrivateBytes(revokedPath, 4096);
  if (!consumed?.equals(encode({ schemaVersion: 1, startId: mapping.startId, startSha256: refs.start.sha256 })) ||
      !revoked?.equals(encode({ schemaVersion: 1, startId: mapping.startId, completionSha256: refs.completion.sha256 }))) fail();
  const terminal = decode(terminalBytes); fields(terminal, "completionSha256,emptySha256,output,schemaVersion,startId");
  if (terminal.schemaVersion !== 1 || terminal.startId !== mapping.startId || terminal.completionSha256 !== refs.completion.sha256 ||
      typeof terminal.emptySha256 !== "string" || !/^[a-f0-9]{64}$/.test(terminal.emptySha256) || !encode(terminal.output).equals(encode(refs.tree))) fail();
  for (const [reference, suffix] of [[record.relation, "reference"], [record.referenceStart, "reference-start"],
    [record.referenceEntry, "reference-entry"], [record.referenceResult, "reference-result"], [record.referenceRelease, "reference-release"]] as const) {
    read(reference, operations, `${operations}/${record.operationId}.${suffix}.json`);
  }
  // Concrete reference leaf authenticates its fixed schema plus immutable
  // ordinary start/wait/fence/drain/release chain, without current inputs.
  assertHostedDependencyLegacyReferenceHistory(record);
  for (const reference of [refs.mapping, refs.start, refs.creator, refs.completion, refs.terminal]) read(reference, hostedDependencyInstallerRoot, reference.path);
  for (const reference of [record.relation, record.referenceStart, record.referenceEntry, record.referenceResult, record.referenceRelease]) read(reference, operations, reference.path);
  receipt(record.original.reference, ready.workspace, record.original.receipt.revision);
  receipt(refs.output, refs.workspace);
  if (!readHostedPrivateBytes(consumedPath, 4096)?.equals(consumed) || !readHostedPrivateBytes(revokedPath, 4096)?.equals(revoked)) fail();
  read(comparisonReference, operations, path);
  return record;
}

/** Store invokes this under its own CAS mutex using independently captured
 * actual previous facts. No same-store public read or caller old reference. */
export const assertHostedDependencyLegacyComparisonTransition: DependencyLegacyComparisonVerifier["assertLegacyComparison"] = input => {
  const record = assertHostedDependencyLegacyComparedReady(input.proposedReady);
  if (!encode(record.original.receipt).equals(encode(input.previousUnverified)) ||
      !encode(record.original.reference).equals(encode(input.previousReference))) fail();
};
