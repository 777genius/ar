import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  safeStatMtimeMs,
  shouldReplaceSeededCodexSession,
  writeCodexAuthJsonFileAtomic,
} from "./file-backend-codex-auth-artifacts";

export class FileBackendCodexSessionSeeder {
  private authJsonPath: string | null = null;
  private authJsonFingerprint: string | null = null;
  private authJsonSourceMtimeMs: number | null = null;

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
    },
  ) {}

  async seedAuthJsonFile(authJsonPath: string): Promise<void> {
    this.options.assertProviderAdmission?.();
    this.authJsonPath = authJsonPath;
    let authJson: string;
    try {
      authJson = await readFile(authJsonPath, "utf8");
    } catch {
      this.options.onFailure(codexSeedSessionInvalidFailure());
      return;
    }
    if (await this.seedAuthJson(authJson)) {
      this.rememberAuthJsonSource(authJsonPath, authJson);
    }
  }

  async seedAuthJson(authJson: string): Promise<boolean> {
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
      if (
        shouldReplaceSeededCodexSession({
          existing,
          incoming: artifact,
          now: this.options.clock.now(),
        })
      ) {
        await this.options.sessionStore.write({
          providerInstanceId: this.options.providerInstanceId,
          expectedGeneration: existing.generation,
          nextArtifact: artifact,
          idempotencyKey: `seed:${hashText(authJson)}`,
          leaseId: "seed-local-file-backend",
        });
        this.options.rememberQuotaGroup(artifact);
        return true;
      }
      this.options.rememberQuotaGroup(existing.artifact);
      return true;
    }

    await this.options.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(authJson)}`,
      leaseId: "seed-local-file-backend",
    });
    this.options.rememberQuotaGroup(artifact);
    return true;
  }

  async exportAuthJsonFileQuietly(context: "prewarm" | "run", requireAcknowledgement = false): Promise<void> {
    this.options.assertProviderAdmission?.();
    if (!this.authJsonPath) return;
    try {
      const session = await this.options.sessionStore.read({
        providerInstanceId: this.options.providerInstanceId,
        expectedProviderId: "codex",
        purpose: "health-check",
      });
      if (!session) { if (requireAcknowledgement) throw new Error("codex_auth_path_export_failed"); return; }
      const authJsonBytes = codexAuthJsonFromArtifact(session.artifact);
      validateCodexAuthJsonBytes({ authJsonBytes });
      const existing = await readFile(this.authJsonPath, "utf8").catch(() => null);
      if (existing === authJsonBytes) return;
      await writeCodexAuthJsonFileAtomic(this.authJsonPath, authJsonBytes);
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
      if (requireAcknowledgement) throw new Error("codex_auth_path_export_failed");
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
    const fingerprint = hashText(authJson);
    const sourceMtimeMs = safeStatMtimeMs(this.authJsonPath);
    if (
      this.authJsonFingerprint === fingerprint &&
      (
        sourceMtimeMs === null ||
        this.authJsonSourceMtimeMs === sourceMtimeMs
      )
    ) {
      return;
    }
    if (!(await this.seedAuthJson(authJson))) return;
    this.rememberAuthJsonSource(this.authJsonPath, authJson);
    this.options.onAuthImported();
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
    const sourceMtimeMs = safeStatMtimeMs(this.authJsonPath);
    if (
      sourceMtimeMs !== null &&
      this.authJsonSourceMtimeMs !== null &&
      sourceMtimeMs === this.authJsonSourceMtimeMs
    ) {
      return false;
    }
    try {
      const fingerprint = hashText(readFileSync(this.authJsonPath, "utf8"));
      return this.authJsonFingerprint !== fingerprint;
    } catch {
      return false;
    }
  }

  private rememberAuthJsonSource(authJsonPath: string, authJson: string): void {
    this.authJsonFingerprint = hashText(authJson);
    this.authJsonSourceMtimeMs = safeStatMtimeMs(authJsonPath);
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
