import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyOwner, sameDependencyAttempt } from "../worker-core/dependency-environment/domain/dependency-owner";
import { assertDependencyLocalOutputEvidence, assertDependencySourceBindingRecord } from "../worker-core/dependency-environment/domain/dependency-source-binding-record";
import type { DependencySourceBindingRecord } from "../worker-core/dependency-environment/ports/dependency-source-binding";
import { assertDependencyLocalOutputBinding, readDependencyProtectedReference } from "../worker-local/dependency-environment/dependency-source-binding";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";

const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(): never { throw new Error("dependency_local_output_proof_invalid"); }
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== names) fail();
}
function decode(bytes: Buffer): unknown {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!encode(value).equals(bytes)) fail(); return value;
}

/** Protected reader only: no issuer, writes, callback attestation or composition
 * activation. The hosted unavailable verifier remains until the closed producer
 * invokes genuine observation under writer exclusion and native TEST qualifies
 * the entire local installer/publication lifetime. V1 never falls back here. */
export function assertHostedDependencyLocalOutputProof(record: DependencySourceBindingRecord): void {
  assertDependencySourceBindingRecord(record);
  assertReadonlyHostOperator();
  if (record.version !== 2) fail();
  const root = hostedDependencyInstallerRoot, rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.uid !== 0n || (rootStat.mode & 0o7777n) !== 0o700n) fail();
  const custody = { canonicalPath: root, dev: String(rootStat.dev), ino: String(rootStat.ino) };
  const mappingPath = `${root}/attempt-${record.generation}.json`, mappingBytes = readHostedPrivateBytes(mappingPath, 4096);
  if (!mappingBytes) fail();
  const mapping = decode(mappingBytes); fields(mapping, "attempt,schemaVersion,startId,unit");
  if (mapping.schemaVersion !== 1 || typeof mapping.startId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(mapping.startId) || mapping.unit !== `subscription-runtime-installer-${mapping.startId}.service`) fail();
  const parsed = parseDependencyOwner({ version: 2, workspace: record.workspace, revision: 1,
    epoch: mapping.attempt && typeof mapping.attempt === "object" && "epoch" in mapping.attempt ? mapping.attempt.epoch : undefined,
    owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.Fenced, attempt: mapping.attempt } });
  if (!isDependencyConsumerOwner(parsed.owner) || parsed.owner.attempt.attemptId !== record.generation) fail();
  const directory = `${root}/${mapping.startId}`;
  if (record.outputReference.path !== `${directory}/verified-local-output.json`) fail();
  // Host helper proves root ownership/non-writable ancestry; retained helper
  // additionally binds full inode reference, mount, private mode and byte read.
  const hostedProofBytes = readHostedPrivateBytes(record.outputReference.path, 65536);
  const proofBytes = readDependencyProtectedReference(record.outputReference, custody, 0n);
  if (!hostedProofBytes || !hostedProofBytes.equals(proofBytes)) fail();
  const proof = decode(proofBytes); assertDependencyLocalOutputEvidence(proof);
  assertDependencyLocalOutputBinding(record, proof);
  for (const [reference, name] of [[proof.start, "start.json"], [proof.creator, "creator.json"],
    [proof.completion, "creator-completion.json"], [proof.terminal, "terminal.json"]] as const) {
    if (reference.path !== `${directory}/${name}`) fail();
  }
  const startBytes = readDependencyProtectedReference(proof.start, custody, 0n), creatorBytes = readDependencyProtectedReference(proof.creator, custody, 0n),
    completionBytes = readDependencyProtectedReference(proof.completion, custody, 0n), terminalBytes = readDependencyProtectedReference(proof.terminal, custody, 0n);
  const start = decode(startBytes); fields(start, "attempt,closureDigest,inputSha256,installKey,profileSha256,recipe,schemaVersion,startId,unit,workspace");
  const startOwner = parseDependencyOwner({ version: 2, workspace: record.workspace, revision: 1,
    epoch: start.attempt && typeof start.attempt === "object" && "epoch" in start.attempt ? start.attempt.epoch : undefined,
    owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.Fenced, attempt: start.attempt } });
  fields(start.workspace, "canonicalPath,dev,ino");
  if (start.schemaVersion !== 2 || start.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1 ||
      start.startId !== mapping.startId || start.unit !== mapping.unit || !isDependencyConsumerOwner(startOwner.owner) || !sameDependencyAttempt(startOwner.owner.attempt, parsed.owner.attempt) ||
      start.workspace.canonicalPath !== record.workspace.canonicalPath || start.workspace.dev !== record.workspace.dev || start.workspace.ino !== record.workspace.ino || start.installKey !== proof.installKey ||
      start.closureDigest !== proof.closureDigest || start.inputSha256 !== proof.inputSha256 || start.profileSha256 !== proof.profileSha256 ||
      !completionBytes.equals(encode({ schemaVersion: 1, startId: mapping.startId, startSha256: sha(startBytes), creatorSha256: sha(creatorBytes), status: 0, creatorWaitReturned: true }))) fail();
  const terminal = decode(terminalBytes); fields(terminal, "completionSha256,emptySha256,output,schemaVersion,startId");
  fields(terminal.output, "dev,ino");
  if (terminal.schemaVersion !== 1 || terminal.startId !== mapping.startId || terminal.completionSha256 !== proof.completion.sha256 ||
      !digest(terminal.emptySha256) || terminal.output.dev !== proof.tree.dev || terminal.output.ino !== proof.tree.ino) fail();
  assertHostedDependencyInstallerAttemptDrained(parsed.owner.attempt);
  for (const reference of [record.outputReference, proof.start, proof.creator, proof.completion, proof.terminal]) readDependencyProtectedReference(reference, custody, 0n);
  if (!readHostedPrivateBytes(mappingPath, 4096)?.equals(mappingBytes)) fail();
  // No stage/current node_modules or current source-code read: old generations
  // authenticate their own immutable output chain after detach/cold restore.
}
