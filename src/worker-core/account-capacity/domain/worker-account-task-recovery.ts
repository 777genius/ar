import type { WorkerAccountCapacityState } from "./worker-account-capacity-recheck";
import { WorkerAccountCapacityPhase } from "./worker-account-capacity-recheck";
import { workerRuntimeDemandKey, type WorkerRuntimeDemand } from "./worker-account-capacity";

export enum WorkerAccountTaskRecoveryPhase {
  Prepared = "prepared",
  Consumed = "consumed",
  Accepted = "accepted",
  Exempted = "exempted",
  Failed = "failed",
}

export enum WorkerAccountTaskRecoveryBackend {
  XiaomiMimoTokenPlan = "xiaomi-mimo-token-plan",
}

/** Preparation grants neither capacity availability nor permission to dispatch. */
export type WorkerAccountRecoveryPreparation = Readonly<{
  phase: WorkerAccountTaskRecoveryPhase.Prepared;
  recordId: string;
  revision: string;
  recordSha256: string;
  recordSetSha256: string;
  accountId: string;
  demand: WorkerRuntimeDemand;
}>;

export type WorkerAccountRecoveryKey = Readonly<{
  backend: WorkerAccountTaskRecoveryBackend;
  credentialFingerprint: string;
  model: string;
  demand: WorkerRuntimeDemand;
  assertCurrent(): void;
}>;

export type WorkerAccountRecoveryTask = Readonly<{
  jobId: string;
  startId: string;
  specSha256: string;
  requestSha256: string;
  workerId: string;
  runtimeArtifactSha256: string;
}>;

export type WorkerAccountAcceptedResponse = Readonly<{
  credentialFingerprint: string;
  requestedModel: string;
  requestSha256: string;
  responseIdSha256: string;
  completedResponses: number;
  assertCurrent(): void;
  assertDisposed(): void;
}>;

/** Source-issued native authority, never a serialized approval or PID claim. */
export type WorkerAccountRecoveryAuthority = Readonly<{
  task: WorkerAccountRecoveryTask;
  assertCurrent(): void;
  withPublication<T>(effect: () => Promise<T>): Promise<T>;
  assertTerminal(): void;
}>;

const preparedRecoveries = new WeakSet<WorkerAccountRecoveryPreparation>();
export function isWorkerAccountRecoveryPreparation(value: WorkerAccountRecoveryPreparation): boolean { return preparedRecoveries.has(value); }

export function prepareWorkerAccountTaskRecovery(input: {
  state: WorkerAccountCapacityState;
  recordSha256: string;
  recordSetSha256: string;
  demand: WorkerRuntimeDemand;
  now: Date;
}): WorkerAccountRecoveryPreparation | undefined {
  const { state, recordSha256, recordSetSha256, demand, now } = input;
  const reset = state.capacity.cooldownUntil?.getTime();
  if (state.phase !== WorkerAccountCapacityPhase.RecheckDue ||
      state.capacity.reason !== "quota_limited" ||
      !["cooldown", "quota_exhausted"].includes(state.capacity.availability) ||
      reset === undefined || !Number.isFinite(reset) || !Number.isFinite(now.getTime()) || reset > now.getTime() ||
      ![recordSha256, recordSetSha256].every(value => /^[a-f0-9]{64}$/.test(value)) || !state.revision ||
      !workerRuntimeDemandKey(demand) ||
      state.demand && workerRuntimeDemandKey(state.demand) !== workerRuntimeDemandKey(demand)) return;
  const preparation: WorkerAccountRecoveryPreparation = Object.freeze({ phase: WorkerAccountTaskRecoveryPhase.Prepared,
    recordId: state.recordId, revision: state.revision, recordSha256, recordSetSha256,
    accountId: state.accountId, demand: Object.freeze({ ...demand }) });
  preparedRecoveries.add(preparation); return preparation;
}
