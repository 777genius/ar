import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  AgentProvider,
  identityFromAuthJson,
  type ProviderAccountIdentity,
} from "@vioxen/agent-account-observability";
import type {
  WorkerAccountCapacityStore,
  WorkerAccountLimitSignal,
} from "@vioxen/subscription-runtime/worker-core";
import { mergeWorkerAndAccountCapacity, WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacitySignalScope } from "@vioxen/subscription-runtime/worker-core";
import { codexSessionCapacityAccountId, isCodexSessionCapacityAccountId } from "../codex-session-capacity-identity";

export type CodexAccountCapacityAliasStoreOptions = {
  readonly assertProviderAdmission?: () => void;
  readonly authRootDir: string;
  readonly store: WorkerAccountCapacityStore;
  readonly authJsonPaths?: Readonly<Record<string, string>>;
  readonly authJsonByAlias?: Readonly<Record<string, string>>;
};

export function codexCapacityAccountIdFromIdentity(
  identity: ProviderAccountIdentity | undefined,
  fallbackAccountId: string,
): string {
  return identity?.accountKeyHash
    ? `codex-provider:${identity.accountKeyHash}`
    : fallbackAccountId;
}

export function codexCapacityAccountIdFromAuthJson(input: {
  readonly authJson: unknown;
  readonly slotAlias: string;
  readonly authJsonPath: string;
}): string {
  const identity = identityFromAuthJson(input.authJson, {
    provider: AgentProvider.Codex,
    slotId: input.slotAlias,
    authHome: dirname(input.authJsonPath),
    authJsonPath: input.authJsonPath,
  });
  return identity.accountKeyHash
    ? codexCapacityAccountIdFromIdentity(identity, input.slotAlias)
    : (refreshSessionCapacityAccountId(input.authJson) ?? input.slotAlias);
}

export class CodexAccountCapacityAliasStore
  implements WorkerAccountCapacityStore
{
  private readonly aliases: CodexAccountCapacityAliasResolver;

  constructor(private readonly options: CodexAccountCapacityAliasStoreOptions) {
    this.aliases = new CodexAccountCapacityAliasResolver(options);
  }

  read(input: Parameters<WorkerAccountCapacityStore["read"]>[0]) {
    const account = this.options.store.read({
      ...input,
      accountId: this.aliases.resolve(input.accountId),
    });
    const session = this.options.store.read({
      accountId: this.aliases.resolveSession(input.accountId),
      ...(input.now ? { now: input.now } : {}),
    });
    return session && account ? mergeWorkerAndAccountCapacity(account, session) : session ?? account;
  }

  readState(input: Parameters<WorkerAccountCapacityStore["readState"]>[0]) {
    const session = this.options.store.readState({
      accountId: this.aliases.resolveSession(input.accountId), now: input.now,
    });
    if (session?.capacity.reason === "provider_session_invalid") return session;
    return this.options.store.readState({
      ...input,
      accountId: this.aliases.resolve(input.accountId),
    });
  }

  observe(input: WorkerAccountLimitSignal) {
    if (input.capacity.reason === "provider_session_invalid") {
      // The worker binds a failure to the session actually used, even if an
      // operator replaces the source seed while the failed turn is in flight.
      const boundSession = input.capacity.details?.capacitySessionId;
      const accountId = isCodexSessionCapacityAccountId(boundSession)
        ? boundSession : this.aliases.resolveSession(input.accountId);
      const { cooldownUntil: _cooldown, ...capacity } = input.capacity;
      const { capacitySessionId: _sessionId, ...details } = capacity.details ?? {};
      return this.options.store.observe({
        ...input, accountId, scope: WorkerAccountCapacitySignalScope.AccountWide,
        capacity: { ...capacity, availability: "disabled", details: {
          ...details, ...(isCodexSessionCapacityAccountId(accountId) ? { capacitySessionId: accountId } : {}),
        } },
      });
    }
    return this.options.store.observe({
      ...input,
      accountId: this.aliases.resolve(input.accountId),
    });
  }

  tryClaimRecheck(
    input: Parameters<WorkerAccountCapacityStore["tryClaimRecheck"]>[0],
  ) {
    // Quota availability is not successful validation of a revoked session.
    if (input.state.capacity.reason === "provider_session_invalid") {
      return { status: WorkerAccountCapacityClaimStatus.NotDue, state: input.state } as const;
    }
    return this.options.store.tryClaimRecheck(input);
  }

  resolveRecheck(
    input: Parameters<WorkerAccountCapacityStore["resolveRecheck"]>[0],
  ) {
    return this.options.store.resolveRecheck(input);
  }

  releaseRecheck(
    input: Parameters<WorkerAccountCapacityStore["releaseRecheck"]>[0],
  ): void {
    this.options.store.releaseRecheck(input);
  }

  clear(input: Parameters<WorkerAccountCapacityStore["clear"]>[0]): void {
    this.options.store.clear({
      accountId: this.aliases.resolve(input.accountId),
    });
  }
}

type CachedAlias = {
  readonly signature: string;
  readonly capacityAccountId: string;
  readonly sessionAccountId: string;
};

class CodexAccountCapacityAliasResolver {
  private readonly cache = new Map<string, CachedAlias>();

  constructor(private readonly options: CodexAccountCapacityAliasStoreOptions) {}

  resolve(slotAlias: string): string {
    return this.resolveAlias(slotAlias).capacityAccountId;
  }

  resolveSession(slotAlias: string): string {
    return this.resolveAlias(slotAlias).sessionAccountId;
  }

  private resolveAlias(slotAlias: string): CachedAlias {
    this.options.assertProviderAdmission?.();
    const fallback: CachedAlias = { signature: "", capacityAccountId: slotAlias,
      sessionAccountId: slotAlias };
    if (slotAlias.startsWith("codex-provider:") || slotAlias.startsWith("codex-session:")) return fallback;
    const inlineAuthJson = this.options.authJsonByAlias?.[slotAlias];
    if (inlineAuthJson !== undefined) {
      return this.resolveAuthJson({
        slotAlias,
        authJsonPath: join(this.options.authRootDir, slotAlias, "auth.json"),
        authJsonText: inlineAuthJson,
        signature: `inline:${createHash("sha256").update(inlineAuthJson).digest("hex")}`,
      });
    }
    const authJsonPath =
      this.options.authJsonPaths?.[slotAlias] ??
      join(this.options.authRootDir, slotAlias, "auth.json");
    try {
      const stats = statSync(authJsonPath);
      return this.resolveAuthJson({
        slotAlias,
        authJsonPath,
        authJsonText: readFileSync(authJsonPath, "utf8"),
        signature: `${stats.dev}:${stats.ino}:${stats.ctimeMs}:${stats.mtimeMs}:${stats.size}`,
      });
    } catch {
      this.cache.delete(slotAlias);
      return fallback;
    }
  }

  private resolveAuthJson(input: {
    readonly slotAlias: string;
    readonly authJsonPath: string;
    readonly authJsonText: string;
    readonly signature: string;
  }): CachedAlias {
    const cached = this.cache.get(input.slotAlias);
    if (cached?.signature === input.signature) return cached;
    try {
      const authJson: unknown = JSON.parse(input.authJsonText);
      const capacityAccountId = codexCapacityAccountIdFromAuthJson({
        authJson,
        slotAlias: input.slotAlias,
        authJsonPath: input.authJsonPath,
      });
      const resolved = {
        signature: input.signature,
        capacityAccountId,
        sessionAccountId: codexSessionCapacityAccountId(authJson) ?? capacityAccountId,
      };
      this.cache.set(input.slotAlias, resolved);
      return resolved;
    } catch {
      this.cache.delete(input.slotAlias);
      return { signature: "", capacityAccountId: input.slotAlias, sessionAccountId: input.slotAlias };
    }
  }
}

function refreshSessionCapacityAccountId(authJson: unknown): string | null {
  if (!authJson || typeof authJson !== "object" || Array.isArray(authJson)) {
    return null;
  }
  const tokens = (authJson as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const refreshToken = (tokens as Record<string, unknown>).refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return `codex-auth:${createHash("sha256").update(refreshToken).digest("hex")}`;
}
