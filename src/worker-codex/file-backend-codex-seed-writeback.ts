import { createHash, hkdfSync } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LocalEncryptedFileStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  codexAuthJsonFromArtifact,
  sessionArtifactFromCodexAuthJson,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import { codexSessionCapacityAccountId } from "./codex-session-capacity-identity";
import { CodexSeedRefreshJournal, type CodexSeedRefreshSnapshot } from "./codex-seed-refresh-journal";

const providerInstanceId = "codex:seed-writeback";

/**
 * The seed belongs to the login writer, which does not participate in runtime
 * locks. A check followed by rename cannot CAS that file. Keep refreshed bytes
 * in existing encrypted custody, in a separate source-bound slot instead: even
 * a replacement during publication cannot make an old worker publish into the
 * new authorization's slot. The strict publish API retains its original
 * fencing contract. Worker refresh uses immutable journal custody instead of
 * treating a contended/crashed mkdir lock as successful publication.
 */
export class FileBackendCodexSeedWriteback {
  private readonly sourcePath: string;
  constructor(private readonly legacySourcePath: string) { this.sourcePath = resolve(legacySourcePath); }

  async read(source: string): Promise<string> {
    return (await this.readWithProvenance(source)).bytes;
  }

  async readWithProvenance(source: string): Promise<CodexSeedRefreshSnapshot> {
    const { store, journal } = this.binding(source);
    const refreshed = await journal.readWithProvenance();
    if (refreshed !== null) return refreshed;
    const cached = await store.read({ providerInstanceId, expectedProviderId: "codex", purpose: "seed" });
    if (!cached) {
      // Exact v1 byte-bound records remain readable. Once imported/exported by
      // a worker they enter stable v2 custody. A v1 record whose original seed
      // bytes were lost cannot be decrypted from public hashes alone.
      const legacy = await this.legacyBinding(source).read({ providerInstanceId, expectedProviderId: "codex", purpose: "seed-migration" });
      return { bytes: legacy ? codexAuthJsonFromArtifact(legacy.artifact) : source, ancestorSessionIds: [] };
    }
    const bytes = codexAuthJsonFromArtifact(cached.artifact);
    validateCodexAuthJsonBytes({ authJsonBytes: bytes });
    return { bytes, ancestorSessionIds: [] };
  }

  async publish(input: {
    readonly source: string;
    readonly expected: string;
    readonly next: string;
  }): Promise<boolean> {
    validateCodexAuthJsonBytes({ authJsonBytes: input.next });
    if (input.expected === input.next) return false;
    const { root, store, journal } = this.binding(input.source);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    const lockPath = `${root}.lock`;
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (isCode(error, "EEXIST")) return false;
      throw error;
    }
    try {
      // This is an optimization, not an atomic precondition on the login file.
      // Safety against external writers comes from disjoint publication paths.
      if (codexSeedAuthorizationIdentity(await readFile(this.sourcePath, "utf8")) !== codexSeedAuthorizationIdentity(input.source)) return false;
      const cached = await store.read({ providerInstanceId, expectedProviderId: "codex", purpose: "writeback" });
      const current = await this.read(input.source);
      if (current !== input.expected) return false;
      if (await journal.read() !== null) {
        await journal.publish({ ...input, sourceIdentity: codexSeedAuthorizationIdentity(input.source), current: () => this.read(input.source) });
        return true;
      }
      const result = await store.write({
        providerInstanceId,
        expectedGeneration: cached?.generation ?? 0,
        nextArtifact: sessionArtifactFromCodexAuthJson(input.next),
        idempotencyKey: createHash("sha256").update(`${cached?.generation ?? 0}:`).update(input.expected).update("\0").update(input.next).digest("hex"),
        leaseId: "source-bound-writeback-lock",
      });
      return result.status !== "stale_generation";
    } finally {
      await rm(lockPath, { recursive: true });
    }
  }

  async publishRefresh(input: { readonly source: string; readonly expected: string; readonly next: string }): Promise<boolean> {
    validateCodexAuthJsonBytes({ authJsonBytes: input.next });
    if (codexSeedAuthorizationIdentity(await readFile(this.sourcePath, "utf8")) !== codexSeedAuthorizationIdentity(input.source)) return false;
    const { store, journal } = this.binding(input.source);
    if (input.expected === input.next) {
      if (input.next === input.source || await journal.read() !== null ||
          await store.read({ providerInstanceId, expectedProviderId: "codex", purpose: "seed-migration" })) return false;
      // A readable v1 refresh needs stable custody even if this successful
      // provider operation did not rotate again. Do not rewrite its login file.
      const legacy = await this.legacyBinding(input.source).read({ providerInstanceId, expectedProviderId: "codex", purpose: "seed-migration" });
      if (!legacy || codexAuthJsonFromArtifact(legacy.artifact) !== input.next) return false;
    }
    await journal.publish({ ...input, sourceIdentity: codexSeedAuthorizationIdentity(input.source), current: () => this.read(input.source) });
    return true;
  }

  private binding(source: string): { readonly root: string; readonly store: LocalEncryptedFileStore; readonly journal: CodexSeedRefreshJournal } {
    const identity = codexSeedAuthorizationIdentity(source);
    const scope = createHash("sha256").update(this.sourcePath).update("\0v2\0").update(identity).digest("hex");
    const root = join(dirname(this.sourcePath), ".subscription-runtime-auth-writeback", scope);
    const parsed = validateCodexAuthJsonBytes({ authJsonBytes: source }).parsed;
    // Stable secret refresh identity, independent of formatting/access renewal.
    // The public scope digest is never used as an encryption key.
    const encryptionKey = new Uint8Array(hkdfSync("sha256", parsed.tokens.refresh_token!, identity, "subscription-runtime/codex-seed-writeback/v2", 32));
    return { root, store: new LocalEncryptedFileStore({ providerId: "codex", rootDir: root, encryptionKey }),
      journal: new CodexSeedRefreshJournal(join(root, "publications"), encryptionKey) };
  }

  private legacyBinding(source: string): LocalEncryptedFileStore {
    const scope = createHash("sha256").update(this.legacySourcePath).update("\0").update(source).digest("hex");
    return new LocalEncryptedFileStore({ providerId: "codex",
      rootDir: join(dirname(this.sourcePath), ".subscription-runtime-auth-writeback", scope),
      encryptionKey: new Uint8Array(hkdfSync("sha256", source, "", "subscription-runtime/codex-seed-writeback/v1", 32)) });
  }
}

export function codexSeedAuthorizationIdentity(source: string): string {
  const identity = codexSessionCapacityAccountId(validateCodexAuthJsonBytes({ authJsonBytes: source }).parsed);
  if (!identity) throw new Error("codex_seed_authorization_identity_required");
  return identity;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
