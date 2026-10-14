import type { ClockPort, RuntimeDeps, SessionArtifact } from "@vioxen/subscription-runtime/core";
import {
  sessionArtifactFromClaudeAmbientHome,
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
  type ClaudeOAuthSession,
  type ClaudeTaskExecutionEngine,
} from "@vioxen/subscription-runtime/provider-claude";
import { SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";
import { assertClaudeAmbientHomeLocalContext } from "../provider-claude/process/claude-cli-env";
import {
  FileBackendClaudeCapacityState,
  claudeCapacityAccountIdMetadataKey,
  hashText,
  normalizeCapacityAccountId,
} from "./file-backend-claude-capacity";
import type { FileBackendClaudeWorkerOptions } from "./file-backend-claude-worker";

/** Durable paths are data; only this worker's explicit selection authorizes ambient use. */
export class ClaudeWorkerSessionSelection {
  private ambientChoice: { readonly homeDir: string; readonly configDir?: string } | undefined;

  constructor(
    private readonly options: Pick<FileBackendClaudeWorkerOptions, "providerInstanceId" | "capacityAccountId" | "baseEnv">,
    private readonly getSessionStore: () => NonNullable<RuntimeDeps["sessionStore"]>,
    private readonly capacityTracker: FileBackendClaudeCapacityState,
    private readonly configDir: string,
    private readonly clock: ClockPort,
  ) {}

  private get sessionStore(): NonNullable<RuntimeDeps["sessionStore"]> {
    return this.getSessionStore();
  }

  async seedClaudeOAuth(input: {
    readonly oauthToken: string;
    readonly configDir?: string;
    readonly capacityAccountId?: string;
    readonly refreshedAt?: string;
    readonly expiresAt?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<void> {
    this.ambientChoice = undefined;
    const capacityAccountId =
      normalizeCapacityAccountId(input.capacityAccountId) ??
      normalizeCapacityAccountId(this.options.capacityAccountId);
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (existing && validateClaudeSessionArtifact(existing.artifact).session.authMode === "oauth") {
      const capacityArtifact = await this.capacityTracker.persistStoredCapacityAccountId(
        existing,
        capacityAccountId,
      );
      this.capacityTracker.rememberQuotaGroup(capacityArtifact, capacityAccountId);
      return;
    }

    const metadata = {
      ...(input.metadata ?? {}),
      ...(capacityAccountId
        ? { [claudeCapacityAccountIdMetadataKey]: capacityAccountId }
        : {}),
    };
    const artifact = sessionArtifactFromClaudeOAuth({
      oauthToken: input.oauthToken,
      configDir: input.configDir ?? this.configDir,
      refreshedAt: input.refreshedAt ?? this.clock.now().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    const write = await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: existing?.generation ?? 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${existing?.generation ?? 0}:${hashText(input.oauthToken)}`,
      leaseId: "seed-local-file-backend",
    });
    if (write.status === "stale_generation") throw new Error("claude_session_seed_stale_generation");
    this.capacityTracker.rememberQuotaGroup(artifact);
  }

  /**
   * Local-only, explicit opt-in mode: seeds a session artifact that records
   * an ambient HOME/CLAUDE_CONFIG_DIR pair instead of an OAuth token. No
   * OAuth/token material is read, copied or persisted here; subscription-runtime
   * only remembers which directory to point the installed Claude CLI at, the
   * same way sessionSeed already remembers configDir for the OAuth path. This
   * mode carries no capacity/quota pooling: it targets a single local machine.
   */
  async seedClaudeAmbientHome(input: {
    readonly homeDir: string;
    readonly configDir?: string;
  }): Promise<void> {
    assertClaudeAmbientHomeLocalContext(this.options.baseEnv ?? process.env);
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (existing && validateClaudeSessionArtifact(existing.artifact).session.authMode === "oauth") return;

    const artifact = sessionArtifactFromClaudeAmbientHome({
      homeDir: input.homeDir,
      ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
    });
    const write = await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: existing?.generation ?? 0,
      nextArtifact: artifact,
      idempotencyKey: `seed-ambient:${existing?.generation ?? 0}:${hashText(JSON.stringify(input))}`,
      leaseId: "seed-local-file-backend",
    });
    if (write.status === "stale_generation") throw new Error("claude_session_seed_stale_generation");
    this.ambientChoice = { ...input };
  }

  async assertStoredSessionHasConfigDir(): Promise<void> {
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (!session) {
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Claude session is missing.",
      );
    }
    this.assertAmbientAuthorized(session.artifact);
    const validation = validateClaudeSessionArtifact(session.artifact);
    const hasHomeDirectory = validation.session.authMode === "ambient-home"
      ? Boolean(validation.session.homeDir)
      : Boolean(validation.session.configDir);
    if (!hasHomeDirectory) {
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Claude session is missing a config dir.",
      );
    }
  }

  async assertStoredAmbientAuthorized(): Promise<void> {
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "claude",
      purpose: "health-check",
    });
    if (existing) this.assertAmbientAuthorized(existing.artifact);
  }

  withSessionAuthorization(engine: ClaudeTaskExecutionEngine): ClaudeTaskExecutionEngine {
    const assertAuthorized = (session: ClaudeOAuthSession) => this.assertSessionAuthorized(session);
    return {
      kind: engine.kind,
      capabilities: engine.capabilities,
      run: (input) => {
        assertAuthorized(input.session);
        return engine.run(input);
      },
      ...(engine.stream === undefined ? {} : {
        async *stream(input) {
          assertAuthorized(input.session);
          yield* engine.stream!(input);
        },
      }),
      ...(engine.dispose === undefined ? {} : { dispose: () => engine.dispose!() }),
    };
  }

  private assertAmbientAuthorized(artifact: SessionArtifact): void {
    this.assertSessionAuthorized(validateClaudeSessionArtifact(artifact).session);
  }

  private assertSessionAuthorized(session: ClaudeOAuthSession): void {
    if (session.authMode !== "ambient-home") return;
    assertClaudeAmbientHomeLocalContext(this.options.baseEnv ?? process.env);
    if (this.ambientChoice?.homeDir !== session.homeDir ||
        this.ambientChoice.configDir !== session.configDir) {
      throw new Error("claude_ambient_home_opt_in_required");
    }
  }
}
