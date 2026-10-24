import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeAtomicLocalFile } from "../../shared/write-atomic-local-file";
import { dirname, join } from "node:path";
import {
  LocalFileLeaseStore,
  withLocalFileSessionWriteTransaction,
} from "../../session-leases/adapters/local-file-lease-store";
import {
  computeSessionGenerationHash,
} from "@vioxen/subscription-runtime/core";
import {
  assertArtifactFits,
  localEncryptedFileStoreAuthTagBytes as authTagBytes,
  localEncryptedFileStoreCapabilities,
  localEncryptedFileStoreEncryptionAlgorithm as encryptionAlgorithm,
  localEncryptedFileStoreNonceBytes as nonceBytes,
  localEncryptedFileStoreStorageVersion as storageVersion,
  normalizeEncryptionKey,
} from "../domain/local-encrypted-file-store-policy";
import type {
  SessionArtifact,
  SessionEnvelope,
  SessionStorePort,
  SessionWriteResult,
} from "../ports/session-store-contracts";

export { localEncryptedFileStoreCapabilities } from "../domain/local-encrypted-file-store-policy";

export type LocalEncryptedFileStoreOptions = {
  readonly providerId: string;
  readonly rootDir: string;
  readonly encryptionKey: Uint8Array;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly requireLease?: boolean;
  readonly now?: () => Date;
};

type PersistedRecord = {
  readonly storageVersion: typeof storageVersion;
  readonly providerInstanceId: string;
  readonly providerId: string;
  readonly generation: number;
  readonly generationHash: string;
  readonly artifact: {
    readonly kind: SessionArtifact["kind"];
    readonly formatVersion: string;
    readonly contentType: string;
    readonly encryptedBytes: string;
    readonly nonce: string;
    readonly authTag: string;
    readonly algorithm: typeof encryptionAlgorithm;
  };
  readonly metadata: Readonly<Record<string, string>>;
  readonly idempotency: Readonly<Record<string, IdempotencyRecord>>;
};

type IdempotencyRecord = {
  readonly generation: number;
  readonly generationHash: string;
  readonly artifactHash: string;
  readonly requestHash?: string;
};

export class LocalEncryptedFileStore implements SessionStorePort {
  readonly storeId = localEncryptedFileStoreCapabilities.storeId;
  readonly custody = localEncryptedFileStoreCapabilities.custody;
  readonly capabilities = localEncryptedFileStoreCapabilities;
  private readonly encryptionKey: Buffer;
  private readonly leaseStore: LocalFileLeaseStore;

  constructor(private readonly options: LocalEncryptedFileStoreOptions) {
    this.encryptionKey = normalizeEncryptionKey(options.encryptionKey);
    this.leaseStore = new LocalFileLeaseStore({
      rootDir: options.rootDir,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose?: string;
  }): Promise<SessionEnvelope | null> {
    const record = await this.readRecord(input.providerInstanceId);
    if (!record) return null;
    if (record.providerInstanceId !== input.providerInstanceId) {
      throw new Error("local_store_record_boundary_mismatch");
    }
    if (
      input.expectedProviderId &&
      input.expectedProviderId !== record.providerId
    ) {
      return null;
    }

    const artifact = decryptArtifact(record, this.encryptionKey);
    return {
      providerInstanceId: record.providerInstanceId,
      providerId: record.providerId,
      artifact,
      generation: record.generation,
      generationHash: record.generationHash,
      storageVersion: record.storageVersion,
      custody: this.custody,
      metadata: record.metadata,
    };
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<SessionWriteResult> {
    assertArtifactFits(input.nextArtifact);
    if (input.nextArtifact.providerId !== this.options.providerId) {
      throw new Error("provider_id_mismatch");
    }

    // Own the request before waiting for another process so caller mutation
    // cannot change what its idempotency key or generation hash identifies.
    input = {
      ...input,
      nextArtifact: { ...input.nextArtifact, bytes: new Uint8Array(input.nextArtifact.bytes) },
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    };
    const requestHash = hashWriteRequest(input);
    return withLocalFileSessionWriteTransaction(this.leaseStore, input.providerInstanceId, async (guard) => {
      const existing = await this.readRecord(input.providerInstanceId);
      if (existing && (existing.providerInstanceId !== input.providerInstanceId || existing.providerId !== this.options.providerId)) {
        throw new Error("local_store_record_boundary_mismatch");
      }
      const nextGenerationHash = computeSessionGenerationHash({
        artifact: input.nextArtifact,
      });
      const nextArtifactHash = hashBytes(input.nextArtifact.bytes);
      const replay = existing && Object.hasOwn(existing.idempotency, input.idempotencyKey)
        ? existing.idempotency[input.idempotencyKey] : undefined;
      if (replay) {
        if (!replay.requestHash) {
          // Older v1 receipts only stored the byte hash. Reconstruct a request
          // only while the latest artifact and lease metadata still prove it;
          // historical receipts cannot identify their original lease or format.
          if (!canVerifyLegacyReplay(existing!, replay, input, this.options.metadata, nextGenerationHash, nextArtifactHash)) {
            throw new Error("local_store_legacy_idempotency_unverifiable");
          }
          await this.writeRecord(input.providerInstanceId, {
            ...existing!,
            idempotency: { ...existing!.idempotency, [input.idempotencyKey]: { ...replay, requestHash } },
          });
        } else if (replay.requestHash !== requestHash || replay.artifactHash !== nextArtifactHash) {
          throw new Error("idempotency_key_conflict");
        }
        await guard.recordReceipt({ leaseId: input.leaseId, generationHash: replay.generationHash, idempotencyKey: input.idempotencyKey });
        return {
          status: "idempotent_replay",
          generation: replay.generation,
          generationHash: replay.generationHash,
        };
      }

      if (existing && existing.generation !== input.expectedGeneration) {
        return {
          status: "stale_generation",
          currentGeneration: existing.generation,
          currentGenerationHash: existing.generationHash,
        };
      }
      if (!existing && input.expectedGeneration !== 0) {
        return {
          status: "stale_generation",
          currentGeneration: 0,
          currentGenerationHash: "",
        };
      }

      await guard.authorize({ leaseId: input.leaseId, restoredGenerationHash: existing?.generationHash ?? "",
        bootstrap: !existing && input.expectedGeneration === 0, requireLease: this.options.requireLease ?? false });
      const generation = existing ? existing.generation + 1 : 1;
      const record = encryptRecord({
        providerInstanceId: input.providerInstanceId,
        providerId: this.options.providerId,
        artifact: input.nextArtifact,
        generation,
        generationHash: nextGenerationHash,
        metadata: {
          ...(existing?.metadata ?? {}),
          ...(this.options.metadata ?? {}),
          ...(input.metadata ?? {}),
          leaseId: input.leaseId,
        },
        idempotency: {
          ...(existing?.idempotency ?? {}),
          [input.idempotencyKey]: {
            generation,
            generationHash: nextGenerationHash,
            artifactHash: nextArtifactHash,
            requestHash,
          },
        },
        key: this.encryptionKey,
      });
      await this.writeRecord(input.providerInstanceId, record);
      await guard.recordReceipt({ leaseId: input.leaseId, generationHash: nextGenerationHash, idempotencyKey: input.idempotencyKey });
      return {
        status: "accepted",
        generation,
        generationHash: nextGenerationHash,
      };
    });
  }

  async delete(input: {
    readonly providerInstanceId: string;
    readonly reason: string;
  }): Promise<void> {
    await withLocalFileSessionWriteTransaction(this.leaseStore, input.providerInstanceId, async () => {
      await rm(this.pathFor(input.providerInstanceId), { force: true });
    });
  }

  private async readRecord(
    providerInstanceId: string,
  ): Promise<PersistedRecord | null> {
    try {
      const bytes = await readFile(this.pathFor(providerInstanceId), "utf8");
      return parseRecord(bytes);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async writeRecord(
    providerInstanceId: string,
    record: PersistedRecord,
  ): Promise<void> {
    const path = this.pathFor(providerInstanceId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeAtomicLocalFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  private pathFor(providerInstanceId: string): string {
    return join(this.options.rootDir, `${hashText(providerInstanceId)}.json`);
  }
}

function encryptRecord(input: {
  readonly providerInstanceId: string;
  readonly providerId: string;
  readonly artifact: SessionArtifact;
  readonly generation: number;
  readonly generationHash: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly idempotency: Readonly<Record<string, IdempotencyRecord>>;
  readonly key: Buffer;
}): PersistedRecord {
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv(encryptionAlgorithm, input.key, nonce, {
    authTagLength: authTagBytes,
  });
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(input.artifact.bytes)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    storageVersion,
    providerInstanceId: input.providerInstanceId,
    providerId: input.providerId,
    generation: input.generation,
    generationHash: input.generationHash,
    artifact: {
      kind: input.artifact.kind,
      formatVersion: input.artifact.formatVersion,
      contentType: input.artifact.contentType,
      encryptedBytes: encrypted.toString("base64url"),
      nonce: nonce.toString("base64url"),
      authTag: authTag.toString("base64url"),
      algorithm: encryptionAlgorithm,
    },
    metadata: input.metadata,
    idempotency: input.idempotency,
  };
}

function decryptArtifact(
  record: PersistedRecord,
  key: Buffer,
): SessionArtifact {
  if (record.artifact.algorithm !== encryptionAlgorithm) {
    throw new Error("local_store_unsupported_algorithm");
  }
  const decipher = createDecipheriv(
    encryptionAlgorithm,
    key,
    Buffer.from(record.artifact.nonce, "base64url"),
    { authTagLength: authTagBytes },
  );
  decipher.setAuthTag(Buffer.from(record.artifact.authTag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.artifact.encryptedBytes, "base64url")),
    decipher.final(),
  ]);
  return {
    kind: record.artifact.kind,
    providerId: record.providerId,
    formatVersion: record.artifact.formatVersion,
    contentType: record.artifact.contentType,
    bytes: new Uint8Array(decrypted),
  };
}

function parseRecord(value: string): PersistedRecord {
  const parsed = JSON.parse(value) as Partial<PersistedRecord>;
  if (
    parsed.storageVersion !== storageVersion ||
    typeof parsed.providerInstanceId !== "string" ||
    typeof parsed.providerId !== "string" ||
    typeof parsed.generation !== "number" ||
    typeof parsed.generationHash !== "string" ||
    !parsed.artifact ||
    parsed.artifact.algorithm !== encryptionAlgorithm
  ) {
    throw new Error("local_store_invalid_record");
  }
  return {
    storageVersion,
    providerInstanceId: parsed.providerInstanceId,
    providerId: parsed.providerId,
    generation: parsed.generation,
    generationHash: parsed.generationHash,
    artifact: parsed.artifact,
    metadata: parsed.metadata ?? {},
    idempotency: parsed.idempotency ?? {},
  };
}

function canVerifyLegacyReplay(
  existing: PersistedRecord,
  replay: IdempotencyRecord,
  input: Parameters<SessionStorePort["write"]>[0],
  metadata: Readonly<Record<string, string>> | undefined,
  generationHash: string,
  artifactHash: string,
): boolean {
  return existing.generation === replay.generation && input.expectedGeneration === replay.generation - 1 &&
    replay.generationHash === generationHash && existing.generationHash === generationHash &&
    replay.artifactHash === artifactHash && existing.metadata.leaseId === input.leaseId &&
    existing.artifact.kind === input.nextArtifact.kind && existing.artifact.formatVersion === input.nextArtifact.formatVersion &&
    existing.artifact.contentType === input.nextArtifact.contentType &&
    JSON.stringify(sortedMetadata(existing.metadata)) === JSON.stringify(sortedMetadata({ ...metadata, ...input.metadata, leaseId: input.leaseId }));
}

function sortedMetadata(metadata: Readonly<Record<string, string>>): readonly [string, string][] {
  return Object.entries(metadata).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function hashWriteRequest(input: Parameters<SessionStorePort["write"]>[0]): string {
  return hashText(JSON.stringify([
    input.providerInstanceId, input.expectedGeneration, input.leaseId,
    input.nextArtifact.providerId, input.nextArtifact.kind, input.nextArtifact.formatVersion,
    input.nextArtifact.contentType, hashBytes(input.nextArtifact.bytes),
    sortedMetadata(input.metadata ?? {}),
  ]));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// Actual fixed composition captures these implementations before any escape.
Object.freeze(LocalEncryptedFileStore);
Object.freeze(LocalEncryptedFileStore.prototype);
