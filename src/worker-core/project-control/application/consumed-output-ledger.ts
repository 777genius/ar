import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "../domain/project-admission";
import type { TerminalOutputBackup } from "../domain/terminal-output-decision";

const CONSUMED_OUTPUT_TERMINAL_STATUSES = new Set([
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
  "failed_no_output",
  "reviewed_no_change",
]);

const NO_OUTPUT_STATUS = "failed_no_output";
const REVIEWED_NO_CHANGE_STATUS = "reviewed_no_change";

export type ConsumedOutputRecord = {
  readonly jobId: string;
  readonly attemptId?: string;
  readonly status: string;
  readonly ledgerPath: string;
  readonly closedAt?: string;
  readonly workspace?: string;
  readonly resolvedWorkspace?: string;
  readonly commitSha?: string;
  readonly backup?: TerminalOutputBackup;
  readonly backupPatchSha256?: string;
  readonly backupEvidenceValid?: boolean;
  readonly backupWorkspaceDirty?: boolean;
  readonly preexistingWorkspacePatchValid?: boolean;
  readonly reclassifiableAsFailedNoOutput?: boolean;
  readonly hasAuthoredOutput: boolean;
  readonly structurallyValid?: boolean;
  readonly retentionEvidenceMissing?: boolean;
  readonly valid: boolean;
  readonly evidence: readonly string[];
};

export type ConsumedOutputLedger = {
  readonly byJobId: ReadonlyMap<string, ConsumedOutputRecord>;
  readonly byWorkspace: ReadonlyMap<string, ConsumedOutputRecord>;
  readonly debt: readonly ProjectDebtItem[];
};

export type ConsumedOutputLedgerEntry = {
  readonly ledgerPath: string;
  readonly value: unknown;
};

export type ConsumedOutputLedgerReadFailure = {
  readonly subject: string;
  readonly evidence: readonly string[];
};

export type ConsumedOutputLedgerSourcePort = {
  readEntries(input: {
    readonly roots: readonly string[];
  }): Promise<{
    readonly entries: readonly ConsumedOutputLedgerEntry[];
    readonly failures: readonly ConsumedOutputLedgerReadFailure[];
  }>;
  pathExists(path: string): Promise<boolean>;
  pathSize(path: string): Promise<number | undefined>;
  pathSha256(path: string): Promise<string | undefined>;
  resolveWorkspacePath(path: string): Promise<string | undefined>;
};

export async function readConsumedOutputLedgers(input: {
  readonly roots: readonly string[];
  readonly source: ConsumedOutputLedgerSourcePort;
}): Promise<ConsumedOutputLedger> {
  const byJobId = new Map<string, ConsumedOutputRecord>();
  const byWorkspace = new Map<string, ConsumedOutputRecord>();
  const loaded = await input.source.readEntries({
    roots: uniqueStrings(input.roots),
  });
  const debt: ProjectDebtItem[] = loaded.failures.map((failure) => ({
    reason: ProjectDebtReason.UnreadableRoot,
    subject: failure.subject,
    severity: "blocking",
    evidence: failure.evidence,
  }));
  const retentionEvidenceMissingRecords: ConsumedOutputRecord[] = [];
  for (const entry of loaded.entries) {
    let record: ConsumedOutputRecord | null;
    try {
      record = await consumedOutputRecordFromJson({
        value: entry.value,
        ledgerPath: entry.ledgerPath,
        source: input.source,
      });
    } catch (error) {
      debt.push({
        reason: ProjectDebtReason.UnreadableRoot,
        subject: entry.ledgerPath,
        severity: "blocking",
        evidence: [
          `terminal consumed-output evidence unreadable: ${errorMessage(error)}`,
        ],
      });
      continue;
    }
    if (!record) {
      if (hasTerminalOutputIntent(entry.value)) {
        debt.push({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
          subject: entry.ledgerPath,
          severity: "blocking",
          evidence: [
            "terminal consumed-output record has an unknown or invalid status",
          ],
        });
      }
      continue;
    }
    if (record.retentionEvidenceMissing) {
      retentionEvidenceMissingRecords.push(record);
    } else if (!record.valid) {
      debt.push({
        reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        subject: entry.ledgerPath,
        severity: "blocking",
        evidence: record.evidence,
      });
    }
    setLatestRecord(byJobId, record.jobId, record);
    if (
      record.status !== NO_OUTPUT_STATUS &&
      record.status !== REVIEWED_NO_CHANGE_STATUS &&
      record.workspace
    ) {
      setLatestRecord(byWorkspace, resolve(record.workspace), record);
    }
    if (
      record.status !== NO_OUTPUT_STATUS &&
      record.status !== REVIEWED_NO_CHANGE_STATUS &&
      record.resolvedWorkspace
    ) {
      setLatestRecord(byWorkspace, record.resolvedWorkspace, record);
    }
  }
  for (const record of retentionEvidenceMissingRecords) {
    const latest = byJobId.get(record.jobId);
    if (
      latest !== record &&
      latest?.status === "integrated" &&
      latest.structurallyValid &&
      compareConsumedRecords(latest, record) > 0
    ) {
      continue;
    }
    debt.push({
      reason: ProjectDebtReason.RetentionEvidenceMissing,
      subject: record.ledgerPath,
      severity: "info",
      evidence: record.evidence,
    });
  }
  return { byJobId, byWorkspace, debt };
}

function hasTerminalOutputIntent(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.jobId === "string" &&
    value.jobId.length > 0 &&
    typeof value.status === "string" &&
    value.status.length > 0;
}

function setLatestRecord(
  records: Map<string, ConsumedOutputRecord>,
  key: string,
  candidate: ConsumedOutputRecord,
): void {
  const current = records.get(key);
  if (!current || compareConsumedRecords(candidate, current) > 0) {
    records.set(key, candidate);
  }
}

function compareConsumedRecords(
  left: ConsumedOutputRecord,
  right: ConsumedOutputRecord,
): number {
  const leftTime = left.closedAt ? Date.parse(left.closedAt) : Number.NEGATIVE_INFINITY;
  const rightTime = right.closedAt
    ? Date.parse(right.closedAt)
    : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.ledgerPath.localeCompare(right.ledgerPath);
}

export async function consumedOutputRecordFromJson(input: {
  readonly value: unknown;
  readonly ledgerPath: string;
  readonly source: Pick<
    ConsumedOutputLedgerSourcePort,
    "pathExists" | "pathSize" | "pathSha256" | "resolveWorkspacePath"
  >;
}): Promise<ConsumedOutputRecord | null> {
  if (!isRecord(input.value)) return null;
  const status = stringValue(input.value.status);
  if (!status || !CONSUMED_OUTPUT_TERMINAL_STATUSES.has(status)) return null;
  const jobId = stringValue(input.value.jobId);
  if (!jobId) {
    return {
      jobId: basename(input.ledgerPath).replace(/\.json$/, ""),
      status,
      ledgerPath: input.ledgerPath,
      hasAuthoredOutput: false,
      structurallyValid: false,
      retentionEvidenceMissing: false,
      valid: false,
      evidence: ["terminal consumed-output record is missing jobId"],
    };
  }
  const structuralEvidence: string[] = [];
  const backup = isRecord(input.value.backup) ? input.value.backup : undefined;
  const workspace = backup ? stringValue(backup.workspace) : undefined;
  const terminalBackup = terminalOutputBackup(backup);
  const attemptId = stringValue(input.value.attemptId);
  const closedAt = stringValue(input.value.closedAt);
  const hasActiveClaim = isRecord(input.value.claim) ||
    input.value.active === true || input.value.claimed === true;
  if (input.value.schemaVersion !== 1) {
    structuralEvidence.push("terminal consumed-output record requires schemaVersion=1");
  }
  if (!stringValue(input.value.note)) {
    structuralEvidence.push("terminal consumed-output record is missing note");
  }
  if (!closedAt) {
    structuralEvidence.push("terminal consumed-output record is missing closedAt");
  }
  if (closedAt && !Number.isFinite(Date.parse(closedAt))) {
    structuralEvidence.push("terminal consumed-output record has invalid closedAt");
  }
  if (!backup) structuralEvidence.push("terminal consumed-output record is missing backup");
  if (!workspace) {
    structuralEvidence.push("terminal consumed-output backup is missing workspace");
  }
  const backupPathStructuralEvidence = terminalBackupPathEvidence(
    input.value,
    backup,
  );
  structuralEvidence.push(...backupPathStructuralEvidence);
  if (isRecord(input.value.claim)) {
    structuralEvidence.push("terminal consumed-output record still has active claim");
  }
  if (input.value.active === true || input.value.claimed === true) {
    structuralEvidence.push("terminal consumed-output record is still marked active/claimed");
  }
  const backupEvidence = backup
    ? backupPathStructuralEvidence.length === 0
      ? await consumedOutputBackupEvidence(backup, input.source)
      : {
        ok: false,
        hasAuthoredOutput: false,
        workspaceDirty: false,
        structuralEvidence: [],
        availabilityEvidence: [],
      }
    : {
      ok: false,
      hasAuthoredOutput: false,
      workspaceDirty: false,
      structuralEvidence: ["backup metadata is missing"],
      availabilityEvidence: [],
    };
  const preexistingWorkspacePatch = await preexistingWorkspacePatchEvidence(
    input.value,
    input.source,
  );
  structuralEvidence.push(...preexistingWorkspacePatch.structuralEvidence);
  structuralEvidence.push(...backupEvidence.structuralEvidence);
  const availabilityEvidence = [
    ...preexistingWorkspacePatch.availabilityEvidence,
    ...backupEvidence.availabilityEvidence,
  ];
  const commit = integratedOutputCommit(input.value);
  const hasAuthoredOutput = backupEvidence.hasAuthoredOutput ||
    (status === "integrated" && commit !== undefined);
  if (status === NO_OUTPUT_STATUS) {
    structuralEvidence.push(...failedNoOutputEvidence(
      input.value,
      hasAuthoredOutput,
      backupEvidence.workspaceDirty,
      preexistingWorkspacePatch.valid ||
        preexistingWorkspacePatch.availabilityEvidence.length > 0,
    ));
  } else if (status === REVIEWED_NO_CHANGE_STATUS) {
    structuralEvidence.push(...reviewedNoChangeEvidence(input.value, hasAuthoredOutput));
  } else if (!hasAuthoredOutput && availabilityEvidence.length === 0) {
    structuralEvidence.push(
      `terminal output status ${status} has no authored output evidence; use failed_no_output for infrastructure failures`,
    );
  }
  if (status === "integrated" && !commit) {
    structuralEvidence.push("integrated consumed-output record is missing commit evidence");
  }
  if (
    structuralEvidence.length === 0 &&
    availabilityEvidence.length > 0 &&
    !hasSupportedPrunedRetentionProvenance(input.value, status, closedAt, commit)
  ) {
    structuralEvidence.push(
      "pruned retention evidence does not match supported terminal writer provenance",
    );
  }
  const resolvedWorkspace = workspace
    ? await input.source.resolveWorkspacePath(workspace)
    : undefined;
  const reclassifiableAsFailedNoOutput = Boolean(
    closedAt &&
      terminalBackup &&
      !hasActiveClaim &&
      backupEvidence.ok &&
      !backupEvidence.hasAuthoredOutput &&
      !backupEvidence.workspaceDirty,
  );
  const structurallyValid = structuralEvidence.length === 0;
  const retentionEvidenceMissing = structurallyValid &&
    availabilityEvidence.length > 0;
  const valid = structurallyValid && availabilityEvidence.length === 0;
  const evidence = valid
    ? consumedOutputEvidence({
        status,
        ledgerPath: input.ledgerPath,
        ...(commit ? { commitSha: commit } : {}),
      })
    : [...structuralEvidence, ...availabilityEvidence];
  return {
    jobId,
    ...(attemptId ? { attemptId } : {}),
    status,
    ledgerPath: input.ledgerPath,
    ...(closedAt ? { closedAt } : {}),
    ...(workspace ? { workspace } : {}),
    ...(resolvedWorkspace ? { resolvedWorkspace } : {}),
    ...(commit ? { commitSha: commit } : {}),
    ...(terminalBackup ? { backup: terminalBackup } : {}),
    ...(backupEvidence.patchSha256
      ? { backupPatchSha256: backupEvidence.patchSha256 }
      : {}),
    backupEvidenceValid: backupEvidence.ok,
    backupWorkspaceDirty: backupEvidence.workspaceDirty,
    preexistingWorkspacePatchValid: preexistingWorkspacePatch.valid,
    reclassifiableAsFailedNoOutput,
    hasAuthoredOutput,
    structurallyValid,
    retentionEvidenceMissing,
    valid,
    evidence,
  };
}

export function consumedOutputRecordFor(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workspacePath?: string;
  readonly resolvedWorkspacePath?: string;
}): ConsumedOutputRecord | undefined {
  const workspace = input.workspacePath ? resolve(input.workspacePath) : undefined;
  const resolvedWorkspace = input.resolvedWorkspacePath
    ? resolve(input.resolvedWorkspacePath)
    : undefined;
  const byJob = input.ledger.byJobId.get(input.jobId);
  if (byJob) {
    if (
      workspace &&
      byJob.workspace &&
      resolve(byJob.workspace) !== workspace &&
      resolve(byJob.workspace) !== resolvedWorkspace &&
      byJob.resolvedWorkspace !== workspace &&
      byJob.resolvedWorkspace !== resolvedWorkspace
    ) {
      return {
        ...byJob,
        valid: false,
        evidence: [
          ...byJob.evidence,
          `ledger workspace ${byJob.workspace} does not match dirty workspace ${workspace}`,
        ],
      };
    }
    return byJob;
  }

  const byWorkspace = workspace
    ? input.ledger.byWorkspace.get(workspace)
    : undefined;
  const byResolvedWorkspace = resolvedWorkspace
    ? input.ledger.byWorkspace.get(resolvedWorkspace)
    : undefined;
  const workspaceRecord = byWorkspace ?? byResolvedWorkspace;
  if (workspaceRecord) {
    if (workspaceRecord.jobId !== input.jobId) {
      return {
        ...workspaceRecord,
        valid: false,
        evidence: [
          ...workspaceRecord.evidence,
          `ledger jobId ${workspaceRecord.jobId} does not match dirty jobId ${input.jobId}`,
        ],
      };
    }
    return workspaceRecord;
  }
  return undefined;
}

export function consumedDebt(record: ConsumedOutputRecord): readonly ProjectDebtItem[] {
  if (record.status === NO_OUTPUT_STATUS && record.valid) return [];
  if (record.retentionEvidenceMissing) {
    return [{
      reason: ProjectDebtReason.RetentionEvidenceMissing,
      subject: record.workspace ?? record.jobId,
      severity: "info",
      evidence: record.evidence,
    }];
  }
  return [{
    reason: record.valid
      ? ProjectDebtReason.ConsumedDirtyWorkspace
      : ProjectDebtReason.IncompleteConsumedOutputRecord,
    subject: record.workspace ?? record.jobId,
    severity: record.valid ? "info" : "blocking",
    evidence: record.valid
      ? consumedOutputEvidence(record)
      : record.evidence,
  }];
}

export function projectAdmissionDebtCounts(
  debt: readonly ProjectDebtItem[],
): NonNullable<ProjectAdmissionSnapshot["counts"]> {
  const count = (reason: ProjectDebtReason) =>
    debt.filter((item) => item.reason === reason).length;
  return {
    inactiveDirtyWorkspaces: count(ProjectDebtReason.InactiveDirtyWorkspace),
    unconsumedCompletedJobs: count(ProjectDebtReason.UnconsumedCompletedJob),
    orphanLegacyWorkspaces: count(ProjectDebtReason.OrphanLegacyWorkspace),
    consumedDirtyWorkspaces: count(ProjectDebtReason.ConsumedDirtyWorkspace),
    incompleteConsumedOutputRecords: count(ProjectDebtReason.IncompleteConsumedOutputRecord),
    retentionEvidenceMissing: count(ProjectDebtReason.RetentionEvidenceMissing),
    legacyOutputQuarantineRequired: count(
      ProjectDebtReason.LegacyOutputQuarantineRequired,
    ),
    activeWriterConflicts: count(ProjectDebtReason.ActiveWriterConflict),
    staleDirtyWorkers: count(ProjectDebtReason.StaleDirtyWorker),
    unreadableRoots: count(ProjectDebtReason.UnreadableRoot),
    unreadableWorkspaces: count(ProjectDebtReason.UnreadableWorkspace),
    diskPressure: count(ProjectDebtReason.DiskPressure),
  };
}

async function consumedOutputBackupEvidence(
  backup: Record<string, unknown>,
  source: Pick<
    ConsumedOutputLedgerSourcePort,
    "pathExists" | "pathSize" | "pathSha256"
  >,
): Promise<{
  readonly ok: boolean;
  readonly hasAuthoredOutput: boolean;
  readonly workspaceDirty: boolean;
  readonly patchSha256?: string;
  readonly structuralEvidence: readonly string[];
  readonly availabilityEvidence: readonly string[];
}> {
  const structuralEvidence: string[] = [];
  const availabilityEvidence: string[] = [];
  const statusPath = stringValue(backup.statusPath);
  let statusSize: number | undefined;
  if (!statusPath) {
    structuralEvidence.push("backup is missing statusPath");
  } else if (!await source.pathExists(statusPath)) {
    availabilityEvidence.push(
      `retained backup statusPath bytes are missing: ${statusPath}`,
    );
  } else {
    statusSize = await source.pathSize(statusPath);
    if (statusSize === undefined) {
      availabilityEvidence.push(
        `retained backup statusPath bytes are unavailable: ${statusPath}`,
      );
    }
  }
  const payloadPaths = [
    stringValue(backup.patchPath),
    stringValue(backup.numstatPath),
    stringValue(backup.untrackedArchivePath),
  ].filter((path): path is string => typeof path === "string");
  if (payloadPaths.length === 0) {
    structuralEvidence.push("backup is missing patch/numstat/untracked archive evidence");
  }
  const payloadSizes = await Promise.all(
    payloadPaths.map(async (path) => await source.pathSize(path)),
  );
  const patchPath = stringValue(backup.patchPath);
  const patchSha256 = patchPath
    ? await source.pathSha256(patchPath)
    : undefined;
  if (payloadPaths.length > 0 && payloadSizes.every((size) => size === undefined)) {
    availabilityEvidence.push(
      "retained backup patch/numstat/untracked archive bytes are missing",
    );
  }
  return {
    ok: structuralEvidence.length === 0 && availabilityEvidence.length === 0,
    hasAuthoredOutput: payloadSizes.some((size) => size !== undefined && size > 0),
    workspaceDirty: statusSize !== undefined && statusSize > 0,
    ...(patchSha256 ? { patchSha256 } : {}),
    structuralEvidence,
    availabilityEvidence,
  };
}

function failedNoOutputEvidence(
  value: Record<string, unknown>,
  hasAuthoredOutput: boolean,
  backupWorkspaceDirty: boolean,
  preexistingWorkspacePatchValid: boolean,
): readonly string[] {
  const evidence: string[] = [];
  const failure = isRecord(value.failure) ? value.failure : undefined;
  const output = isRecord(value.output) ? value.output : undefined;
  if (!failure || !stringValue(failure.code) || !stringValue(failure.category)) {
    evidence.push("failed_no_output record requires failure.code and failure.category");
  }
  if (!output || output.authoredChanges !== false || output.workspaceDirty !== false) {
    evidence.push(
      "failed_no_output record requires output.authoredChanges=false and output.workspaceDirty=false",
    );
  }
  if (hasAuthoredOutput) {
    evidence.push("failed_no_output record contradicts non-empty authored output evidence");
  }
  if (backupWorkspaceDirty && !preexistingWorkspacePatchValid) {
    evidence.push("failed_no_output record contradicts non-empty workspace status evidence");
  }
  return evidence;
}

async function preexistingWorkspacePatchEvidence(
  value: Record<string, unknown>,
  source: Pick<ConsumedOutputLedgerSourcePort, "pathSize" | "pathSha256">,
): Promise<{
  readonly valid: boolean;
  readonly structuralEvidence: readonly string[];
  readonly availabilityEvidence: readonly string[];
}> {
  const candidate = isRecord(value.preexistingWorkspacePatch)
    ? value.preexistingWorkspacePatch
    : undefined;
  if (!candidate) {
    return { valid: false, structuralEvidence: [], availabilityEvidence: [] };
  }
  const path = stringValue(candidate.path);
  const expectedSha256 = stringValue(candidate.sha256)?.toLowerCase();
  if (!path || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return {
      valid: false,
      structuralEvidence: ["preexisting workspace patch metadata is invalid"],
      availabilityEvidence: [],
    };
  }
  const backup = isRecord(value.backup) ? value.backup : undefined;
  const statusPath = backup ? stringValue(backup.statusPath) : undefined;
  if (!statusPath || !pathInsideOrEqual(path, dirname(statusPath))) {
    return {
      valid: false,
      structuralEvidence: ["preexisting workspace patch is outside terminal backup"],
      availabilityEvidence: [],
    };
  }
  // The scoped command verifies payload bytes before publishing the immutable
  // decision. Admission readers only inspect metadata and never open payloads.
  const size = await source.pathSize(path);
  if (size === undefined) {
    return {
      valid: false,
      structuralEvidence: [],
      availabilityEvidence: [
        `retained preexisting workspace patch bytes are missing: ${path}`,
      ],
    };
  }
  if (size <= 0) {
    return {
      valid: false,
      structuralEvidence: [`preexisting workspace patch is empty: ${path}`],
      availabilityEvidence: [],
    };
  }
  const actualSha256 = await source.pathSha256(path);
  if (actualSha256 !== expectedSha256) {
    return {
      valid: false,
      structuralEvidence: [`preexisting workspace patch hash mismatch: ${path}`],
      availabilityEvidence: [],
    };
  }
  return { valid: true, structuralEvidence: [], availabilityEvidence: [] };
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const pathRelative = relative(resolve(root), resolve(path));
  return pathRelative === "" ||
    (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`));
}

function terminalBackupPathEvidence(
  value: Record<string, unknown>,
  backup: Record<string, unknown> | undefined,
): readonly string[] {
  if (!backup) return [];
  const evidence: string[] = [];
  const workspace = stringValue(backup.workspace);
  const statusPath = stringValue(backup.statusPath);
  const payloadPaths = [
    stringValue(backup.patchPath),
    stringValue(backup.numstatPath),
    stringValue(backup.untrackedArchivePath),
  ].filter((path): path is string => path !== undefined);
  for (const key of ["patchPath", "numstatPath", "untrackedArchivePath"] as const) {
    if (backup[key] !== undefined && !stringValue(backup[key])) {
      evidence.push(`terminal consumed-output backup ${key} is invalid`);
    }
  }
  if (workspace && !isAbsolute(workspace)) {
    evidence.push("terminal consumed-output backup workspace must be absolute");
  }
  if (statusPath && !isAbsolute(statusPath)) {
    evidence.push("terminal consumed-output backup statusPath must be absolute");
  }
  if (statusPath) {
    const backupRoot = dirname(statusPath);
    for (const path of payloadPaths) {
      if (!isAbsolute(path) || !pathInsideOrEqual(path, backupRoot)) {
        evidence.push(`terminal consumed-output backup payload is outside backup root: ${path}`);
      }
    }
    const archivePath = stringValue(value.archivePath);
    if (value.archivePath !== undefined && !archivePath) {
      evidence.push("terminal consumed-output archivePath is invalid");
    }
    if (
      archivePath &&
      (!isAbsolute(archivePath) || !pathInsideOrEqual(archivePath, backupRoot))
    ) {
      evidence.push(
        `terminal consumed-output archivePath is outside backup root: ${archivePath}`,
      );
    }
  }
  return evidence;
}

function terminalOutputBackup(
  value: Record<string, unknown> | undefined,
): TerminalOutputBackup | undefined {
  if (!value) return undefined;
  const workspace = stringValue(value.workspace);
  const statusPath = stringValue(value.statusPath);
  if (!workspace || !statusPath) return undefined;
  const patchPath = stringValue(value.patchPath);
  const numstatPath = stringValue(value.numstatPath);
  const untrackedArchivePath = stringValue(value.untrackedArchivePath);
  return {
    workspace,
    statusPath,
    ...(patchPath ? { patchPath } : {}),
    ...(numstatPath ? { numstatPath } : {}),
    ...(untrackedArchivePath ? { untrackedArchivePath } : {}),
  };
}

function reviewedNoChangeEvidence(
  value: Record<string, unknown>,
  hasAuthoredOutput: boolean,
): readonly string[] {
  const evidence: string[] = [];
  if (stringValue(value.outcome) !== REVIEWED_NO_CHANGE_STATUS) {
    evidence.push("reviewed_no_change record requires outcome=reviewed_no_change");
  }
  if (hasAuthoredOutput) {
    evidence.push("reviewed_no_change record contradicts non-empty authored output evidence");
  }
  return evidence;
}

function integratedOutputCommit(value: Record<string, unknown>): string | undefined {
  for (const key of ["commitSha", "commit", "integratedCommitSha"]) {
    const topLevelCommit = stringValue(value[key]);
    if (topLevelCommit && /^[0-9a-f]{7,40}$/i.test(topLevelCommit)) {
      return topLevelCommit;
    }
  }
  const notes = Array.isArray(value.notes) ? value.notes : [];
  for (const note of notes) {
    if (!isRecord(note)) continue;
    const commit = stringValue(note.commit);
    if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) return commit;
  }
  return undefined;
}

function hasSupportedPrunedRetentionProvenance(
  value: Record<string, unknown>,
  status: string,
  closedAt: string | undefined,
  commit: string | undefined,
): boolean {
  if (status !== "integrated" && status !== "rejected") return false;
  if (!closedAt || stringValue(value.consumedAt) !== closedAt) return false;
  const noteText = stringValue(value.note);
  if (!noteText || !Array.isArray(value.notes) || value.notes.length !== 1) {
    return false;
  }
  const writerNote = value.notes[0];
  if (
    !isRecord(writerNote) ||
    stringValue(writerNote.status) !== status ||
    stringValue(writerNote.text) !== noteText
  ) {
    return false;
  }
  if (status === "rejected") {
    return writerNote.commit === undefined &&
      value.commitSha === undefined &&
      value.commit === undefined &&
      value.integratedCommitSha === undefined;
  }
  const canonicalCommit = stringValue(value.commitSha);
  if (
    !canonicalCommit ||
    !/^[0-9a-f]{7,40}$/i.test(canonicalCommit) ||
    commit !== canonicalCommit ||
    stringValue(writerNote.commit) !== canonicalCommit
  ) {
    return false;
  }
  return stringValue(value.commit) === canonicalCommit &&
    stringValue(value.integratedCommitSha) === canonicalCommit;
}

function consumedOutputEvidence(input: {
  readonly status: string;
  readonly ledgerPath: string;
  readonly commitSha?: string;
}): readonly string[] {
  if (input.status === NO_OUTPUT_STATUS) {
    return [
      "terminal job recorded with no authored output",
      `ledger: ${input.ledgerPath}`,
    ];
  }
  return [
    `dirty output consumed by terminal ledger status: ${input.status}`,
    `ledger: ${input.ledgerPath}`,
    ...(input.commitSha ? [`commit: ${input.commitSha}`] : []),
  ];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
