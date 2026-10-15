import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  buildRuntimeAccountWaitPlan,
  SelectRuntimeAccountUseCase,
  selectableWorkerAccountIds,
  type AttemptJournal,
  type SafeExecutionTaskRecord,
  type WorkerAccountCapacityStore,
  type WorkerAccountLeaseStore,
  type WorkerRuntimeDemand,
  type WorkerAccountRecoveryPreparation,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountLeaseStore } from "@vioxen/subscription-runtime/store-local-file";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import {
  CodexGoalAccountSelectionMode,
  type CodexGoalJobManifest,
} from "../../codex-goal-jobs";
import type {
  CodexGoalLaunchInput,
  CodexGoalStatus,
} from "../../codex-goal-ops";
import {
  codexAccountCapacityRootDir,
  codexAccountCapacityStore,
} from "../codex-account-capacity-store";
import { directCodexAppServerFailureCause } from "./codex-app-server-failure-cause";
import { researchDirectoryIdentity, researchPromptBytes } from "../../research-launch-files";

const reservationSchemaVersion = 1 as const;
const reservationGraceMs = 10 * 60_000;
const exclusiveLeaseFlag =
  "SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES";

export type CodexProjectAccountLeaseMode = "shared" | "exclusive";

type PersistedCodexProjectAccountReservation = {
  readonly schemaVersion: typeof reservationSchemaVersion;
  readonly accountId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

type CodexProjectSharedAccountReservation = {
  readonly recoveryPending?: WorkerAccountRecoveryPreparation;
  readonly mode: "shared";
  readonly accountId: string;
  readonly launch: CodexGoalLaunchInput;
};

type CodexProjectExclusiveAccountReservation = {
  readonly recoveryPending?: WorkerAccountRecoveryPreparation;
  readonly mode: "exclusive";
  readonly accountId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly launch: CodexGoalLaunchInput;
};

export type CodexProjectAccountReservation =
  | CodexProjectSharedAccountReservation
  | CodexProjectExclusiveAccountReservation;

/** Historical supported selection, never a live lease or permission to retry.
 * Only the original returned launch object carries this single-use authority. */
export type CodexProjectReservedLaunchAuthority = Readonly<{
  manifestSha256: string; sourceConfigSha256: string; reservedConfigSha256: string;
  selectedAccountSha256: string; accountId: string; maxAccountCycles: number; fresh: boolean;
}>;
const reservedLaunchAuthorities = new WeakMap<CodexGoalLaunchInput, CodexProjectReservedLaunchAuthority>();
const reservedAccountReceipts = new WeakMap<CodexGoalLaunchInput, PersistedCodexProjectAccountReservation | null>();
export const codexProjectReservationValueSha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function assertCodexProjectReservedLaunchAuthority(input: {
  readonly manifest: CodexGoalJobManifest; readonly sourceLaunch: CodexGoalLaunchInput; readonly reservedLaunch: CodexGoalLaunchInput;
}): CodexProjectReservedLaunchAuthority {
  const authority = reservedLaunchAuthorities.get(input.reservedLaunch);
  if (!authority || codexProjectReservationValueSha256(input.manifest) !== authority.manifestSha256 ||
      codexProjectReservationValueSha256(input.sourceLaunch.config) !== authority.sourceConfigSha256 ||
      codexProjectReservationValueSha256(input.reservedLaunch.config) !== authority.reservedConfigSha256 ||
      input.reservedLaunch.config.accounts.length !== 1 || input.reservedLaunch.config.accounts[0]?.name !== authority.accountId ||
      codexProjectReservationValueSha256(input.reservedLaunch.config.accounts[0]) !== authority.selectedAccountSha256 ||
      input.reservedLaunch.config.maxAccountCycles !== authority.maxAccountCycles) {
    throw new Error("project_control_reserved_launch_authority_invalid");
  }
  return authority;
}
export function consumeCodexProjectReservedLaunchAuthority(input: Parameters<typeof assertCodexProjectReservedLaunchAuthority>[0]): CodexProjectReservedLaunchAuthority {
  const authority = assertCodexProjectReservedLaunchAuthority(input);
  reservedLaunchAuthorities.delete(input.reservedLaunch);
  return authority;
}

/** Must run under the reacquired workspace lease, before publication. */
export async function assertCodexProjectReservedAccountReceiptCurrent(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly reservedLaunch: CodexGoalLaunchInput;
}): Promise<void> {
  const expected = reservedAccountReceipts.get(input.reservedLaunch);
  if (expected === undefined || (expected !== null &&
    JSON.stringify(await readReservation(codexProjectAccountReservationPath(input.manifest))) !== JSON.stringify(expected))) {
    throw new Error("project_control_account_reservation_changed_before_start");
  }
}

/** Only the original exclusive reservation qualifies this extra fresh-job leaf.
 * Shared/unreserved launches grant no leaf; changed exclusive receipts deny. */
export function codexProjectReservedAccountReceiptArtifactPath(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly reservedLaunch: CodexGoalLaunchInput;
}): string | undefined {
  const expected = reservedAccountReceipts.get(input.reservedLaunch);
  if (expected === undefined || expected === null) return undefined;
  const authority = reservedLaunchAuthorities.get(input.reservedLaunch);
  if (!authority?.fresh || codexProjectReservationValueSha256(input.manifest) !== authority.manifestSha256 ||
      codexProjectReservationValueSha256(input.reservedLaunch.config) !== authority.reservedConfigSha256) {
    throw new Error("project_control_account_reservation_changed_before_start");
  }
  const path = codexProjectAccountReservationPath(input.manifest);
  const root = researchDirectoryIdentity(input.manifest.jobRootDir), before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o7777) !== 0o600 || before.size > 64 * 1024) {
    throw new Error("project_control_account_reservation_changed_before_start");
  }
  const bytes = researchPromptBytes(root, path), after = lstatSync(path);
  if (!(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"] as const).every(key => before[key] === after[key]) ||
      bytes.toString("utf8") !== reservationBytes(expected)) {
    throw new Error("project_control_account_reservation_changed_before_start");
  }
  return path;
}

export type CodexProjectAccountReservationDeps = {
  readonly capacityStore?: WorkerAccountCapacityStore;
  readonly leaseStore?: WorkerAccountLeaseStore;
  readonly leaseMode?: CodexProjectAccountLeaseMode;
  readonly now?: Date;
};

export function codexProjectAccountLeaseMode(
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): CodexProjectAccountLeaseMode {
  const configured = sourceEnv[exclusiveLeaseFlag]?.trim();
  // Hosted Codex auth refresh is disabled, so an account identity is safe to
  // share across jobs. Exclusive leases remain opt-in for mutable auth homes.
  if (configured === undefined || configured === "" || configured === "0") {
    return "shared";
  }
  if (configured === "1") return "exclusive";
  throw new Error("project_control_account_exclusive_leases_flag_invalid");
}

export async function reserveCodexProjectAccount(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly excludedAccountIds?: readonly string[];
  readonly continuation?: CodexProjectAccountContinuation;
  readonly deps?: CodexProjectAccountReservationDeps;
}): Promise<CodexProjectAccountReservation> {
  assertCodexProjectAccountModelBackend(input);
  const manifestSha256 = codexProjectReservationValueSha256(input.manifest);
  const sourceConfigSha256 = codexProjectReservationValueSha256(input.launch.config);
  const maxAccountCycles = reservedAttemptBudget(input);
  const leaseMode = input.deps?.leaseMode ?? codexProjectAccountLeaseMode();
  let releaseRefusedReservation: (() => Promise<void>) | undefined;
  try {
    const reservation = leaseMode === "shared"
      ? await selectSharedCodexProjectAccount(input, maxAccountCycles)
      : await reserveExclusiveCodexProjectAccount(input, maxAccountCycles,
        release => { releaseRefusedReservation = release; });
    // Awaited capacity/lease selection must not bless a mutated declared launch.
    if (codexProjectReservationValueSha256(input.manifest) !== manifestSha256 ||
        codexProjectReservationValueSha256(input.launch.config) !== sourceConfigSha256) {
      throw new Error("project_control_reserved_launch_source_changed");
    }
    reservedLaunchAuthorities.set(reservation.launch, Object.freeze({ manifestSha256, sourceConfigSha256,
      reservedConfigSha256: codexProjectReservationValueSha256(reservation.launch.config),
      selectedAccountSha256: codexProjectReservationValueSha256(reservation.launch.config.accounts[0]),
      accountId: reservation.accountId, maxAccountCycles, fresh: input.continuation === undefined }));
    return reservation;
  } catch (error) {
    try { await releaseRefusedReservation?.(); }
    catch { /* Keep the original refusal; a retained receipt preserves cleanup uncertainty. */ }
    throw error;
  }
}

async function reserveExclusiveCodexProjectAccount(
  input: {
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
    readonly excludedAccountIds?: readonly string[];
    readonly continuation?: CodexProjectAccountContinuation;
    readonly deps?: CodexProjectAccountReservationDeps;
  },
  maxAccountCycles: number,
  retainRefusalCleanup: (release: () => Promise<void>) => void,
): Promise<CodexProjectExclusiveAccountReservation> {
  const now = new Date((input.deps?.now ?? new Date()).getTime());
  const ownerId = input.manifest.jobId;
  const ttlMs = Math.max(
    reservationGraceMs,
    (input.launch.config.taskTimeoutMs ?? 0) + reservationGraceMs,
  );
  const leaseStore =
    input.deps?.leaseStore ??
    codexProjectAccountLeaseStore(input.launch.config.authRootDir);
  const receiptPath = codexProjectAccountReservationPath(input.manifest);
  const retainReceipt = (receipt: PersistedCodexProjectAccountReservation): void => {
    retainRefusalCleanup(async () => {
      // A changed receipt is not authority to release a successor reservation.
      const matches = async () => JSON.stringify(await readReservation(receiptPath)) === JSON.stringify(receipt);
      if (!await matches()) return;
      await leaseStore.release({ leaseId: receipt.leaseId, ownerId,
        reason: "reserved_launch_refused", now });
      if (await matches()) await rm(receiptPath, { force: true });
    });
  };
  const existing = await readReservation(receiptPath);
  const eligibleAccountIds = projectEligibleAccountIds(input);
  if (
    existing &&
    eligibleAccountIds.includes(existing.accountId)
  ) {
    const renewed = await leaseStore.renew({
      leaseId: existing.leaseId,
      ownerId,
      ttlMs,
      now,
    });
    if (renewed.status === "renewed") {
      const receipt = receiptFromLease(renewed.lease);
      await writeReservation(receiptPath, receipt);
      retainReceipt(receipt);
      return reservationResult(input.launch, receipt, maxAccountCycles);
    }
  }
  if (existing) {
    await leaseStore.release({
      leaseId: existing.leaseId,
      ownerId,
      reason: "account_excluded_from_continuation",
      now,
    });
    await rm(receiptPath, { force: true });
  }

  const capacityStore =
    input.deps?.capacityStore ??
    codexAccountCapacityStore(input.launch.config.authRootDir, {
      ...(input.launch.config.modelBackend === undefined ? {} : { modelBackend: input.launch.config.modelBackend }),
      authJsonPaths: Object.fromEntries(
        input.launch.config.accounts.flatMap((account) =>
          account.authJsonPath ? [[account.name, account.authJsonPath]] : [],
        ),
      ),
    });
  const recoveryPending = prepareProjectRecovery(input, capacityStore, now);
  if (recoveryPending) {
    for (const accountId of eligibleAccountIds) {
      const acquired = await leaseStore.acquire({ accountId, ownerId, ttlMs, now });
      if (acquired.status !== "granted") continue;
      const receipt = receiptFromLease(acquired.lease);
      try { await writeReservation(receiptPath, receipt); }
      catch (error) {
        await leaseStore.release({ leaseId: acquired.lease.leaseId, ownerId, reason: "reservation_receipt_write_failed", now });
        throw error;
      }
      retainReceipt(receipt);
      return { ...reservationResult(input.launch, receipt, maxAccountCycles), recoveryPending };
    }
    throw new Error("project_control_account_reservation_unavailable");
  }
  const selection = await new SelectRuntimeAccountUseCase().execute({
    allowedAccounts: eligibleAccountIds,
    demand: projectAccountDemand(input.launch),
    leaseDemand: null,
    ownerId,
    leaseTtlMs: ttlMs,
    capacityStore,
    leaseStore,
    now,
  });
  if (selection.type === "all_unavailable") {
    const retryAt = selection.waitPlan.waitUntil?.toISOString();
    throw new Error(
      retryAt
        ? `project_control_account_reservation_unavailable_until:${retryAt}`
        : "project_control_account_reservation_unavailable",
    );
  }
  const receipt = receiptFromLease(selection.lease);
  try {
    await writeReservation(receiptPath, receipt);
  } catch (error) {
    await leaseStore.release({
      leaseId: selection.lease.leaseId,
      ownerId,
      reason: "reservation_receipt_write_failed",
      now,
    });
    throw error;
  }
  retainReceipt(receipt);
  return reservationResult(input.launch, receipt, maxAccountCycles);
}

async function selectSharedCodexProjectAccount(
  input: {
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
    readonly excludedAccountIds?: readonly string[];
    readonly continuation?: CodexProjectAccountContinuation;
    readonly deps?: CodexProjectAccountReservationDeps;
  },
  maxAccountCycles: number,
): Promise<CodexProjectSharedAccountReservation> {
  const now = input.deps?.now ?? new Date();
  const capacityStore =
    input.deps?.capacityStore ??
    codexAccountCapacityStore(input.launch.config.authRootDir, {
      ...(input.launch.config.modelBackend === undefined ? {} : { modelBackend: input.launch.config.modelBackend }),
      authJsonPaths: Object.fromEntries(
        input.launch.config.accounts.flatMap((account) =>
          account.authJsonPath ? [[account.name, account.authJsonPath]] : [],
        ),
      ),
    });
  const demand = projectAccountDemand(input.launch);
  const unavailable: Array<{
    accountId: string;
    reason: string;
    waitUntil?: Date;
  }> = [];
  const eligible = selectableWorkerAccountIds(
    projectEligibleAccountIds(input),
    undefined,
  );
  const accounts = input.manifest.accountSelectionMode ===
      CodexGoalAccountSelectionMode.Explicit
    ? eligible
    : stableSharedAccountOrder(eligible, input.manifest.jobId);

  for (const accountId of accounts) {
    const pending = prepareProjectRecovery(input, capacityStore, now);
    if (pending) return { ...sharedReservationResult(input.launch, accountId, maxAccountCycles), recoveryPending: pending };
    const capacity = capacityStore.read({ accountId, demand, now });
    if (capacity && capacity.availability !== "available") {
      unavailable.push({
        accountId,
        reason: capacity.reason ?? capacity.availability,
        ...(capacity.cooldownUntil
          ? { waitUntil: capacity.cooldownUntil }
          : {}),
      });
      continue;
    }
    return sharedReservationResult(
      input.launch,
      accountId,
      maxAccountCycles,
    );
  }

  const waitPlan = buildRuntimeAccountWaitPlan(unavailable, now);
  const retryAt = waitPlan.waitUntil?.toISOString();
  throw new Error(
    retryAt
      ? `project_control_account_reservation_unavailable_until:${retryAt}`
      : "project_control_account_reservation_unavailable",
  );
}

export async function codexProjectContinuationReservationInput(input: {
  readonly status: Pick<
    CodexGoalStatus,
    | "recommendedAction"
    | "resultReason"
    | "progressResultReason"
    | "progressAttemptCount"
    | "progressCurrentAccount"
  >;
  readonly launch: CodexGoalLaunchInput;
  readonly journal: Pick<AttemptJournal, "readTask">;
  readonly verifiedPrewarmBeforeAttemptContinuation?: boolean;
}): Promise<{
  readonly excludedAccountIds: readonly string[];
  readonly continuation?: CodexProjectAccountContinuation;
}> {
  const failureReason = capacityContinuationFailureReason(input.status);
  if (!failureReason) {
    const task = await input.journal.readTask({
      taskId: input.launch.config.taskId,
    });
    const reconnectContinuation = reconnectRuntimeContinuationAttemptHistory({
      status: input.status,
      taskId: input.launch.config.taskId,
      workspacePath: input.launch.config.workspacePath,
      launchAccountIds: input.launch.config.accounts.map(
        (account) => account.name,
      ),
      task,
    });
    if (reconnectContinuation) return reconnectContinuation;
    if (!input.verifiedPrewarmBeforeAttemptContinuation) {
      return { excludedAccountIds: [] };
    }
    return prewarmContinuationAttemptHistory({
      status: input.status,
      taskId: input.launch.config.taskId,
      workspacePath: input.launch.config.workspacePath,
      launchAccountIds: input.launch.config.accounts.map(
        (account) => account.name,
      ),
      task,
    });
  }
  return continuationAttemptHistory({
    status: input.status,
    failureReason,
    taskId: input.launch.config.taskId,
    workspacePath: input.launch.config.workspacePath,
    launchAccountIds: input.launch.config.accounts.map(
      (account) => account.name,
    ),
    task: await input.journal.readTask({ taskId: input.launch.config.taskId }),
  });
}

function prewarmContinuationAttemptHistory(input: {
  readonly status: Pick<
    CodexGoalStatus,
    | "resultReason"
    | "progressResultReason"
    | "progressAttemptCount"
    | "progressCurrentAccount"
  >;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly launchAccountIds: readonly string[];
  readonly task: SafeExecutionTaskRecord | null;
}): {
  readonly excludedAccountIds: readonly string[];
  readonly continuation?: CodexProjectAccountContinuation;
} {
  if (!input.task || input.task.attempts.length === 0) {
    return { excludedAccountIds: [] };
  }
  const lastAttempt = input.task.attempts.at(-1);
  const failedAccountId = lastAttempt?.accountId;
  if (
    !lastAttempt ||
    input.status.resultReason !== "unknown_error" ||
    (input.status.progressResultReason !== undefined &&
      input.status.progressResultReason !== "unknown_error") ||
    input.task.status !== "partial" ||
    input.task.taskId !== input.taskId ||
    input.task.workspacePath !== input.workspacePath ||
    input.task.provider !== "codex" ||
    input.task.lastFailureReason !== "unknown_error" ||
    lastAttempt.taskId !== input.taskId ||
    lastAttempt.provider !== "codex" ||
    lastAttempt.attemptNumber !== input.task.attempts.length ||
    lastAttempt.status !== "blocked" ||
    lastAttempt.failureReason !== "unknown_error" ||
    !lastAttempt.finishedAt ||
    lastAttempt.workspaceDirtyBefore !== true ||
    lastAttempt.workspaceDirtyAfter !== true ||
    !failedAccountId ||
    !input.launchAccountIds.includes(failedAccountId)
  ) {
    throw new Error("project_control_prewarm_attempt_history_required");
  }
  if (
    (input.status.progressAttemptCount !== undefined &&
      input.status.progressAttemptCount !== input.task.attempts.length) ||
    (input.status.progressCurrentAccount !== undefined &&
      input.status.progressCurrentAccount !== failedAccountId)
  ) {
    throw new Error("project_control_prewarm_attempt_history_mismatch");
  }
  return {
    excludedAccountIds: [failedAccountId],
    continuation: { previousAttemptCount: input.task.attempts.length },
  };
}

const APP_SERVER_RECONNECT_TIMEOUT_PREFIX =
  "codex_app_server_reconnect_timeout:";

type ProvenCapacityContinuationFailureReason =
  | "account_unavailable"
  | "capacity_unavailable"
  | "quota_limited";

function capacityContinuationFailureReason(status: Pick<
  CodexGoalStatus,
  "recommendedAction" | "resultReason" | "progressResultReason"
>): ProvenCapacityContinuationFailureReason | undefined {
  if (status.recommendedAction !== "continue_after_capacity") return undefined;
  if (
    status.resultReason &&
    status.progressResultReason &&
    status.resultReason !== status.progressResultReason
  ) {
    throw new Error("project_control_continuation_attempt_history_mismatch");
  }
  const resultReason = provenCapacityContinuationFailureReason(
    status.resultReason,
  );
  const progressReason = provenCapacityContinuationFailureReason(
    status.progressResultReason,
  );
  return resultReason ?? progressReason;
}

function provenCapacityContinuationFailureReason(
  value: string | undefined,
): ProvenCapacityContinuationFailureReason | undefined {
  return value === "account_unavailable" ||
    value === "capacity_unavailable" ||
    value === "quota_limited"
    ? value
    : undefined;
}

function continuationAttemptHistory(input: {
  readonly status: Pick<
    CodexGoalStatus,
    "progressAttemptCount" | "progressCurrentAccount"
  >;
  readonly failureReason: ProvenCapacityContinuationFailureReason;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly launchAccountIds: readonly string[];
  readonly task: SafeExecutionTaskRecord | null;
}): {
  readonly excludedAccountIds: readonly string[];
  readonly continuation: CodexProjectAccountContinuation;
} {
  const lastAttempt = input.task?.attempts.at(-1);
  if (
    !input.task ||
    !lastAttempt ||
    input.task.taskId !== input.taskId ||
    input.task.workspacePath !== input.workspacePath ||
    input.task.provider !== "codex" ||
    lastAttempt.taskId !== input.taskId ||
    lastAttempt.provider !== "codex" ||
    lastAttempt.attemptNumber !== input.task.attempts.length ||
    lastAttempt.status !== "blocked" ||
    !lastAttempt.finishedAt ||
    input.task.lastFailureReason !== input.failureReason ||
    lastAttempt.failureReason !== input.failureReason
  ) {
    throw new Error("project_control_continuation_attempt_history_required");
  }
  const failedAccountId =
    lastAttempt.accountId ??
    (input.launchAccountIds.length === 1
      ? input.launchAccountIds[0]
      : undefined);
  if (!failedAccountId && input.failureReason !== "capacity_unavailable") {
    throw new Error("project_control_continuation_attempt_history_required");
  }
  if (
    (input.status.progressAttemptCount !== undefined &&
      input.status.progressAttemptCount !== input.task.attempts.length) ||
    (input.status.progressCurrentAccount !== undefined &&
      input.status.progressCurrentAccount !== failedAccountId)
  ) {
    throw new Error("project_control_continuation_attempt_history_mismatch");
  }
  return {
    excludedAccountIds: failedAccountId ? [failedAccountId] : [],
    continuation: { previousAttemptCount: input.task.attempts.length },
  };
}

function reconnectRuntimeContinuationAttemptHistory(input: {
  readonly status: Pick<
    CodexGoalStatus,
    | "resultReason"
    | "progressResultReason"
    | "progressAttemptCount"
    | "progressCurrentAccount"
  >;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly launchAccountIds: readonly string[];
  readonly task: SafeExecutionTaskRecord | null;
}):
  | {
      readonly excludedAccountIds: readonly string[];
      readonly continuation: CodexProjectAccountContinuation;
    }
  | undefined {
  if (
    input.status.resultReason !== "unknown_error" ||
    (input.status.progressResultReason !== undefined &&
      input.status.progressResultReason !== "unknown_error")
  ) {
    return undefined;
  }
  const lastAttempt = input.task?.attempts.at(-1);
  if (
    !input.task ||
    !lastAttempt ||
    input.task.status !== "partial" ||
    input.task.taskId !== input.taskId ||
    input.task.workspacePath !== input.workspacePath ||
    input.task.provider !== "codex" ||
    input.task.lastFailureReason !== "unknown_error" ||
    !appServerReconnectTimeout(input.task.lastFailureDetails) ||
    lastAttempt.taskId !== input.taskId ||
    lastAttempt.provider !== "codex" ||
    lastAttempt.attemptNumber !== input.task.attempts.length ||
    lastAttempt.status !== "blocked" ||
    lastAttempt.failureReason !== "unknown_error" ||
    !lastAttempt.finishedAt ||
    lastAttempt.workspaceDirtyBefore !== true ||
    lastAttempt.workspaceDirtyAfter !== true ||
    !appServerReconnectTimeout(lastAttempt.failureDetails)
  ) {
    return undefined;
  }
  const failedAccountId =
    lastAttempt.accountId ??
    (input.launchAccountIds.length === 1
      ? input.launchAccountIds[0]
      : undefined);
  if (
    (input.status.progressAttemptCount !== undefined &&
      input.status.progressAttemptCount !== input.task.attempts.length) ||
    (input.status.progressCurrentAccount !== undefined &&
      input.status.progressCurrentAccount !== failedAccountId)
  ) {
    throw new Error("project_control_runtime_retry_attempt_history_mismatch");
  }
  return {
    excludedAccountIds: [],
    continuation: { previousAttemptCount: input.task.attempts.length },
  };
}

function appServerReconnectTimeout(
  details: Readonly<Record<string, string>> | undefined,
): boolean {
  return (
    typeof details?.rawCause === "string" &&
    directCodexAppServerFailureCause(details.rawCause).startsWith(
      APP_SERVER_RECONNECT_TIMEOUT_PREFIX,
    )
  );
}

export type CodexProjectAccountContinuation = {
  readonly previousAttemptCount: number;
};

export async function releaseCodexProjectAccount(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly reason: string;
  readonly deps?: Pick<
    CodexProjectAccountReservationDeps,
    "leaseStore" | "now"
  >;
}): Promise<boolean> {
  const receiptPath = codexProjectAccountReservationPath(input.manifest);
  const receipt = await readReservation(receiptPath);
  if (!receipt) return false;
  const expected = reservedAccountReceipts.get(input.launch);
  // A returned shared launch owns no receipt; an exclusive launch can release
  // only its original receipt. Callers retain the workspace lease for cleanup.
  if (expected === null || (expected !== undefined && JSON.stringify(receipt) !== JSON.stringify(expected))) return false;
  const leaseStore =
    input.deps?.leaseStore ??
    codexProjectAccountLeaseStore(input.launch.config.authRootDir);
  await leaseStore.release({
    leaseId: receipt.leaseId,
    ownerId: input.manifest.jobId,
    reason: input.reason,
    now: input.deps?.now ?? new Date(),
  });
  if (JSON.stringify(await readReservation(receiptPath)) === JSON.stringify(receipt)) {
    await rm(receiptPath, { force: true });
  }
  return true;
}

export function codexProjectAccountReservationPath(
  manifest: CodexGoalJobManifest,
): string {
  return join(manifest.jobRootDir, "account-reservation.json");
}

function codexProjectAccountLeaseStore(
  authRootDir: string,
): WorkerAccountLeaseStore {
  const capacityRoot = codexAccountCapacityRootDir(authRootDir);
  return new LocalFileWorkerAccountLeaseStore({
    rootDir: join(
      dirname(dirname(capacityRoot)),
      ".subscription-runtime-account-leases",
      basename(capacityRoot),
    ),
  });
}

function reservationResult(
  launch: CodexGoalLaunchInput,
  receipt: PersistedCodexProjectAccountReservation,
  maxAccountCycles: number,
): CodexProjectExclusiveAccountReservation {
  const account = launch.config.accounts.find(
    (candidate) => candidate.name === receipt.accountId,
  );
  if (!account) throw new Error("project_control_reserved_account_missing");
  const reservedLaunch = {
    ...launch,
    config: { ...launch.config, accounts: [account], maxAccountCycles },
  };
  reservedAccountReceipts.set(reservedLaunch, Object.freeze({ ...receipt }));
  return {
    mode: "exclusive",
    accountId: receipt.accountId,
    fencingToken: receipt.fencingToken,
    acquiredAt: receipt.acquiredAt,
    expiresAt: receipt.expiresAt,
    launch: reservedLaunch,
  };
}

function sharedReservationResult(
  launch: CodexGoalLaunchInput,
  accountId: string,
  maxAccountCycles: number,
): CodexProjectSharedAccountReservation {
  const account = launch.config.accounts.find(
    (candidate) => candidate.name === accountId,
  );
  if (!account) throw new Error("project_control_reserved_account_missing");
  const reservedLaunch = {
    ...launch,
    config: { ...launch.config, accounts: [account], maxAccountCycles },
  };
  reservedAccountReceipts.set(reservedLaunch, null);
  return {
    mode: "shared",
    accountId,
    launch: reservedLaunch,
  };
}

function reservedAttemptBudget(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly continuation?: CodexProjectAccountContinuation;
}): number {
  if (!input.continuation) return 1;
  if (!Number.isInteger(input.continuation.previousAttemptCount) ||
    input.continuation.previousAttemptCount < 1) {
    throw new Error("project_control_continuation_attempt_count_required");
  }
  const previousAttemptCount = input.continuation.previousAttemptCount;
  // This broker call authorizes exactly one more provider attempt. The launch
  // maxAccountCycles value bounds one runner invocation; it is not a lifetime
  // retry policy for an externally authorized capacity continuation.
  return previousAttemptCount + 1;
}

function prepareProjectRecovery(input: { launch: CodexGoalLaunchInput; continuation?: CodexProjectAccountContinuation },
  store: WorkerAccountCapacityStore, now: Date): WorkerAccountRecoveryPreparation | undefined {
  return input.launch.config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
    input.continuation === undefined && input.launch.config.prewarmOnStart !== true
    ? store.prepareTaskRecovery?.({ demand: projectAccountDemand(input.launch), now }) : undefined;
}

function projectAccountDemand(
  launch: CodexGoalLaunchInput,
): WorkerRuntimeDemand {
  return {
    provider: "codex",
    ...(launch.config.model ? { model: launch.config.model } : {}),
    ...(launch.config.reasoningEffort
      ? { reasoningEffort: launch.config.reasoningEffort }
      : {}),
    ...(launch.config.serviceTier
      ? { serviceTier: launch.config.serviceTier }
      : {}),
  };
}

function projectEligibleAccountIds(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly excludedAccountIds?: readonly string[];
}): readonly string[] {
  const configured = input.launch.config.accounts.map(
    (account) => account.name,
  );
  // A single configured account remains eligible after its capacity recovers.
  // With alternatives available, continue rotating away from the last failure.
  const excluded = new Set(
    configured.length === 1 ? [] : (input.excludedAccountIds ?? []),
  );
  const eligible = configured
    .filter((accountId) => !excluded.has(accountId));
  if (eligible.length === 0) {
    throw new Error("project_control_account_reservation_no_eligible_accounts");
  }
  return eligible;
}

function assertCodexProjectAccountModelBackend(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
}): void {
  const manifestBackend =
    input.manifest.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  const launchBackend =
    input.launch.config.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  if (manifestBackend !== launchBackend) {
    throw new Error("codex_goal_project_account_mixed_model_backend");
  }

  const configuredNames = new Set(
    input.launch.config.accounts.map((account) => account.name),
  );
  const mimoNames = new Set(
    (input.launch.config.mimoAccounts ?? []).map((account) => account.name),
  );
  if (
    launchBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
    [...mimoNames].some((name) => !configuredNames.has(name))
  ) {
    throw new Error("codex_goal_project_account_mixed_model_backend");
  }

  for (const account of input.launch.config.accounts) {
    const hasMimoCredentialMetadata =
      account.envVarName !== undefined ||
      mimoNames.has(account.name) ||
      account.authJsonPath?.startsWith("mimo-env:") === true;
    if (
      launchBackend === CodexModelBackend.XiaomiMimoTokenPlan
        ? account.authJsonPath !== undefined &&
          !account.authJsonPath.startsWith("mimo-env:")
        : hasMimoCredentialMetadata
    ) {
      throw new Error("codex_goal_project_account_mixed_model_backend");
    }
  }
}

function stableSharedAccountOrder(
  accounts: readonly string[],
  ownerId: string,
): readonly string[] {
  if (accounts.length < 2) return accounts;
  let hash = 0;
  for (const character of ownerId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const offset = hash % accounts.length;
  return [...accounts.slice(offset), ...accounts.slice(0, offset)];
}

function receiptFromLease(lease: {
  readonly accountId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}): PersistedCodexProjectAccountReservation {
  return {
    schemaVersion: reservationSchemaVersion,
    accountId: lease.accountId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
  };
}

async function readReservation(
  path: string,
): Promise<PersistedCodexProjectAccountReservation | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.schemaVersion !== reservationSchemaVersion) {
      throw new Error("project_control_account_reservation_invalid");
    }
    const receipt: PersistedCodexProjectAccountReservation = {
      schemaVersion: reservationSchemaVersion,
      accountId: requiredText(value.accountId),
      leaseId: requiredText(value.leaseId),
      fencingToken: requiredPositiveInteger(value.fencingToken),
      acquiredAt: requiredIsoDate(value.acquiredAt),
      expiresAt: requiredIsoDate(value.expiresAt),
    };
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeReservation(
  path: string,
  receipt: PersistedCodexProjectAccountReservation,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(stagingPath, reservationBytes(receipt), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(stagingPath, path);
  } finally {
    await rm(stagingPath, { force: true });
  }
}

function reservationBytes(receipt: PersistedCodexProjectAccountReservation): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("project_control_account_reservation_invalid");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("project_control_account_reservation_invalid");
  }
  return Number(value);
}

function requiredIsoDate(value: unknown): string {
  const text = requiredText(value);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error("project_control_account_reservation_invalid");
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
