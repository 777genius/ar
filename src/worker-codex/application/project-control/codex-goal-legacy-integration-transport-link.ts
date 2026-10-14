import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  CheckRunStatus, IntegrationAttemptStatus, PushAttemptStatus,
  ReviewDecisionStatus, SecretScanStatus,
  reviewedOutputFileByteAllowance,
  type ConsumedOutputLedger, type IntegrationAttempt, type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import { durablePublishJsonFile } from "../../project-control-operation-file-store";
import { readCodexGoalConsumedOutputLedgers } from "./codex-goal-consumed-output-ledger-io";

const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;

export type LegacyIntegrationTransportLink = {
  readonly schemaVersion: 1;
  readonly disposition: "superseded_by_exact_published_attempt";
  readonly oldAttemptId: string;
  readonly oldAttemptSha256: string;
  readonly adoptedAttemptId: string;
  readonly adoptedAttemptSha256: string;
  readonly commitSha: string;
  /** Stable across ledger-root moves; the currently active ledger is revalidated on read. */
  readonly ledgerIdentitySha256: string;
};

export type LegacyIntegrationTransportLinkInput = {
  readonly controllerJobRootDir: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly oldAttemptId: string;
  readonly expectedOldAttemptSha256: string;
  readonly adoptedAttemptId: string;
  readonly expectedAdoptedAttemptSha256: string;
  readonly commitSha: string;
  readonly ledger: ConsumedOutputLedger;
};

/** Read-only validation followed by a single append-only publication. No attempt or ledger is written. */
export async function linkLegacyIntegrationTransport(
  input: LegacyIntegrationTransportLinkInput,
): Promise<{ readonly path: string; readonly receipt: LegacyIntegrationTransportLink }> {
  const validated = await validateLegacyIntegrationTransportLink(input);
  await assertSafePathFromRoot(input.controllerJobRootDir, dirname(validated.path), true);
  await durablePublishJsonFile({ path: validated.path, value: validated.receipt });
  const published = await readJsonFile(input.controllerJobRootDir, validated.path);
  if (JSON.stringify(published) !== JSON.stringify(validated.receipt)) {
    throw new Error("legacy_integration_transport_link_conflict");
  }
  return validated;
}

export async function validateLegacyIntegrationTransportLink(
  input: LegacyIntegrationTransportLinkInput,
): Promise<{ readonly path: string; readonly receipt: LegacyIntegrationTransportLink }> {
  if (!hex64.test(input.expectedOldAttemptSha256) ||
      !hex64.test(input.expectedAdoptedAttemptSha256) || !hex40.test(input.commitSha) ||
      input.oldAttemptId === input.adoptedAttemptId) {
    throw new Error("legacy_integration_transport_link_input_invalid");
  }
  const [old, adopted] = await Promise.all([
    readAttempt(input.controllerJobRootDir, input.oldAttemptId),
    readAttempt(input.controllerJobRootDir, input.adoptedAttemptId),
  ]);
  if (old.sha256 !== input.expectedOldAttemptSha256 ||
      adopted.sha256 !== input.expectedAdoptedAttemptSha256) {
    throw new Error("legacy_integration_transport_link_attempt_cas_mismatch");
  }
  const a = old.attempt;
  const b = adopted.attempt;
  if (a.attemptId !== input.oldAttemptId || b.attemptId !== input.adoptedAttemptId ||
      a.projectId !== input.projectId || b.projectId !== input.projectId ||
      a.controllerJobId !== input.controllerJobId ||
      b.controllerJobId !== input.controllerJobId ||
      a.status !== IntegrationAttemptStatus.ChecksPassed ||
      b.status !== IntegrationAttemptStatus.Pushed ||
      a.reviewDecision.decision !== ReviewDecisionStatus.Approved ||
      b.reviewDecision.decision !== ReviewDecisionStatus.Approved ||
      a.commitCandidate || a.pushAttempt || a.merge || b.merge ||
      !b.workerOutput.reviewedOutputId ||
      b.workerOutput.reviewedOutputFileByteAllowance === undefined ||
      !b.checkedReviewedTree || !hex40.test(b.checkedReviewedTree) ||
      b.checkRuns.length === 0 ||
      b.checkRuns.some((run) => run.status !== CheckRunStatus.Passed) ||
      !b.commitCandidate || b.commitCandidate.commitSha !== input.commitSha ||
      b.commitCandidate.secretScanStatus !== SecretScanStatus.Passed ||
      JSON.stringify(b.commitCandidate.files) !== JSON.stringify(b.expectedFiles) ||
      !b.pushAttempt || b.pushAttempt.commitSha !== input.commitSha ||
      b.pushAttempt.status !== PushAttemptStatus.Pushed ||
      b.pushAttempt.remote !== b.targetRemote ||
      b.pushAttempt.branch !== b.targetBranch ||
      !b.externalPublicationAttestation ||
      b.externalPublicationAttestation.commitSha !== input.commitSha ||
      b.externalPublicationAttestation.remote !== b.targetRemote ||
      b.externalPublicationAttestation.branch !== b.targetBranch ||
      b.externalPublicationAttestation.verifiedAt !== b.pushAttempt.pushedAt ||
      !sameTransport(a, b)) {
    throw new Error("legacy_integration_transport_link_evidence_mismatch");
  }
  reviewedOutputFileByteAllowance(b.workerOutput.reviewedOutputFileByteAllowance);
  const record = input.ledger.byJobId.get(b.workerJobId);
  if (!record || !record.valid || !record.hasAuthoredOutput ||
      record.status !== "integrated" ||
      record.attemptId !== b.attemptId || record.commitSha !== input.commitSha ||
      !record.workspace ||
      resolve(record.workspace) !== resolve(b.workerOutput.workspacePath) ||
      input.ledger.debt.some((item) => item.subject === record.ledgerPath)) {
    throw new Error("legacy_integration_transport_link_ledger_unconsumed");
  }
  const receipt: LegacyIntegrationTransportLink = {
    schemaVersion: 1,
    disposition: "superseded_by_exact_published_attempt",
    oldAttemptId: a.attemptId,
    oldAttemptSha256: old.sha256,
    adoptedAttemptId: b.attemptId,
    adoptedAttemptSha256: adopted.sha256,
    commitSha: input.commitSha,
    ledgerIdentitySha256: hash(JSON.stringify({
      jobId: record.jobId,
      attemptId: record.attemptId,
      status: record.status,
      commitSha: record.commitSha,
      workspace: resolve(record.workspace),
    })),
  };
  return {
    path: join(input.controllerJobRootDir, "project-integration", "legacy-transport-links",
      `${hash(input.oldAttemptId)}.json`),
    receipt,
  };
}

export async function readLegacyIntegrationTransportLink(
  controllerJobRootDir: string,
  oldAttemptId: string,
): Promise<LegacyIntegrationTransportLink | undefined> {
  try {
    return await readJsonFile(controllerJobRootDir,
      join(controllerJobRootDir, "project-integration", "legacy-transport-links",
        `${hash(oldAttemptId)}.json`)) as LegacyIntegrationTransportLink;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function hasLegacyIntegrationTransportLinks(
  controllerJobRootDir: string,
): Promise<boolean> {
  try {
    const path = join(controllerJobRootDir, "project-integration",
      "legacy-transport-links");
    await assertSafePathFromRoot(controllerJobRootDir, path, true);
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export async function verifiedLegacyTransportLinksForScope(input: {
  readonly controllerJobRootDir: string;
  readonly controllerJobId: string;
  readonly scope: ProjectAccessScope;
}): Promise<ReadonlySet<string>> {
  const { controllerJobRootDir, controllerJobId, scope } = input;
  if (!await hasLegacyIntegrationTransportLinks(controllerJobRootDir) ||
      scope.consumedOutputLedgerRoots?.length !== 1 ||
      !scope.consumedOutputEvidenceRoots?.length) {
    return new Set();
  }
  return verifiedLegacyTransportLinkAttemptIds({
    controllerJobRootDir,
    controllerJobId,
    projectId: scope.projectId,
    ledger: await readCodexGoalConsumedOutputLedgers({
      roots: scope.consumedOutputLedgerRoots,
      evidenceRoots: scope.consumedOutputEvidenceRoots,
    }),
  });
}

/** Used only under the controller maintenance fence by epoch quiescence. */
export async function verifiedLegacyTransportLinkAttemptIds(input: {
  readonly controllerJobRootDir: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly ledger: ConsumedOutputLedger;
}): Promise<ReadonlySet<string>> {
  const root = join(input.controllerJobRootDir, "project-integration",
    "integration-attempts");
  await assertSafePathFromRoot(input.controllerJobRootDir, root, false);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return new Set();
    throw error;
  }
  const verified = new Set<string>();
  const observedAttemptIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("legacy_integration_transport_link_attempt_root_invalid");
    }
    const raw = await readJsonFile(input.controllerJobRootDir,
      join(root, entry.name, "attempt.json"));
    const attempt = raw as IntegrationAttempt;
    if (typeof attempt?.attemptId !== "string" ||
        entry.name !== hash(attempt.attemptId) ||
        observedAttemptIds.has(attempt.attemptId)) {
      throw new Error("legacy_integration_transport_link_attempt_binding_invalid");
    }
    observedAttemptIds.add(attempt.attemptId);
    if (attempt.status !== IntegrationAttemptStatus.ChecksPassed) continue;
    const receipt = await readLegacyIntegrationTransportLink(
      input.controllerJobRootDir, attempt.attemptId);
    if (!receipt) continue;
    if (receipt.schemaVersion !== 1 ||
        receipt.disposition !== "superseded_by_exact_published_attempt" ||
        receipt.oldAttemptId !== attempt.attemptId) {
      throw new Error("legacy_integration_transport_link_receipt_invalid");
    }
    const validated = await validateLegacyIntegrationTransportLink({
      ...input,
      oldAttemptId: receipt.oldAttemptId,
      expectedOldAttemptSha256: receipt.oldAttemptSha256,
      adoptedAttemptId: receipt.adoptedAttemptId,
      expectedAdoptedAttemptSha256: receipt.adoptedAttemptSha256,
      commitSha: receipt.commitSha,
    });
    if (JSON.stringify(validated.receipt) !== JSON.stringify(receipt)) {
      throw new Error("legacy_integration_transport_link_receipt_invalid");
    }
    verified.add(attempt.attemptId);
  }
  return verified;
}

function sameTransport(a: IntegrationAttempt, b: IntegrationAttempt): boolean {
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  return a.workerJobId === b.workerJobId &&
    a.sourceWorkspacePath === b.sourceWorkspacePath &&
    a.targetWorkspacePath === b.targetWorkspacePath &&
    a.targetRemote === b.targetRemote && a.targetBranch === b.targetBranch &&
    a.workerOutput.workspacePath === b.workerOutput.workspacePath &&
    a.workerOutput.baseCommit === b.workerOutput.baseCommit &&
    a.workerOutput.targetCommit === b.workerOutput.targetCommit &&
    a.workerOutput.commitSha === b.workerOutput.commitSha &&
    !!a.workerOutput.patchSha256 && hex64.test(a.workerOutput.patchSha256) &&
    a.workerOutput.patchSha256 === b.workerOutput.patchSha256 &&
    same(a.workerOutput.changedFiles, b.workerOutput.changedFiles) &&
    same(a.expectedFiles, b.expectedFiles);
}

async function readAttempt(root: string, attemptId: string): Promise<{
  readonly attempt: IntegrationAttempt; readonly sha256: string;
}> {
  if (!attemptId || attemptId.length > 256 || /[\x00-\x1f\x7f]/.test(attemptId)) {
    throw new Error("legacy_integration_transport_link_attempt_id_invalid");
  }
  const path = join(root, "project-integration", "integration-attempts",
    hash(attemptId), "attempt.json");
  const bytes = await readFileBounded(root, path);
  return { attempt: JSON.parse(bytes.toString("utf8")) as IntegrationAttempt,
    sha256: hash(bytes) };
}

async function readJsonFile(root: string, path: string): Promise<unknown> {
  return JSON.parse((await readFileBounded(root, path)).toString("utf8")) as unknown;
}

async function readFileBounded(root: string, path: string): Promise<Buffer> {
  await assertSafePathFromRoot(root, dirname(path), false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error("legacy_integration_transport_link_file_invalid");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertSafePathFromRoot(
  root: string,
  path: string,
  allowMissing: boolean,
): Promise<void> {
  const canonicalRoot = resolve(root);
  const relativePath = relative(canonicalRoot, resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
      relativePath.startsWith(sep)) {
    throw new Error("legacy_integration_transport_link_path_outside_controller");
  }
  const parts = relativePath ? relativePath.split(sep) : [];
  let current = canonicalRoot;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("legacy_integration_transport_link_directory_invalid");
      }
    } catch (error) {
      if (allowMissing && isNodeError(error, "ENOENT")) continue;
      throw error;
    }
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
