import { parseHostedOrdinaryStart, sameDependencyAttempt, sameDependencyWorkspace } from "@vioxen/subscription-runtime/worker-core";
import { parseDependencyLegacyComparisonRecord, type DependencyLegacyComparisonRecord } from "../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import { ordinaryCompletionBytes, ordinaryCompletionPath } from "./hosted-readonly-host-kernel";
import { encodeReference as encode, referencePath, referenceFailure as fail, readFixedReference, pinReferenceFile,
  parseReferenceRelation, parseReferenceStart, parseReferenceEntry, parseReferenceResult, parseReferenceRelease } from "./hosted-dependency-legacy-reference-records";

/** Factual immutable lifecycle read. This also authenticates the reference
 * operation after a complete unequal comparison; it creates no Ready proof. */
export function readHostedDependencyLegacyReferenceHistory(op: string) {
  const relationPin = pinReferenceFile(referencePath(op,"reference"));
  const relation = readFixedReference(relationPin.reference,referencePath(op,"reference"),parseReferenceRelation);
  const sealPin = pinReferenceFile(referencePath(op,"reference-start"));
  const seal = readFixedReference(sealPin.reference,referencePath(op,"reference-start"),parseReferenceStart);
  const entryPin = pinReferenceFile(referencePath(op,"reference-entry"));
  const entry = readFixedReference(entryPin.reference,referencePath(op,"reference-entry"),v => parseReferenceEntry(v,relation.reference.binding.workspace));
  const resultPin = pinReferenceFile(referencePath(op,"reference-result"));
  const result = readFixedReference(resultPin.reference,referencePath(op,"reference-result"),parseReferenceResult);
  const releasePin = pinReferenceFile(referencePath(op,"reference-release"));
  const release = readFixedReference(releasePin.reference,referencePath(op,"reference-release"),v => parseReferenceRelease(v,relation.reference.binding.workspace));
  if (relation.version!==result.version || result.version===2 && (relation.version!==2 || relation.recipe!==result.recipe || relation.profile!==result.profile || relation.inputs.closureDigest!==result.closureDigest) ||
      ![relation.operationId,seal.operationId,entry.operationId,result.operationId,release.operationId].every(id => id === op) ||
      !sameDependencyWorkspace(relation.reference.binding.workspace,result.reference.workspace) ||
      !encode(seal.relation).equals(encode(relationPin.reference)) || !encode(entry.relation).equals(encode(relationPin.reference)) ||
      !encode(entry.referenceStart).equals(encode(sealPin.reference)) ||
      !encode(result.relation).equals(encode(relationPin.reference)) || !encode(result.referenceStart).equals(encode(sealPin.reference)) ||
      !encode(result.referenceEntry).equals(encode(entryPin.reference)) ||
      !encode(release.referenceResult).equals(encode(resultPin.reference)) || !sameDependencyAttempt(entry.attempt,release.attempt) ||
      entry.attempt.attemptId !== result.reference.generation || release.startId !== seal.startId ||
      relation.inputs.installKey !== result.installKey || relation.inputs.inputSha256 !== result.inputSha256 ||
      relation.inputs.profileSha256 !== result.profileSha256) fail();
  const ordinaryPath = `/var/lib/subscription-runtime-host-policy/ordinary-starts/${seal.startId}.json`;
  const ordinary = readFixedReference(seal.start,ordinaryPath,parseHostedOrdinaryStart);
  const binding = relation.reference.binding, launch = entry.attempt.launch, row = seal.reservation;
  if (!encode(release.ordinaryStart).equals(encode(seal.start)) || row.startId !== seal.startId || row.unit !== ordinary.unit ||
      row.creatorId !== ordinary.creatorId || row.originSha256 !== ordinary.originSha256 || row.generation !== ordinary.activationGeneration ||
      ordinary.jobId !== binding.jobId || ordinary.jobRootDir !== binding.jobRootDir || ordinary.workspacePath !== binding.workspace.canonicalPath ||
      ordinary.installationId !== binding.installationId || ordinary.grantSha256 !== binding.grantDigest ||
      launch.startId !== seal.startId || launch.unit !== ordinary.unit || launch.bootId !== ordinary.bootId ||
      launch.installationId !== binding.installationId || launch.runtimeSha !== binding.runtimeSha || launch.grantDigest !== binding.grantDigest ||
      relation.candidate.maintenance.host.bootId !== ordinary.bootId || relation.candidate.maintenance.host.supervisorId !== ordinary.supervisorId ||
      relation.reference.staging.host.bootId !== ordinary.bootId || relation.reference.staging.host.supervisorId !== ordinary.supervisorId) fail();
  const completion = pinReferenceFile(ordinaryCompletionPath(seal.startId),4096);
  if (!encode(completion.reference).equals(encode(release.ordinaryCompletion)) ||
      !completion.bytes.equals(ordinaryCompletionBytes(seal.startId,seal.start.sha256))) fail();
  const fenced = pinReferenceFile(`/var/lib/subscription-runtime-host-policy/dependency-attempt-fences/${seal.startId}.json`,4096);
  if (!encode(fenced.reference).equals(encode(release.attemptFence)) || !fenced.bytes.equals(encode({version:1,startId:seal.startId,
      attemptId:entry.attempt.attemptId,epoch:entry.attempt.epoch}))) fail();
  return {relation,result,refs:{relation:relationPin.reference,referenceStart:sealPin.reference,referenceEntry:entryPin.reference,
    referenceResult:resultPin.reference,referenceRelease:releasePin.reference}};
}

/** Historical authentication is bound to the original immutable generation.
 * No current source, stage, owner, node_modules or key is required here. The
 * current issuer/evictor separately retains and rechecks those live facts. */
export function assertHostedDependencyLegacyReferenceHistory(input: DependencyLegacyComparisonRecord): void {
  const record = parseDependencyLegacyComparisonRecord(input), history = readHostedDependencyLegacyReferenceHistory(record.operationId);
  if (record.version!==history.result.version || record.version===2 && (history.result.version!==2 || record.closureDigest!==history.result.closureDigest || record.recipe!==history.result.recipe || record.profile!==history.result.profile) ||
      record.comparisonEvidenceId !== record.operationId ||
      !encode(history.relation.candidate.original).equals(encode(record.original)) ||
      !encode(history.result.reference).equals(encode(record.reference)) ||
      history.result.reference.installationId !== record.referenceInstallationId ||
      history.result.installKey !== record.installKey || history.result.inputSha256 !== record.inputSha256 ||
      history.result.profileSha256 !== record.profileSha256 ||
      !encode(history.refs).equals(encode({relation:record.relation,referenceStart:record.referenceStart,referenceEntry:record.referenceEntry,
        referenceResult:record.referenceResult,referenceRelease:record.referenceRelease}))) fail();
}
