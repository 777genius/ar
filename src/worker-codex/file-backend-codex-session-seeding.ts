import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ClockPort,
  ObservabilityPort,
  ProviderFailure,
  RuntimeDeps,
  SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import {
  classifyCodexFailure,
  codexAuthJsonFromArtifact,
  sessionArtifactFromCodexAuthJson,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  shouldReplaceSeededCodexSession,
} from "./file-backend-codex-auth-artifacts";
import { FileBackendCodexSeedWriteback, codexSeedAuthorizationIdentity } from "./file-backend-codex-seed-writeback";
import type { CodexSeedRefreshSnapshot } from "./codex-seed-refresh-journal";
import { SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";
import { isCodexSessionCapacityAccountId } from "./codex-session-capacity-identity";

const sourceIdentityKey = "codexSourceAuthorizationIdentity";
const sourcePathKey = "codexSourcePathSha256";
type SourceBinding = { readonly identity: string; readonly pathHash: string };

export class FileBackendCodexSessionSeeder {
  private authJsonPath: string | null = null;
  private authJsonFingerprint: string | null = null;
  private sourceWriteback: FileBackendCodexSeedWriteback | null = null;
  private sourceBytes: string | null = null;
  private writebackExpected: string | null = null;
  private importedSeedFingerprint: string | null = null;
  private boundSourceIdentity: string | null = null;
  private importedSessionBytes: string | null = null;

  constructor(
    private readonly options: {
      readonly assertProviderAdmission?: () => void;
      readonly providerInstanceId: string;
      readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
      readonly observability: ObservabilityPort;
      readonly clock: ClockPort;
      readonly agentId: string;
      readonly onFailure: (failure: ProviderFailure) => void;
      readonly rememberQuotaGroup: (session: SessionArtifact) => void;
      readonly onAuthImported: () => void;
      readonly shouldExportAuth?: () => boolean;
    },
  ) {}

  async seedAuthJsonFile(authJsonPath: string): Promise<void> {
    this.options.assertProviderAdmission?.();
    // Bind the imported source in the same atomic custody record as the
    // provider artifact. Refresh writes retain these sanitized annotations.
    // A crash cannot expose S1 with a stale S0 binding from a second record.
    const binding = await this.options.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    const pathHash = hashText(resolve(authJsonPath));
    const persistedIdentity = binding?.metadata[sourcePathKey] === pathHash &&
      isCodexSessionCapacityAccountId(binding.metadata[sourceIdentityKey])
      ? binding.metadata[sourceIdentityKey]! : null;
    const previousIdentity = this.authJsonPath === authJsonPath
      ? this.boundSourceIdentity ?? persistedIdentity : persistedIdentity;
    if (this.authJsonPath !== authJsonPath) {
      this.boundSourceIdentity = null;
      this.writebackExpected = null;
    }
    this.authJsonPath = authJsonPath;
    this.sourceWriteback = new FileBackendCodexSeedWriteback(authJsonPath);
    this.sourceBytes = null;
    this.importedSeedFingerprint = null;
    this.importedSessionBytes = null;
    let authJson: string;
    try {
      authJson = await readFile(authJsonPath, "utf8");
    } catch {
      this.options.onFailure(codexSeedSessionInvalidFailure());
      return;
    }
    try {
      const identity = codexSeedAuthorizationIdentity(authJson);
      const changedAuthorization = previousIdentity !== null && previousIdentity !== identity;
      const snapshot = await this.sourceWriteback.readWithProvenance(authJson);
      const seeded = snapshot.bytes;
      if (persistedIdentity === identity) {
        this.boundSourceIdentity = identity;
        // A selected sibling is not the parent of retained local bytes. Reuse
        // our captured grant, or the durably bound original source on restart;
        // bindWriteback grants the selected snapshot only if it was imported.
        this.writebackExpected = codexAuthJsonFromArtifact(binding!.artifact) === seeded
          ? seeded : this.writebackExpected ?? authJson;
      }
      const retainedAuthorization = previousIdentity === null || persistedIdentity === identity;
      if (await this.seedAuthJson(seeded, changedAuthorization, retainedAuthorization, { identity, pathHash }, snapshot)) {
        this.rememberAuthJsonSource(authJson);
        await this.bindWriteback(authJson, seeded);
        if (changedAuthorization) this.options.onAuthImported();
      }
    } catch (error) {
      this.options.onFailure(classifyCodexFailure(error));
    }
  }

  async seedAuthJson(authJson: string, authorizedReplacement = false, retainBoundLocal = false,
    sourceBinding?: SourceBinding, snapshot?: CodexSeedRefreshSnapshot): Promise<boolean> {
    this.options.assertProviderAdmission?.();
    let artifact: SessionArtifact;
    try {
      artifact = sessionArtifactFromCodexAuthJson(authJson);
    } catch (error) {
      this.options.onFailure(classifyCodexFailure(error));
      return false;
    }
    const existing = await this.options.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (existing) {
      const causalDescendant = sourceBinding && snapshot?.bytes === authJson &&
        hasSourceBinding(existing.metadata, sourceBinding) &&
        snapshot.ancestorSessionIds.includes(codexSeedAuthorizationIdentity(codexAuthJsonFromArtifact(existing.artifact)));
      if (
        authorizedReplacement || causalDescendant || (sourceBinding && codexAuthJsonFromArtifact(existing.artifact) === authJson &&
          !hasSourceBinding(existing.metadata, sourceBinding)) || (!retainBoundLocal && shouldReplaceSeededCodexSession({
          existing,
          incoming: artifact,
          now: this.options.clock.now(),
        }))
      ) {
        await this.options.sessionStore.write({
          providerInstanceId: this.options.providerInstanceId,
          expectedGeneration: existing.generation,
          nextArtifact: artifact,
          idempotencyKey: `seed:${existing.generation}:${hashText(authJson)}`,
          leaseId: "seed-local-file-backend",
          ...(sourceBinding ? { metadata: sourceBindingMetadata(sourceBinding) } : {}),
        });
        const stored = await this.options.sessionStore.read({
          providerInstanceId: this.options.providerInstanceId,
          expectedProviderId: "codex",
          purpose: "health-check",
        });
        // A rejected CAS must not remember S1 or release invalidation while
        // the main custody still contains an unrelated authorization.
        if (!stored || codexAuthJsonFromArtifact(stored.artifact) !== authJson) return false;
        if (sourceBinding && !hasSourceBinding(stored.metadata, sourceBinding)) {
          throw new Error("codex_source_binding_not_persisted");
        }
        this.options.rememberQuotaGroup(artifact);
        this.importedSessionBytes = codexAuthJsonFromArtifact(artifact);
        return true;
      }
      if (sourceBinding && !hasSourceBinding(existing.metadata, sourceBinding)) {
        // Pre-binding custody may be the only usable unpublished rotation.
        // Observing a source does not establish its relationship to this local
        // artifact. Retain it, grant no publication right, and expose recovery.
        this.options.observability.emit({
          name: "codex.auth_path.unbound_local_retained", providerId: "codex",
          agentId: this.options.agentId, storeId: this.options.sessionStore.storeId,
          metadata: { reason: "codex_source_binding_recovery_required" },
        });
      }
      this.options.rememberQuotaGroup(existing.artifact);
      this.importedSessionBytes = codexAuthJsonFromArtifact(existing.artifact);
      return true;
    }

    await this.options.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(authJson)}`,
      leaseId: "seed-local-file-backend",
      ...(sourceBinding ? { metadata: sourceBindingMetadata(sourceBinding) } : {}),
    });
    const stored = await this.options.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex", purpose: "health-check",
    });
    if (!stored || codexAuthJsonFromArtifact(stored.artifact) !== authJson) return false;
    if (sourceBinding && !hasSourceBinding(stored.metadata, sourceBinding)) {
      throw new Error("codex_source_binding_not_persisted");
    }
    this.options.rememberQuotaGroup(artifact);
    this.importedSessionBytes = codexAuthJsonFromArtifact(artifact);
    return true;
  }

  async exportAuthJsonFileQuietly(context: "prewarm" | "run", requireAcknowledgement = false): Promise<void> {
    this.options.assertProviderAdmission?.();
    if (this.options.shouldExportAuth?.() === false) {
      if (requireAcknowledgement) throw new Error("codex_auth_path_export_failed");
      return;
    }
    if (!this.sourceWriteback || this.sourceBytes === null) return;
    try {
      const session = await this.options.sessionStore.read({
        providerInstanceId: this.options.providerInstanceId,
        expectedProviderId: "codex",
        purpose: "health-check",
      });
      if (!session) { if (requireAcknowledgement) throw new Error("codex_auth_path_export_failed"); return; }
      const authJsonBytes = codexAuthJsonFromArtifact(session.artifact);
      validateCodexAuthJsonBytes({ authJsonBytes });
      if (this.writebackExpected === null) {
        // Unbound recovery custody grants no publishing ancestry. Unchanged
        // local use is safe; another rotation must expose publication loss.
        if (authJsonBytes !== this.importedSessionBytes) throw new Error("codex_source_binding_recovery_required");
        return;
      }
      if (!(await this.sourceWriteback.publishRefresh({
        source: this.sourceBytes,
        expected: this.writebackExpected,
        next: authJsonBytes,
      }))) {
        if (requireAcknowledgement && authJsonBytes !== this.importedSessionBytes) throw new Error("codex_auth_path_export_failed");
        return;
      }
      this.writebackExpected = authJsonBytes;
      this.importedSessionBytes = authJsonBytes;
      this.importedSeedFingerprint = hashText(authJsonBytes);
      this.options.observability.count("subscription_runtime.codex_auth_path_exported");
    } catch {
      this.options.observability.count(
        "subscription_runtime.codex_auth_path_export_failed",
      );
      this.options.observability.emit({
        name: "codex.auth_path.export_failed",
        providerId: "codex",
        agentId: this.options.agentId,
        storeId: this.options.sessionStore.storeId,
        metadata: { context },
      });
      // The encrypted job-local session remains recoverable. A caller must
      // observe publication loss, rather than complete with only a volatile
      // provider credential. Never include the error's credential-bearing IO.
      throw new SubscriptionWorkerError("subscription_worker_run_failed",
        "Codex refresh publication failed; encrypted local session retained.",
        { details: { code: "codex_seed_publication_failed", reason: "codex_seed_publication_failed", context } });
    }
  }

  async importAuthJsonFileIfChanged(context: "prewarm" | "run"): Promise<void> {
    this.options.assertProviderAdmission?.();
    if (!this.authJsonPath) return;
    let authJson: string;
    try {
      authJson = await readFile(this.authJsonPath, "utf8");
    } catch {
      return;
    }
    let fingerprint: string;
    let seeded: string;
    let snapshot: CodexSeedRefreshSnapshot;
    try {
      fingerprint = codexSeedAuthorizationIdentity(authJson);
      snapshot = await this.sourceWriteback?.readWithProvenance(authJson) ?? { bytes: authJson, ancestorSessionIds: [] };
      seeded = snapshot.bytes;
    } catch (error) {
      this.options.onFailure(classifyCodexFailure(error));
      return;
    }
    const sourceChanged = this.authJsonFingerprint !== fingerprint;
    if (!sourceChanged && this.importedSeedFingerprint === hashText(seeded)) {
      return;
    }
    const retainedAuthorization = this.boundSourceIdentity === null || this.boundSourceIdentity === fingerprint;
    if (!(await this.seedAuthJson(seeded, this.boundSourceIdentity !== null && sourceChanged, retainedAuthorization,
      { identity: fingerprint, pathHash: hashText(resolve(this.authJsonPath)) }, snapshot))) return;
    this.rememberAuthJsonSource(authJson);
    await this.bindWriteback(authJson, seeded);
    // Provider refresh does not authorize recovery from a revoked seed. Only
    // the independent login source changing can release local invalidation.
    if (sourceChanged && this.boundSourceIdentity === fingerprint) this.options.onAuthImported();
    this.options.observability.emit({
      name: "codex.auth_path.imported",
      providerId: "codex",
      agentId: this.options.agentId,
      storeId: this.options.sessionStore.storeId,
      metadata: { context },
    });
  }

  authJsonFileChanged(): boolean {
    this.options.assertProviderAdmission?.();
    if (!this.authJsonPath) return false;
    try {
      const fingerprint = codexSeedAuthorizationIdentity(readFileSync(this.authJsonPath, "utf8"));
      return this.authJsonFingerprint !== fingerprint;
    } catch {
      return false;
    }
  }

  private rememberAuthJsonSource(authJson: string): void {
    this.authJsonFingerprint = codexSeedAuthorizationIdentity(authJson);
  }

  private async bindWriteback(source: string, seeded: string): Promise<void> {
    this.sourceBytes = source;
    const previousExpected = this.writebackExpected;
    this.writebackExpected = null;
    this.importedSeedFingerprint = hashText(seeded);
    const stored = await this.options.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    this.importedSessionBytes = stored ? codexAuthJsonFromArtifact(stored.artifact) : null;
    const identity = codexSeedAuthorizationIdentity(source);
    const durablyBound = stored && this.authJsonPath !== null && hasSourceBinding(stored.metadata,
      { identity, pathHash: hashText(resolve(this.authJsonPath)) });
    // A fresher local artifact may have defeated the seed or its CAS. It is
    // not authorized to publish under the newly observed source's identity.
    if (stored && durablyBound && codexAuthJsonFromArtifact(stored.artifact) === seeded) {
      this.writebackExpected = seeded;
      this.boundSourceIdentity = identity;
    } else if (this.boundSourceIdentity !== identity || !durablyBound) {
      this.boundSourceIdentity = null;
    } else {
      // Rejecting the incoming stale artifact grants no new publishing right.
      // Keep a previously captured grant only for the unchanged authorization.
      this.writebackExpected = previousExpected;
    }
    this.rememberBoundSourceQuotaGroup();
  }

  rememberBoundSourceQuotaGroup(): void {
    // Shared capacity resolves the login source. Keep a cached refresh's
    // invalidation attached to that authorization lineage, even after the
    // provider rotates its refresh token inside custody.
    if (this.sourceBytes !== null && this.boundSourceIdentity !== null) {
      this.options.rememberQuotaGroup(sessionArtifactFromCodexAuthJson(this.sourceBytes));
    }
  }

  rememberBoundSeedQuotaGroup(): void {
    if (this.importedSessionBytes !== null) {
      this.options.rememberQuotaGroup(sessionArtifactFromCodexAuthJson(this.importedSessionBytes));
    }
  }
}

function codexSeedSessionInvalidFailure(): ProviderFailure {
  return {
    code: "provider_session_invalid",
    retryable: false,
    reconnectRequired: true,
    safeMessage: "Codex session is invalid.",
    causeCategory: "provider_session_invalid",
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceBindingMetadata(binding: SourceBinding): Readonly<Record<string, string>> {
  return { [sourceIdentityKey]: binding.identity, [sourcePathKey]: binding.pathHash };
}

function hasSourceBinding(metadata: Readonly<Record<string, string>>, binding: SourceBinding): boolean {
  return metadata[sourceIdentityKey] === binding.identity && metadata[sourcePathKey] === binding.pathHash;
}
