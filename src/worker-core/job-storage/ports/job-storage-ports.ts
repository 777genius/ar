import type {
  JobStorageAdmissionReceipt, JobStorageDrainVerification, JobStorageHandoffVerification,
  JobStorageIdentity, JobStorageIntent, JobStorageLayout, JobStorageSettlement, JobStorageProducer,
} from "../domain/job-storage";

export type JobStorageAdmissionRequest = {
  readonly jobId: string;
  readonly generationId: string;
  readonly intent: JobStorageIntent;
  readonly taskId: string;
  readonly attemptId: string;
  readonly producerId: JobStorageProducer;
  readonly providerBindingSha256: string;
  readonly layout: JobStorageLayout;
};
export type JobStorageWriteLease = {
  readonly receipt: JobStorageAdmissionReceipt;
  /** Revalidates the live native pin/write authority, not just receipt bytes. */
  assertCurrent(): void;
  /** Records terminal/uncertain runner exit as RESUMABLE; never issues disposal. */
  observeRunnerTerminal(): Promise<void>;
};
export interface JobStorageAdmissionPort {
  /** Trusted adapter holds shared current-generation write authority across ALL
   * callback filesystem and provider effects, including async writes and cleanup.
   * Resume/close/A2 use the same authority fence and cannot invalidate an in-flight
   * effect. assertCurrent checks alone do not provide this fence. Native lifetime
   * ownership separately spans payload and descendant drain; callback return is
   * not drain. Throw/uncertainty retains both ownership and settlement evidence.
   * No concrete native/shared-authority implementation is supplied here. */
  withAdmittedLifetime<T>(request: JobStorageAdmissionRequest, effect: (lease: JobStorageWriteLease) => Promise<T>): Promise<T>;
}
export interface JobStorageSettlementStore {
  /** Serializable CAS. Undefined effect result leaves the current record intact. */
  update<T>(identity: JobStorageIdentity, expectedRevision: number,
    effect: (current: JobStorageSettlement) => Promise<{ readonly next?: JobStorageSettlement; readonly result: T }>): Promise<T>;
}
export interface JobStorageGenerationAuthority {
  /** Same trusted fence for resume, close, access and later A2 tombstones. */
  withGenerationFence<T>(identity: JobStorageIdentity, effect: () => Promise<T>): Promise<T>;
  verifyNativeDrain(current: JobStorageSettlement, evidenceId: string): Promise<JobStorageDrainVerification>;
}
export interface JobStorageSourceHandoffPort {
  /** Independent durable readback + full restored source/output/evidence coverage.
   * No successful implementation is supplied by the A1 contract checkpoint. */
  verify(current: JobStorageSettlement, handoffId: string): Promise<JobStorageHandoffVerification>;
}
