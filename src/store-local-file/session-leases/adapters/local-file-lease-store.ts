import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeAtomicLocalFile } from "../../shared/write-atomic-local-file";
import { dirname, join } from "node:path";
import { LocalFileProviderLock } from "../../shared/local-file-provider-lock";
import {
  localFileLeaseStoreCapabilities,
  localFileLeaseStoreStorageVersion as storageVersion,
} from "../domain/local-file-lease-store-policy";
import type {
  FinalizedLease,
  LeaseAcquireResult,
  LeaseStoreCapabilities,
  LeaseStorePort,
  WritebackCommitResult,
} from "../ports/lease-store-contracts";

export { localFileLeaseStoreCapabilities } from "../domain/local-file-lease-store-policy";

export type LocalFileLeaseStoreOptions = {
  readonly rootDir: string;
  readonly now?: () => Date;
  readonly lockTtlMs?: number;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockPollMs?: number;
  /** Factory composition requires evidence of a persisted session write. */
  readonly requireSessionReceipt?: boolean;
};

type LeaseState =
  | "active"
  | "finalized"
  | "writeback_started"
  | "committed"
  | "released";

type PersistedLeaseRecord = {
  readonly storageVersion: typeof storageVersion;
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly restoredGenerationHash: string;
  readonly state: LeaseState;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly finalizedAt?: string;
  readonly writebackStartedAt?: string;
  readonly committedAt?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
  readonly keyId?: string;
  readonly nextGenerationHash?: string;
  readonly idempotencyKey?: string;
  readonly persistedWrite?: {
    readonly generationHash: string;
    readonly idempotencyKey: string;
  };
};

type LocalFileSessionWriteGuard = {
  readonly authorize: (input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
    readonly bootstrap: boolean;
    readonly requireLease: boolean;
  }) => Promise<void>;
  readonly recordReceipt: (input: {
    readonly leaseId: string;
    readonly generationHash: string;
    readonly idempotencyKey: string;
  }) => Promise<void>;
};
type LocalFileSessionTransaction = <T>(providerInstanceId: string, operation: (guard: LocalFileSessionWriteGuard) => Promise<T>) => Promise<T>;
const sessionTransactions = new WeakMap<LocalFileLeaseStore, LocalFileSessionTransaction>();

/** Internal adapter composition; deliberately not exported from package entrypoints. */
export function withLocalFileSessionWriteTransaction<T>(
  store: LocalFileLeaseStore,
  providerInstanceId: string,
  operation: (guard: LocalFileSessionWriteGuard) => Promise<T>,
): Promise<T> {
  const transaction = sessionTransactions.get(store);
  if (!transaction) throw new Error("local_file_session_transaction_unavailable");
  return transaction(providerInstanceId, operation);
}

export class LocalFileLeaseStore implements LeaseStorePort {
  readonly leaseStoreId = localFileLeaseStoreCapabilities.leaseStoreId;
  readonly capabilities: LeaseStoreCapabilities = localFileLeaseStoreCapabilities;

  constructor(private readonly options: LocalFileLeaseStoreOptions) {
    sessionTransactions.set(this, (providerInstanceId, operation) => this.#withSessionWriteTransaction(providerInstanceId, operation));
  }

  async acquire(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly ttlMs: number;
    readonly restoredGenerationHash: string;
  }): Promise<LeaseAcquireResult> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("local_file_lease_invalid_ttl");
    }

    return this.withProviderLock(input.providerInstanceId, async () => {
      const now = this.now();
      const active = await this.readActive(input.providerInstanceId);
      if (active && !isExpired(active, now)) {
        if (active.restoredGenerationHash !== input.restoredGenerationHash) {
          return {
            status: "stale",
            safeMessage:
              "A newer provider session generation is already leased.",
          };
        }
        return {
          status: "denied",
          safeMessage: "Provider session refresh is already leased.",
        };
      }

      if (active) {
        await this.removeActiveIfMatchesLocked(active);
      }

      const record = makeLeaseRecord({
        providerInstanceId: input.providerInstanceId,
        runId: input.runId,
        attempt: input.attempt,
        restoredGenerationHash: input.restoredGenerationHash,
        now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      });

      await this.writeLeaseRecord(record, { exclusive: true });
      try {
        await this.writeActiveRecord(record, { exclusive: true });
      } catch (error) {
        await rm(this.leaseRecordPath(record.leaseId), { force: true });
        if (isAlreadyExistsError(error)) {
          return {
            status: "denied",
            safeMessage: "Provider session refresh is already leased.",
          };
        }
        throw error;
      }

      return {
        status: "granted",
        leaseId: record.leaseId,
        expiresAt: new Date(record.expiresAt),
      };
    });
  }

  async finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }): Promise<FinalizedLease> {
    const initial = await this.requireLeaseRecord(input.leaseId);
    return this.withProviderLock(initial.providerInstanceId, async () => {
      const record = await this.requireLeaseRecord(input.leaseId);
      if (record.restoredGenerationHash !== input.restoredGenerationHash) {
        throw new Error("local_file_lease_generation_hash_mismatch");
      }
      if (record.state === "committed" || record.persistedWrite) {
        return {
          leaseId: record.leaseId,
          restoredGenerationHash: record.restoredGenerationHash,
        };
      }
      await this.assertCurrentLeaseLocked(record);
      if (record.state === "finalized" || record.state === "writeback_started") {
        return { leaseId: record.leaseId, restoredGenerationHash: record.restoredGenerationHash };
      }

      await this.persistLeaseTransitionLocked({
        ...record,
        state: "finalized",
        finalizedAt: this.now().toISOString(),
      });

      return {
        leaseId: record.leaseId,
        restoredGenerationHash: record.restoredGenerationHash,
      };
    });
  }

  async markWritebackStarted(input: {
    readonly leaseId: string;
    readonly keyId?: string;
  }): Promise<void> {
    const initial = await this.requireLeaseRecord(input.leaseId);
    await this.withProviderLock(initial.providerInstanceId, async () => {
      const record = await this.requireLeaseRecord(input.leaseId);
      if (record.state === "committed" || record.persistedWrite) {
        return;
      }
      await this.assertCurrentLeaseLocked(record);
      if (record.state !== "finalized" && record.state !== "writeback_started") {
        throw new Error("local_file_lease_not_finalized");
      }
      if (record.state === "writeback_started") return;

      await this.persistLeaseTransitionLocked({
        ...record,
        state: "writeback_started",
        writebackStartedAt: this.now().toISOString(),
        ...(input.keyId ? { keyId: input.keyId } : {}),
      });
    });
  }

  async markWritebackCommitted(input: {
    readonly leaseId: string;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
  }): Promise<WritebackCommitResult> {
    const initial = await this.requireLeaseRecord(input.leaseId);
    return this.withProviderLock(initial.providerInstanceId, async () => {
      const record = await this.requireLeaseRecord(input.leaseId);
      if (record.state === "committed") {
        if (
          record.nextGenerationHash === input.nextGenerationHash &&
          record.idempotencyKey === input.idempotencyKey
        ) {
          // A previous attempt may have persisted the committed record and
          // failed before clearing its active pointer. Replay completes that
          // cleanup without disturbing a successor's different lease.
          await this.removeActiveIfMatchesLocked(record);
          return { status: "idempotent_replay" };
        }
        return {
          status: "stale_generation",
          safeMessage:
            "Lease was already committed with different writeback metadata.",
        };
      }

      // A receipt proves the session rename completed while this lease owned
      // the provider transaction. A late acknowledgement is safe even if a new
      // lease now exists; it must never authorize a fresh session mutation.
      if (record.persistedWrite) {
        if (record.persistedWrite.generationHash !== input.nextGenerationHash ||
            record.persistedWrite.idempotencyKey !== input.idempotencyKey) {
          return { status: "stale_generation", safeMessage: "Lease writeback receipt did not match." };
        }
      } else {
        const unchanged = record.state === "finalized" && input.nextGenerationHash === record.restoredGenerationHash;
        if (this.options.requireSessionReceipt && !unchanged) {
          return { status: "stale_generation", safeMessage: "Lease has no persisted writeback receipt." };
        }
        await this.assertCurrentLeaseLocked(record);
        if (record.state !== "writeback_started" && !unchanged) throw new Error("local_file_lease_writeback_not_started");
      }

      const committed = {
        ...record,
        state: "committed" as const,
        committedAt: this.now().toISOString(),
        nextGenerationHash: input.nextGenerationHash,
        idempotencyKey: input.idempotencyKey,
      };
      await this.persistLeaseTransitionLocked(committed);
      await this.removeActiveIfMatchesLocked(committed);
      return { status: "committed" };
    });
  }

  async release(input: {
    readonly leaseId: string;
    readonly reason: string;
  }): Promise<void> {
    const initial = await this.readLeaseRecord(input.leaseId);
    if (!initial) return;
    await this.withProviderLock(initial.providerInstanceId, async () => {
      const record = await this.readLeaseRecord(input.leaseId);
      if (!record || record.state === "committed") {
        return;
      }

      const released = {
        ...record,
        state: "released" as const,
        releasedAt: this.now().toISOString(),
        releaseReason: input.reason,
      };
      await this.persistLeaseTransitionLocked(released);
      await this.removeActiveIfMatchesLocked(released);
    });
  }

  /** Session CAS and lease fencing execute under the same filesystem lock.
   * The receipt is recorded after session publication. If that recording fails,
   * an exact idempotent replay reconstructs it before returning acknowledgement.
   */
  async #withSessionWriteTransaction<T>(
    providerInstanceId: string,
    operation: (guard: LocalFileSessionWriteGuard) => Promise<T>,
  ): Promise<T> {
    return this.withProviderLock(providerInstanceId, () => operation({
      authorize: async (input) => {
        if (input.leaseId.startsWith("local-file-lease:")) {
          const record = await this.requireLeaseRecord(input.leaseId);
          if (record.providerInstanceId !== providerInstanceId) throw new Error("local_file_lease_provider_mismatch");
          await this.assertCurrentLeaseLocked(record);
          if (record.state !== "writeback_started") throw new Error("local_file_lease_writeback_not_started");
          if (record.persistedWrite) throw new Error("local_file_lease_already_written");
          if (record.restoredGenerationHash !== input.restoredGenerationHash) throw new Error("local_file_lease_generation_hash_mismatch");
          return;
        }
        const active = await this.readActive(providerInstanceId);
        if (active && !isExpired(active, this.now())) throw new Error("local_file_lease_unavailable");
        // Initial imports and the established worker seed operation use CAS,
        // and cannot replace the session while any live lease owns it.
        if (input.requireLease && !input.bootstrap && input.leaseId !== "seed-local-file-backend") {
          throw new Error("local_file_lease_not_found");
        }
      },
      recordReceipt: async (input) => {
        if (!input.leaseId.startsWith("local-file-lease:")) return;
        const record = await this.requireLeaseRecord(input.leaseId);
        if (record.providerInstanceId !== providerInstanceId) throw new Error("local_file_lease_provider_mismatch");
        if (record.persistedWrite) {
          if (record.persistedWrite.generationHash !== input.generationHash || record.persistedWrite.idempotencyKey !== input.idempotencyKey) {
            throw new Error("local_file_lease_receipt_conflict");
          }
          return;
        }
        await this.persistLeaseTransitionLocked({
          ...record,
          persistedWrite: { generationHash: input.generationHash, idempotencyKey: input.idempotencyKey },
        });
      },
    }));
  }

  private async assertCurrentLeaseLocked(record: PersistedLeaseRecord): Promise<void> {
    if (record.state === "released" || record.state === "committed" || isExpired(record, this.now())) {
      throw new Error("local_file_lease_expired_or_released");
    }
    const active = await this.readActive(record.providerInstanceId);
    if (active?.leaseId !== record.leaseId) throw new Error("local_file_lease_superseded");
  }

  private async persistLeaseTransitionLocked(
    record: PersistedLeaseRecord,
  ): Promise<void> {
    await this.writeLeaseRecord(record, { exclusive: false });
    const active = await this.readActive(record.providerInstanceId);
    if (active?.leaseId === record.leaseId) {
      await this.writeActiveRecord(record, { exclusive: false });
    }
  }

  private async requireLeaseRecord(
    leaseId: string,
  ): Promise<PersistedLeaseRecord> {
    const record = await this.readLeaseRecord(leaseId);
    if (!record) {
      throw new Error("local_file_lease_not_found");
    }
    return record;
  }

  private async readActive(
    providerInstanceId: string,
  ): Promise<PersistedLeaseRecord | null> {
    return this.readRecord(this.activePath(providerInstanceId));
  }

  private async readLeaseRecord(
    leaseId: string,
  ): Promise<PersistedLeaseRecord | null> {
    return this.readRecord(this.leaseRecordPath(leaseId));
  }

  private async readRecord(path: string): Promise<PersistedLeaseRecord | null> {
    try {
      return parseLeaseRecord(await readFile(path, "utf8"));
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async writeActiveRecord(
    record: PersistedLeaseRecord,
    options: { readonly exclusive: boolean },
  ): Promise<void> {
    await this.writeRecord(
      this.activePath(record.providerInstanceId),
      record,
      options,
    );
  }

  private async writeLeaseRecord(
    record: PersistedLeaseRecord,
    options: { readonly exclusive: boolean },
  ): Promise<void> {
    await this.writeRecord(
      this.leaseRecordPath(record.leaseId),
      record,
      options,
    );
  }

  private async writeRecord(
    path: string,
    record: PersistedLeaseRecord,
    options: { readonly exclusive: boolean },
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    await writeAtomicLocalFile(path, serialized, options.exclusive);
  }

  private async removeActiveIfMatchesLocked(
    record: Pick<PersistedLeaseRecord, "providerInstanceId" | "leaseId">,
  ): Promise<void> {
    const active = await this.readActive(record.providerInstanceId);
    if (active?.leaseId === record.leaseId) {
      await rm(this.activePath(record.providerInstanceId), { force: true });
    }
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.activeDir(), { recursive: true, mode: 0o700 });
    await mkdir(this.leaseRecordDir(), { recursive: true, mode: 0o700 });
    await mkdir(this.lockDir(), { recursive: true, mode: 0o700 });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private activeDir(): string {
    return join(this.options.rootDir, "leases", "active");
  }

  private leaseRecordDir(): string {
    return join(this.options.rootDir, "leases", "records");
  }

  private lockDir(): string {
    return join(this.options.rootDir, "leases", "locks");
  }

  private activePath(providerInstanceId: string): string {
    return join(this.activeDir(), `${hashText(providerInstanceId)}.json`);
  }

  private leaseRecordPath(leaseId: string): string {
    return join(this.leaseRecordDir(), `${hashText(leaseId)}.json`);
  }

  private lockPath(providerInstanceId: string): string {
    return join(this.lockDir(), `${hashText(providerInstanceId)}.lock`);
  }

  private async withProviderLock<T>(
    providerInstanceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureDirs();
    return new LocalFileProviderLock(this.options).run(providerInstanceId, operation);
  }

}

function makeLeaseRecord(input: {
  readonly providerInstanceId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly restoredGenerationHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
}): PersistedLeaseRecord {
  const leaseId = [
    "local-file-lease",
    hashText(
      [
        input.providerInstanceId,
        input.runId,
        String(input.attempt),
        input.restoredGenerationHash,
        randomBytes(16).toString("hex"),
      ].join("\0"),
    ),
  ].join(":");

  return {
    storageVersion,
    leaseId,
    providerInstanceId: input.providerInstanceId,
    runId: input.runId,
    attempt: input.attempt,
    restoredGenerationHash: input.restoredGenerationHash,
    state: "active",
    acquiredAt: input.now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

function parseLeaseRecord(value: string): PersistedLeaseRecord {
  const parsed = JSON.parse(value) as Partial<PersistedLeaseRecord>;
  if (
    parsed.storageVersion !== storageVersion ||
    typeof parsed.leaseId !== "string" ||
    typeof parsed.providerInstanceId !== "string" ||
    typeof parsed.runId !== "string" ||
    typeof parsed.attempt !== "number" ||
    typeof parsed.restoredGenerationHash !== "string" ||
    !isLeaseState(parsed.state) ||
    typeof parsed.acquiredAt !== "string" ||
    typeof parsed.expiresAt !== "string"
  ) {
    throw new Error("local_file_lease_invalid_record");
  }

  return {
    storageVersion,
    leaseId: parsed.leaseId,
    providerInstanceId: parsed.providerInstanceId,
    runId: parsed.runId,
    attempt: parsed.attempt,
    restoredGenerationHash: parsed.restoredGenerationHash,
    state: parsed.state,
    acquiredAt: parsed.acquiredAt,
    expiresAt: parsed.expiresAt,
    ...(typeof parsed.finalizedAt === "string"
      ? { finalizedAt: parsed.finalizedAt }
      : {}),
    ...(typeof parsed.writebackStartedAt === "string"
      ? { writebackStartedAt: parsed.writebackStartedAt }
      : {}),
    ...(typeof parsed.committedAt === "string"
      ? { committedAt: parsed.committedAt }
      : {}),
    ...(typeof parsed.releasedAt === "string"
      ? { releasedAt: parsed.releasedAt }
      : {}),
    ...(typeof parsed.releaseReason === "string"
      ? { releaseReason: parsed.releaseReason }
      : {}),
    ...(typeof parsed.keyId === "string" ? { keyId: parsed.keyId } : {}),
    ...(typeof parsed.nextGenerationHash === "string"
      ? { nextGenerationHash: parsed.nextGenerationHash }
      : {}),
    ...(typeof parsed.idempotencyKey === "string"
      ? { idempotencyKey: parsed.idempotencyKey }
      : {}),
    ...(parsed.persistedWrite && typeof parsed.persistedWrite.generationHash === "string" && typeof parsed.persistedWrite.idempotencyKey === "string"
      ? { persistedWrite: { generationHash: parsed.persistedWrite.generationHash, idempotencyKey: parsed.persistedWrite.idempotencyKey } }
      : {}),
  };
}

function isLeaseState(value: unknown): value is LeaseState {
  return (
    value === "active" ||
    value === "finalized" ||
    value === "writeback_started" ||
    value === "committed" ||
    value === "released"
  );
}

function isExpired(record: PersistedLeaseRecord, now: Date): boolean {
  const expiresAt = new Date(record.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

// Actual fixed composition captures these implementations before any escape.
Object.freeze(LocalFileLeaseStore);
Object.freeze(LocalFileLeaseStore.prototype);
