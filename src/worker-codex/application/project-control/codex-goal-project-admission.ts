import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  consumedDebt,
  consumedOutputRecordFor,
  evaluateProjectAdmission,
  projectAdmissionDebtCounts,
  type ConsumedOutputLedger,
  type ProjectAccessScope,
  type ProjectAdmissionGate,
  type ProjectAdmissionRequest,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
  type ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobSummary,
} from "../../codex-goal-jobs";
import { stringValue } from "../codex-goal-input-values";
import { readLedgerEpochAdmissionState } from "./codex-goal-ledger-epoch-admission-debt";
import { resolveConsumedOutputMaintenanceLedgerRoot } from
  "./codex-goal-consumed-output-ledger-epoch";
import {
  assertSocialProposedAdmissionSourceOrphanSeal,
  assertSocialProposedAdmissionDebtCustody,
  normalizeAnchoredProposedAdmission,
  readSocialProposedAdmissionAnchor,
  SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
  verifySocialPreparedV1SourceOrphanSeal,
  verifySocialProposedAdmissionAnchorEvidence,
} from "./codex-goal-ledger-epoch-proposed-admission";
import { duplicateWorkspaceIdentityJobIds } from "./codex-goal-project-workspace-history";
import { limitCodexProjectSummariesForInspection } from "./codex-goal-project-admission-summary-limit";
import {
  withoutAdmittedInputPatchDebt,
  withoutCapacityContinuationSiblingDebt,
  withoutInPlaceContinuationSelfDebt,
  type ProjectAdmissionInPlaceContinuationBinding,
  type ProjectAdmissionJobWorkspaceBinding,
} from "./codex-goal-project-admission-normalization";
import {
  admissionWorkspacePathsMatch,
  optionalRealPathForAdmission,
} from "./codex-goal-project-admission-paths";
import {
  hasBlockingActiveWriterRisk,
  stoppedWorkspaceTerminalConsumption,
  terminalConsumptionCoversStoppedRisk,
} from "./codex-goal-project-terminal-consumption";
import {
  matchesProjectControlPrefix,
  nodeErrorCode,
  stringArrayArg,
  uniqueProjectControlStrings,
} from "./codex-goal-project-utils";
import { readLaunchAuthorizedWorkerLaunchSpec } from "./codex-goal-project-pre-start-admission";
import { pendingAdmittedInputPatchPathEvidence } from
  "./codex-goal-project-pending-input-patch-admission";
import { orphanDirtyWorkspaceDebt } from
  "./codex-goal-project-orphan-workspace-admission";
import { resolveLedgerEpochDebtCustody } from
  "./codex-goal-consumed-output-ledger-epoch-switch";
import {
  legacyJobSummaryRetirementPath,
  projectRetirementProjection,
} from "./codex-goal-legacy-job-summary-retirement";
import { frozenOutputSupersessionProjection } from
  "./codex-goal-frozen-output-import";
import {
  defaultHostDiskUsagePort,
  type HostDiskUsagePort,
} from "./adapters/host-command-adapters";
type JsonObject = Readonly<Record<string, unknown>>;
export type CodexProjectAdmissionDeps = {
  readonly listJobs: (input: {
    readonly registryRootDir: string;
  }) => Promise<readonly CodexGoalJobSummary[]>;
  readonly buildOverviewItems: (inputs: readonly {
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly staleAfterMs: number;
    readonly tailLines: number;
  }[]) => Promise<readonly JsonObject[]>;
  readonly readJob?: (input: {
    readonly registryRootDir: string;
    readonly jobId: string;
  }) => Promise<CodexGoalJobManifest>;
  readonly observeManifestRuntime?: (
    manifest: CodexGoalJobManifest,
  ) => Promise<{
    readonly workspaceDirty: boolean;
    readonly workerAlive: boolean;
    readonly resultExists: boolean;
    readonly resultPath?: string;
  }>;
  readonly normalizeActiveProposedAdmission?: (
    scope: ProjectAccessScope,
    snapshot: ProjectAdmissionSnapshot,
    summaries: readonly CodexGoalJobSummary[],
  ) => Promise<ProjectAdmissionSnapshot>;
  readonly evidenceCustody?: ProjectControlEvidenceCustodyPort;
};

type CodexProjectAdmissionInput = {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly controllerJobId?: string;
  readonly deps: CodexProjectAdmissionDeps;
  readonly admittedInputPatchTarget?: ProjectAdmissionJobWorkspaceBinding;
  readonly capacityContinuationTarget?: ProjectAdmissionJobWorkspaceBinding;
  readonly inPlaceContinuationTarget?: ProjectAdmissionInPlaceContinuationBinding;
};
type CodexProjectMutationAdmissionInput = CodexProjectAdmissionInput & {
  readonly controllerJobId: string;
};
type CodexProjectAdmissionSnapshotInput = CodexProjectAdmissionInput & {
  readonly requestedWorkspacePath?: string;
  readonly blockAnyLiveWriter?: boolean;
  readonly allowPendingEpochOrphanQuarantine?: boolean;
  readonly skipActiveProposedAdmissionNormalization?: boolean;
  readonly admittedInputPatchRequest?: ProjectAdmissionRequest;
};

export function projectAdmissionDetailView(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly decision?: ReturnType<typeof evaluateProjectAdmission>;
  readonly includeDetails: boolean;
  readonly maxDebtItems?: number;
}): {
  readonly snapshot: JsonObject;
  readonly decision?: JsonObject;
} {
  const debtLimit = projectAdmissionDebtLimit(input.maxDebtItems);
  const snapshotDebt = input.includeDetails
    ? limitedProjectDebt(input.snapshot.debt, debtLimit)
    : [];
  const decisionDebt = input.decision && input.includeDetails
    ? limitedProjectDebt(input.decision.debt, debtLimit)
    : [];
  return {
    snapshot: {
      ...input.snapshot,
      debt: snapshotDebt,
      debtCount: input.snapshot.debt.length,
      debtOmittedCount: input.snapshot.debt.length - snapshotDebt.length,
      detailsIncluded: input.includeDetails,
    } as unknown as JsonObject,
    ...(input.decision
      ? {
          decision: {
            ...input.decision,
            debt: decisionDebt,
            debtCount: input.decision.debt.length,
            debtOmittedCount: input.decision.debt.length - decisionDebt.length,
            detailsIncluded: input.includeDetails,
          } as unknown as JsonObject,
        }
      : {}),
  };
}

export function codexProjectAdmissionGate(
  input: CodexProjectMutationAdmissionInput,
): ProjectAdmissionGate {
  return {
    async evaluate(request) {
      // Admission protects a mutation. A cached pre-launch snapshot can no
      // longer prove that another writer did not start in the meantime.
      const observedSnapshot = await buildCodexProjectAdmissionSnapshot({
        ...input,
        ...(request.workspacePath
          ? { requestedWorkspacePath: request.workspacePath }
          : {}),
        blockAnyLiveWriter: request.ownedPaths !== undefined ||
          request.workspacePath === undefined,
        ...(input.admittedInputPatchTarget
          ? { admittedInputPatchRequest: request }
          : {}),
      });
      const snapshot = await withoutCapacityContinuationSiblingDebt({
        snapshot: observedSnapshot,
        request,
        ...(input.capacityContinuationTarget
          ? { binding: input.capacityContinuationTarget }
          : {}),
      });
      const continuationSnapshot = await withoutInPlaceContinuationSelfDebt({
        snapshot,
        request,
        ...(input.inPlaceContinuationTarget
          ? { binding: input.inPlaceContinuationTarget }
          : {}),
      });
      return evaluateProjectAdmission({
        request: {
          ...request,
          projectId: request.projectId ?? input.scope.projectId,
        },
        snapshot: continuationSnapshot,
      });
    },
  };
}

export async function readCodexProjectAdmissionSnapshot(
  input: CodexProjectAdmissionInput,
): Promise<ProjectAdmissionSnapshot> {
  const ttlMs = projectAdmissionCacheTtlMs();
  if (ttlMs <= 0) return buildCodexProjectAdmissionSnapshot(input);
  const key = projectAdmissionCacheKey(input);
  const now = Date.now();
  const cached = projectAdmissionSnapshotCache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.snapshot;
  const snapshot = await buildCodexProjectAdmissionSnapshot(input);
  projectAdmissionSnapshotCache.set(key, {
    expiresAtMs: now + ttlMs,
    snapshot,
  });
  return snapshot;
}

export async function buildCodexProjectAdmissionSnapshot(
  input: CodexProjectAdmissionSnapshotInput,
): Promise<ProjectAdmissionSnapshot> {
  const debt: ProjectDebtItem[] = [];
  const knownWorkspacePaths = new Set<string>();
  const prefixes = input.scope.jobIdPrefixes ?? [];
  const staleAfterMs = 10 * 60_000;
  const ledgerState = await readLedgerEpochAdmissionState({
    scope: input.scope,
    ...(input.allowPendingEpochOrphanQuarantine === undefined
      ? {}
      : {
          allowPendingOrphanQuarantine:
            input.allowPendingEpochOrphanQuarantine,
        }),
  });
  const consumedOutput = ledgerState.consumedOutput;
  debt.push(...ledgerState.quarantineDebt);
  let summaries;
  try {
    summaries = await input.deps.listJobs({ registryRootDir: input.registryRootDir });
  } catch (error) {
    debt.push({
      reason: ProjectDebtReason.UnreadableRoot,
      subject: input.registryRootDir,
      severity: "blocking",
      evidence: [
        `registry unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
    summaries = [];
  }
  const matchingProjectSummariesBeforeRetirement = summaries.every((summary) =>
      matchesProjectControlPrefix(summary.jobId, prefixes)
    )
    ? summaries
    : summaries.filter((summary) =>
        matchesProjectControlPrefix(summary.jobId, prefixes)
      );
  const custodyProjectionEnabled = input.deps.evidenceCustody !== undefined &&
    ((input.scope.consumedOutputEvidenceRoots?.length ?? 0) > 0 ||
      (input.scope.consumedOutputLedgerRoots?.length ?? 0) > 0);
  const evidenceCustody = custodyProjectionEnabled
    ? input.deps.evidenceCustody
    : undefined;
  const retirementProjection = custodyProjectionEnabled
    ? await projectRetirementProjection({
        custody: evidenceCustody!,
        registryRootDir: input.registryRootDir,
        projectId: input.scope.projectId,
        ...(input.controllerJobId
          ? { controllerJobId: input.controllerJobId }
          : {}),
        jobIdPrefixes: prefixes,
        summaries: matchingProjectSummariesBeforeRetirement,
        observeRuntime: async (manifest) => {
          const state = await projectionRuntimeObservation(input, manifest);
          return { workerAlive: state.workerAlive };
        },
      })
    : { active: matchingProjectSummariesBeforeRetirement, retired: [] };
  const frozenProjection = custodyProjectionEnabled
    ? await frozenOutputSupersessionProjection({
        custody: evidenceCustody!,
        scope: input.scope,
        registryRootDir: input.registryRootDir,
        evidenceRoots: input.scope.consumedOutputEvidenceRoots ?? [],
        ledgerRoots: input.scope.consumedOutputLedgerRoots ?? [],
        projectId: input.scope.projectId,
        ...(input.controllerJobId
          ? { controllerJobId: input.controllerJobId }
          : {}),
        summaries: retirementProjection.active,
        observeRuntime: async (manifest) =>
          await projectionRuntimeObservation(input, manifest),
      })
    : { active: retirementProjection.active, supersessions: [] };
  const matchingProjectSummaries = frozenProjection.active;
  debt.push(...consumedOutputDebtForCurrentRegistry({
    ledger: consumedOutput,
    currentJobIds: new Set(
      matchingProjectSummaries.map((summary) => summary.jobId),
    ),
  }));
  const projectSummaries = limitCodexProjectSummariesForInspection(
    matchingProjectSummaries,
    consumedOutput,
  );
  const overviewSummaries: CodexGoalJobSummary[] = [];
  for (const summary of projectSummaries) {
    const consumed = await debtFromConsumedJobSummary({
      summary,
      consumedOutput,
      knownWorkspacePaths,
    });
    if (consumed) {
      debt.push(...consumed);
      continue;
    }
    overviewSummaries.push(summary);
  }
  const overviewItems = await input.deps.buildOverviewItems(
    overviewSummaries.map((summary) => ({
      registryRootDir: input.registryRootDir,
      jobId: summary.jobId,
      staleAfterMs,
      tailLines: 0,
    })),
  );
  const summariesByJobId = new Map(
    projectSummaries.map((summary) => [summary.jobId, summary]),
  );
  const duplicateWorkspaceJobIds = await duplicateWorkspaceIdentityJobIds(
    overviewItems,
  );
  for (const item of overviewItems) {
    if (typeof item.workspacePath === "string") {
      await rememberKnownWorkspacePath(knownWorkspacePaths, item.workspacePath);
    }
    debt.push(...await debtFromOverviewItem({
      item,
      consumedOutput,
      summariesByJobId,
      registryRootDir: input.registryRootDir,
      scope: input.scope,
      readJob: input.deps.readJob,
      duplicateWorkspaceIdentity: duplicateWorkspaceJobIds.has(
        stringValue(item.jobId) ?? "unknown-job",
      ),
      ...(input.requestedWorkspacePath
        ? { requestedWorkspacePath: input.requestedWorkspacePath }
        : {}),
      blockAnyLiveWriter: input.blockAnyLiveWriter ?? false,
    }));
  }
  const roots = uniqueProjectControlStrings([
    ...(input.scope.workspaceRoots ?? []),
    ...(input.scope.worktreeRoots ?? []),
    ...(input.scope.observedWorkspaceRoots ?? []),
  ]);
  for (const root of roots) {
    debt.push(...await orphanDirtyWorkspaceDebt({
      root,
      prefixes,
      knownWorkspacePaths,
      consumedOutput,
      orphanWorkspaceBindings: ledgerState.orphanWorkspaceBindings,
      deniedRoots: input.scope.deniedRoots ?? [],
    }));
    debt.push(...await diskPressureDebt(root));
  }
  const rawSnapshot: ProjectAdmissionSnapshot = {
    schemaVersion: 1,
    projectId: input.scope.projectId,
    observedAt: new Date().toISOString(),
    debt,
    counts: projectAdmissionDebtCounts(debt),
    ...(retirementProjection.retired.length === 0 ? {} : {
      retiredLegacyJobSummaries: retirementProjection.retired.map((receipt) => ({
        jobId: receipt.jobId,
        manifestSha256: receipt.manifestSha256,
        retainedRegistrationJobId: receipt.retainedRegistrationJobId,
        receiptPath: legacyJobSummaryRetirementPath({
          registryRootDir: input.registryRootDir,
          projectId: receipt.projectId,
          jobId: receipt.jobId,
          manifestSha256: receipt.manifestSha256,
        }),
      })),
    }),
    ...(frozenProjection.supersessions.length === 0 ? {} : {
      supersededFrozenOutputSummaries: frozenProjection.supersessions.flatMap(
        ({ receipt, supersededSummaries }) => supersededSummaries.map((summary) => ({
          jobId: summary.jobId,
          manifestSha256: summary.manifestSha256,
          retainedRegistrationJobId: receipt.retainedRegistrationJobId,
          receiptPath: receipt.receiptPath,
        })),
      ),
    }),
  };
  const snapshot = await withoutAdmittedInputPatchDebt({
    snapshot: rawSnapshot,
    request: input.admittedInputPatchRequest,
    ...(input.admittedInputPatchTarget
      ? { binding: input.admittedInputPatchTarget }
      : {}),
  });
  return input.skipActiveProposedAdmissionNormalization
    ? snapshot
    : await (input.deps.normalizeActiveProposedAdmission ??
        normalizeActiveSocialProposedAdmission)(
          input.scope,
          snapshot,
          matchingProjectSummaries,
        );
}

async function projectionRuntimeObservation(
  input: CodexProjectAdmissionSnapshotInput,
  manifest: CodexGoalJobManifest,
): Promise<{
  readonly workspaceDirty: boolean;
  readonly workerAlive: boolean;
  readonly resultExists: boolean;
  readonly resultPath?: string;
}> {
  const observeRuntime = input.deps.observeManifestRuntime;
  if (!observeRuntime) {
    throw new Error("project_control_projection_runtime_unproven");
  }
  return await observeRuntime(manifest);
}

export async function normalizeActiveSocialProposedAdmission(
  scope: ProjectAccessScope,
  snapshot: ProjectAdmissionSnapshot,
  summaries: readonly CodexGoalJobSummary[],
): Promise<ProjectAdmissionSnapshot> {
  if (scope.projectId !== "social-monitor" ||
    (scope.consumedOutputLedgerRoots?.length ?? 0) !== 1) return snapshot;
  const active = await resolveConsumedOutputMaintenanceLedgerRoot(scope);
  const receipt = active.epochReceipt;
  if (!receipt || receipt.planSha256 !== SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) {
    return snapshot;
  }
  if (resolve(active.ledgerRoot) !== resolve(receipt.newRoot)) {
    throw new Error("ledger_epoch_proposed_admission_active_root_mismatch");
  }
  const anchor = await readSocialProposedAdmissionAnchor(
    receipt,
    receipt.proposedAdmissionAnchorSha256,
  );
  if (!anchor) throw new Error("ledger_epoch_proposed_admission_anchor_missing");
  const sourceOrphanSeal = await verifySocialPreparedV1SourceOrphanSeal(receipt);
  assertSocialProposedAdmissionSourceOrphanSeal(anchor, sourceOrphanSeal);
  await verifySocialProposedAdmissionAnchorEvidence(anchor);
  const currentCustody = await resolveLedgerEpochDebtCustody(snapshot, summaries);
  assertSocialProposedAdmissionDebtCustody(anchor, currentCustody);
  return normalizeAnchoredProposedAdmission({ anchor, snapshot });
}

const LEGACY_FAILED_NO_OUTPUT_DIRTY_EVIDENCE =
  "failed_no_output record contradicts non-empty workspace status evidence";

function consumedOutputDebtForCurrentRegistry(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly currentJobIds: ReadonlySet<string>;
}): readonly ProjectDebtItem[] {
  const recordsByLedgerPath = new Map(
    [...input.ledger.byJobId.values()].map((record) => [
      resolve(record.ledgerPath),
      record,
    ]),
  );
  return input.ledger.debt.map((item) => {
    if (item.reason !== ProjectDebtReason.IncompleteConsumedOutputRecord) {
      return item;
    }
    const record = recordsByLedgerPath.get(resolve(item.subject));
    if (
      !record ||
      record.status !== "failed_no_output" ||
      record.valid ||
      input.currentJobIds.has(record.jobId) ||
      record.evidence.length !== 1 ||
      record.evidence[0] !== LEGACY_FAILED_NO_OUTPUT_DIRTY_EVIDENCE
    ) {
      return item;
    }
    return {
      reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
      subject: item.subject,
      severity: "info",
      evidence: [
        ...item.evidence,
        `legacy job ${record.jobId} is absent from the current registry`,
        "record remains invalid and requires retention-owned immutable capture/quarantine before cleanup",
      ],
    };
  });
}

export function projectAdmissionOperation(value: unknown): ProjectOperation | undefined {
  const operation = stringValue(value);
  if (operation === undefined) return undefined;
  if (operation === ProjectOperation.CreateJob) return ProjectOperation.CreateJob;
  if (operation === ProjectOperation.StartWorker) return ProjectOperation.StartWorker;
  if (operation === ProjectOperation.CreateWorktree) return ProjectOperation.CreateWorktree;
  throw new Error("project_admission_operation_invalid");
}

export function projectAdmissionWorkerRoleArg(
  value: unknown,
): ProjectAdmissionWorkerRole | undefined {
  const role = stringValue(value);
  if (role === undefined) return undefined;
  if ((Object.values(ProjectAdmissionWorkerRole) as readonly string[]).includes(role)) {
    return role as ProjectAdmissionWorkerRole;
  }
  throw new Error("project_admission_worker_role_invalid");
}

const projectAdmissionSnapshotCache = new Map<
  string,
  { readonly expiresAtMs: number; readonly snapshot: ProjectAdmissionSnapshot }
>();

function projectAdmissionDebtLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function limitedProjectDebt(
  debt: readonly ProjectDebtItem[],
  limit: number | undefined,
): readonly ProjectDebtItem[] {
  return limit === undefined ? debt : debt.slice(0, limit);
}

function projectAdmissionCacheTtlMs(): number {
  const raw = Number(process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_CACHE_TTL_MS ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 120_000);
}

function projectAdmissionCacheKey(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
}): string {
  return JSON.stringify({
    registryRootDir: input.registryRootDir,
    projectId: input.scope.projectId,
    jobIdPrefixes: input.scope.jobIdPrefixes ?? [],
    workspaceRoots: input.scope.workspaceRoots ?? [],
    worktreeRoots: input.scope.worktreeRoots ?? [],
    observedWorkspaceRoots: input.scope.observedWorkspaceRoots ?? [],
    consumedOutputLedgerRoots: input.scope.consumedOutputLedgerRoots ?? [],
  });
}

async function debtFromConsumedJobSummary(input: {
  readonly summary: CodexGoalJobSummary;
  readonly consumedOutput: ConsumedOutputLedger;
  readonly knownWorkspacePaths: Set<string>;
}): Promise<readonly ProjectDebtItem[] | undefined> {
  // Workspace-level fallback is only safe once worker liveness is known. A live
  // verifier can intentionally share a dirty producer workspace whose output
  // was already consumed under the producer job id.
  if (!input.consumedOutput.byJobId.has(input.summary.jobId)) return undefined;
  const resolvedWorkspacePath = await optionalRealPathForAdmission(
    input.summary.workspacePath,
  );
  const consumed = consumedOutputRecordFor({
    ledger: input.consumedOutput,
    jobId: input.summary.jobId,
    workspacePath: input.summary.workspacePath,
    ...(resolvedWorkspacePath ? { resolvedWorkspacePath } : {}),
  });
  if (!consumed) return undefined;
  if (consumed.retentionEvidenceMissing) return undefined;
  await rememberKnownWorkspacePath(
    input.knownWorkspacePaths,
    input.summary.workspacePath,
  );
  return consumedRecordDebt(input.consumedOutput, consumed);
}

function consumedRecordDebt(
  ledger: ConsumedOutputLedger,
  record: Parameters<typeof consumedDebt>[0],
): readonly ProjectDebtItem[] {
  const debt = consumedDebt(record);
  const ledgerAlreadyReportedInvalidRecord = ledger.debt.some((item) =>
    (
      item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord ||
      item.reason === ProjectDebtReason.RetentionEvidenceMissing
    ) &&
    item.subject === record.ledgerPath
  );
  return ledgerAlreadyReportedInvalidRecord
    ? debt.filter((item) =>
      item.reason !== ProjectDebtReason.IncompleteConsumedOutputRecord &&
      item.reason !== ProjectDebtReason.RetentionEvidenceMissing
    )
    : debt;
}

async function debtFromOverviewItem(input: {
  readonly item: JsonObject;
  readonly consumedOutput: ConsumedOutputLedger;
  readonly summariesByJobId: ReadonlyMap<string, CodexGoalJobSummary>;
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly readJob: CodexProjectAdmissionDeps["readJob"];
  readonly duplicateWorkspaceIdentity: boolean;
  readonly requestedWorkspacePath?: string;
  readonly blockAnyLiveWriter: boolean;
}): Promise<ProjectDebtItem[]> {
  const { item } = input;
  const jobId = stringValue(item.jobId) ?? "unknown-job";
  const workspacePath = stringValue(item.workspacePath);
  if (item.ok !== true) {
    return [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: jobId,
      severity: "blocking",
      evidence: [stringValue(item.safeMessage) ?? "job overview unavailable"],
    }];
  }
  const debt: ProjectDebtItem[] = [];
  const workerAlive = item.workerAlive === true;
  const resolvedWorkspacePath = workspacePath
    ? await optionalRealPathForAdmission(workspacePath)
    : undefined;
  const stoppedTerminalConsumption = stoppedWorkspaceTerminalConsumption({
    ledger: input.consumedOutput,
    jobId,
    workerAlive,
    workerExplicitlyStopped: item.workerAlive === false,
    workspacePath,
    resolvedWorkspacePath,
  });
  const stoppedTerminalCandidate = item.workerAlive === false
    ? consumedOutputRecordFor({
        ledger: input.consumedOutput,
        jobId,
      })
    : undefined;
  const terminalConsumptionWorkspaceMismatch =
    item.workerAlive === false &&
    item.workspaceDirty === true &&
    stoppedTerminalCandidate?.structurallyValid === true &&
    stoppedTerminalConsumption === undefined;
  const terminalConsumptionCoversStoppedConflict =
    terminalConsumptionCoversStoppedRisk(
      stoppedTerminalConsumption,
      item.activeWriterRisk,
    );
  const malformedDirtyWriterObservation =
    item.workspaceDirty === true &&
    (typeof item.workerAlive !== "boolean" ||
      typeof item.activeWriterRisk !== "string" ||
      item.activeWriterRisk.trim().length === 0);
  const sameRequestedWorkspace = workerAlive && workspacePath !== undefined &&
    input.requestedWorkspacePath !== undefined &&
    await admissionWorkspacePathsMatch(
      workspacePath,
      input.requestedWorkspacePath,
    );
  const pendingInputPatchEvidence =
    await pendingAdmittedInputPatchPathEvidence({
      item,
      summary: input.summariesByJobId.get(jobId),
      workerAlive,
      duplicateWorkspaceIdentity: input.duplicateWorkspaceIdentity,
      registryRootDir: input.registryRootDir,
      scope: input.scope,
      ...(input.readJob ? { readJob: input.readJob } : {}),
    });
  if (
    malformedDirtyWriterObservation ||
    terminalConsumptionWorkspaceMismatch ||
    (!terminalConsumptionCoversStoppedConflict && (
      (workerAlive && (input.blockAnyLiveWriter || sameRequestedWorkspace)) ||
      hasBlockingActiveWriterRisk(item.activeWriterRisk, workerAlive) ||
      item.workspaceConflict === true ||
      input.duplicateWorkspaceIdentity
    ))
  ) {
    const pathDisjointProducerEvidence = await healthyLiveProducerPathEvidence({
      item,
      summary: input.summariesByJobId.get(jobId),
      workerAlive,
      sameRequestedWorkspace,
      duplicateWorkspaceIdentity: input.duplicateWorkspaceIdentity,
      registryRootDir: input.registryRootDir,
      scope: input.scope,
      readJob: input.readJob,
    });
    const pathEvidence = pendingInputPatchEvidence ?? pathDisjointProducerEvidence;
    debt.push({
      reason: ProjectDebtReason.ActiveWriterConflict,
      subject: jobId,
      severity: "blocking",
      ...pathEvidence,
      evidence: uniqueProjectControlStrings([
        ...safeStringArray(item.activeWriterRiskReasons),
        ...(pendingInputPatchEvidence
          ? ["broker-admitted input patch is validated and pending start"]
          : []),
        ...(sameRequestedWorkspace
          ? [`requested workspace already has active worker: ${workspacePath}`]
          : []),
        ...(input.duplicateWorkspaceIdentity
          ? ["workspace realpath is shared by multiple job summaries"]
          : []),
        "active writer conflict risk",
      ]),
    });
  }
  if (item.workspaceDirty !== true) return debt;
  if (pendingInputPatchEvidence) return debt;
  const subject = workspacePath ?? jobId;
  const stale = item.silentStale === true || item.workerFreshProgressAlive === false;
  if (workerAlive && stale) {
    debt.push({
      reason: ProjectDebtReason.StaleDirtyWorker,
      subject,
      severity: "blocking",
      evidence: [`${jobId} is alive/stale with dirty workspace`],
    });
    return debt;
  }
  if (workerAlive) return debt;
  const markerTypes = safeStringArray(item.lifecycleMarkerTypes);
  const recommendedAction = stringValue(item.recommendedAction);
  if (
    markerTypes.includes("review") &&
    recommendedAction === "review_completed" &&
    safeStringArray(item.tags).includes("worker-role-reviewer") &&
    workspacePath &&
    workspaceConsumedByAnotherJob({
      ledger: input.consumedOutput,
      jobId,
      workspacePath,
      ...(resolvedWorkspacePath ? { resolvedWorkspacePath } : {}),
    })
  ) {
    return withoutInactiveDirtyWorkspaceConflict(debt, item);
  }
  // A refill may intentionally reuse an inactive job's physical worktree. Only
  // a registered newer job on that same worktree can consume the older entry.
  if (
    workspacePath &&
    workspaceConsumedByLaterJob({
      ledger: input.consumedOutput,
      jobId,
      workspacePath,
      summariesByJobId: input.summariesByJobId,
      ...(resolvedWorkspacePath ? { resolvedWorkspacePath } : {}),
    })
  ) {
    return withoutInactiveDirtyWorkspaceConflict(debt, item);
  }
  const consumed = stoppedTerminalConsumption ?? consumedOutputRecordFor({
    ledger: input.consumedOutput,
    jobId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(resolvedWorkspacePath ? { resolvedWorkspacePath } : {}),
  });
  if (consumed) {
    debt.push(...consumedRecordDebt(input.consumedOutput, consumed));
    return debt;
  }
  const resultStatus = stringValue(item.resultStatus);
  const completedOrReviewed = resultStatus === "completed" ||
    recommendedAction === "review_completed" ||
    markerTypes.includes("review");
  const terminalDebt = completedOrReviewed
    ? withoutInactiveDirtyWorkspaceConflict(debt, item)
    : debt;
  const affectedPaths = safeStringArray(item.changedFiles);
  terminalDebt.push({
    reason: completedOrReviewed
      ? ProjectDebtReason.UnconsumedCompletedJob
      : ProjectDebtReason.InactiveDirtyWorkspace,
    subject,
    severity: "blocking",
    ...(completedOrReviewed && affectedPaths.length > 0
      ? { affectedPaths }
      : {}),
    evidence: [
      `${jobId} is inactive with dirty workspace`,
      `reviewed marker present: ${String(markerTypes.includes("review"))}`,
      "reviewed is not consumed; output must be integrated/rejected/archived",
    ],
  });
  return terminalDebt;
}

async function healthyLiveProducerPathEvidence(input: {
  readonly item: JsonObject;
  readonly summary: CodexGoalJobSummary | undefined;
  readonly workerAlive: boolean;
  readonly sameRequestedWorkspace: boolean;
  readonly duplicateWorkspaceIdentity: boolean;
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly readJob: CodexProjectAdmissionDeps["readJob"];
}): Promise<Pick<
  ProjectDebtItem,
  "affectedPaths" | "pathDisjointProducerEligible"
>> {
  const { item, summary } = input;
  if (
    !input.workerAlive ||
    stringValue(item.activeWriterRisk) !== "active_worker" ||
    item.silentStale === true ||
    item.workerFreshProgressAlive === false ||
    item.workspaceConflict === true ||
    input.sameRequestedWorkspace ||
    input.duplicateWorkspaceIdentity ||
    !summary ||
    !strictProducerRole(summary.tags) ||
    !input.readJob
  ) {
    return {};
  }
  try {
    const manifest = await input.readJob({
      registryRootDir: input.registryRootDir,
      jobId: summary.jobId,
    });
    if (
      !strictProducerRole(manifest.tags ?? []) ||
      !await admissionWorkspacePathsMatch(
        manifest.workspacePath,
        summary.workspacePath,
      )
    ) {
      return {};
    }
    const launch = await readLaunchAuthorizedWorkerLaunchSpec({
      manifest,
      scope: input.scope,
    });
    return {
      affectedPaths: launch.ownedPaths,
      pathDisjointProducerEligible: true,
    };
  } catch {
    return {};
  }
}

function strictProducerRole(tags: readonly string[]): boolean {
  const roleTags = tags.filter((tag) => tag.startsWith("worker-role-"));
  return roleTags.length === 1 &&
    roleTags[0] === `worker-role-${ProjectAdmissionWorkerRole.Producer}`;
}

function withoutInactiveDirtyWorkspaceConflict(
  debt: readonly ProjectDebtItem[],
  item: JsonObject,
): ProjectDebtItem[] {
  if (
    item.workspaceConflict === true ||
    stringValue(item.activeWriterRisk) !== "dirty_workspace_without_worker"
  ) {
    return [...debt];
  }
  return debt.filter(
    (entry) => entry.reason !== ProjectDebtReason.ActiveWriterConflict,
  );
}

function workspaceConsumedByAnotherJob(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly resolvedWorkspacePath?: string;
}): boolean {
  if (input.ledger.byJobId.has(input.jobId)) return false;
  const workspaceRecord = input.ledger.byWorkspace.get(resolve(input.workspacePath));
  const resolvedWorkspaceRecord = input.resolvedWorkspacePath
    ? input.ledger.byWorkspace.get(resolve(input.resolvedWorkspacePath))
    : undefined;
  const record = workspaceRecord ?? resolvedWorkspaceRecord;
  return record !== undefined && record.jobId !== input.jobId && record.valid;
}

function workspaceConsumedByLaterJob(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly resolvedWorkspacePath?: string;
  readonly summariesByJobId: ReadonlyMap<string, CodexGoalJobSummary>;
}): boolean {
  const workspaceRecord = input.ledger.byWorkspace.get(resolve(input.workspacePath));
  const resolvedWorkspaceRecord = input.resolvedWorkspacePath
    ? input.ledger.byWorkspace.get(resolve(input.resolvedWorkspacePath))
    : undefined;
  const record = workspaceRecord ?? resolvedWorkspaceRecord;
  if (!record || record.jobId === input.jobId || !record.valid) return false;

  const currentSummary = input.summariesByJobId.get(input.jobId);
  const consumingSummary = input.summariesByJobId.get(record.jobId);
  if (!currentSummary || !consumingSummary) return false;
  if (resolve(consumingSummary.workspacePath) !== resolve(input.workspacePath)) {
    return false;
  }

  const currentUpdatedAtMs = Date.parse(currentSummary.updatedAt);
  const consumingUpdatedAtMs = Date.parse(consumingSummary.updatedAt);
  const closedAtMs = Date.parse(record.closedAt ?? "");
  return Number.isFinite(currentUpdatedAtMs) &&
    Number.isFinite(consumingUpdatedAtMs) &&
    Number.isFinite(closedAtMs) &&
    currentUpdatedAtMs < consumingUpdatedAtMs &&
    consumingUpdatedAtMs < closedAtMs;
}

async function rememberKnownWorkspacePath(
  target: Set<string>,
  workspacePath: string,
): Promise<void> {
  target.add(resolve(workspacePath));
  try {
    target.add(await realpath(workspacePath));
  } catch {
    // Missing workspaces are handled by overview debt; keep the raw path.
  }
}

async function diskPressureDebt(
  root: string,
  diskUsage: HostDiskUsagePort = defaultHostDiskUsagePort,
): Promise<readonly ProjectDebtItem[]> {
  const minFreeKb = Number(process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MIN_FREE_KB ?? "0");
  if (!Number.isFinite(minFreeKb) || minFreeKb <= 0) return [];
  try {
    const availableBytes = await diskUsage.availableBytes({ path: root });
    if (availableBytes === undefined) return [];
    const availableKb = availableBytes / 1024;
    if (availableKb < minFreeKb) {
      return [{
        reason: ProjectDebtReason.DiskPressure,
        subject: root,
        severity: "blocking",
        evidence: [`availableKb=${availableKb} minFreeKb=${minFreeKb}`],
      }];
    }
    return [];
  } catch (error) {
    return [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: root,
      severity: "blocking",
      evidence: [
        `disk pressure check failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }];
  }
}

async function pathLooksLikeGitWorkspace(path: string): Promise<boolean> {
  try {
    await lstat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

function safeStringArray(value: unknown): readonly string[] {
  try {
    return stringArrayArg(value);
  } catch {
    return [];
  }
}
