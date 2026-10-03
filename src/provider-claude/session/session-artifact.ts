import type {
  ProviderFailure,
  RuntimeWarning,
  SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import { claudeProviderId, claudeSessionFormatVersion } from "../capabilities";
import { classifyClaudeFailure } from "../protocol/failure-classifier";

export type ClaudeOAuthTokenSession = {
  readonly authMode: "oauth";
  readonly oauthToken: string;
  readonly configDir?: string;
  readonly refreshedAt?: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

/**
 * Local-only, explicit opt-in mode: invokes the installed Claude CLI against
 * an already-authenticated ambient HOME/CLAUDE_CONFIG_DIR instead of a
 * subscription-runtime-managed OAuth session. Carries no token or other
 * credential bytes — subscription-runtime never reads, copies or mutates
 * whatever auth/session state the Claude CLI keeps under homeDir/configDir.
 */
export type ClaudeAmbientHomeSession = {
  readonly authMode: "ambient-home";
  readonly homeDir: string;
  readonly configDir?: string;
};

export type ClaudeOAuthSession = ClaudeOAuthTokenSession | ClaudeAmbientHomeSession;

export type ClaudeSessionValidation = {
  readonly session: ClaudeOAuthSession;
  readonly warnings: readonly RuntimeWarning[];
};

export function sessionArtifactFromClaudeOAuth(input: {
  readonly oauthToken: string;
  readonly configDir?: string;
  readonly refreshedAt?: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): SessionArtifact {
  const payload: ClaudeOAuthTokenSession = {
    authMode: "oauth",
    oauthToken: input.oauthToken,
    ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
    ...(input.refreshedAt === undefined
      ? {}
      : { refreshedAt: input.refreshedAt }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
  return claudeSessionArtifact(payload);
}

export function sessionArtifactFromClaudeAmbientHome(input: {
  readonly homeDir: string;
  readonly configDir?: string;
}): SessionArtifact {
  const payload: ClaudeAmbientHomeSession = {
    authMode: "ambient-home",
    homeDir: input.homeDir,
    ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
  };
  return claudeSessionArtifact(payload);
}

function claudeSessionArtifact(payload: ClaudeOAuthSession): SessionArtifact {
  return {
    kind: "json-file",
    providerId: claudeProviderId,
    formatVersion: claudeSessionFormatVersion,
    bytes: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
  };
}

export function validateClaudeSessionArtifact(
  artifact: SessionArtifact,
): ClaudeSessionValidation {
  if (artifact.providerId !== claudeProviderId) {
    throw new Error("claude_session_provider_mismatch");
  }
  const text = new TextDecoder().decode(artifact.bytes);
  if (artifact.kind === "env-token") {
    const oauthToken = text.trim();
    if (!oauthToken) throw new Error("claude_oauth_token_missing");
    return {
      session: {
        authMode: "oauth",
        oauthToken,
      },
      warnings: [],
    };
  }
  if (artifact.kind !== "json-file") {
    throw new Error("claude_session_artifact_kind_unsupported");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("claude_session_json_invalid");
  }
  const session = parseClaudeSession(parsed);
  return {
    session,
    warnings: session.authMode === "oauth" ? freshnessWarnings(session) : [],
  };
}

export function invalidClaudeSessionFailure(error: unknown): ProviderFailure {
  const classified = classifyClaudeFailure(error);
  return classified.code === "unknown_runtime_failure"
    ? {
        code: "provider_session_invalid",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Claude session is invalid.",
        causeCategory: "provider_session_invalid",
      }
    : classified;
}

function parseClaudeSession(value: unknown): ClaudeOAuthSession {
  if (!isObject(value)) throw new Error("claude_session_shape_invalid");
  if (value.authMode === "ambient-home") {
    return parseClaudeAmbientHomeSession(value);
  }
  return parseClaudeOAuthTokenSession(value);
}

function parseClaudeOAuthTokenSession(
  value: Record<string, unknown>,
): ClaudeOAuthTokenSession {
  if (value.authMode !== "oauth") {
    throw new Error("claude_session_auth_mode_invalid");
  }
  if (typeof value.oauthToken !== "string" || value.oauthToken.length === 0) {
    throw new Error("claude_oauth_token_missing");
  }
  assertOptionalString(value.configDir, "claude_config_dir_invalid");
  assertOptionalString(value.refreshedAt, "claude_refreshed_at_invalid");
  assertOptionalString(value.expiresAt, "claude_expires_at_invalid");
  if (value.metadata !== undefined && !isStringRecord(value.metadata)) {
    throw new Error("claude_session_metadata_invalid");
  }
  return value as ClaudeOAuthTokenSession;
}

function parseClaudeAmbientHomeSession(
  value: Record<string, unknown>,
): ClaudeAmbientHomeSession {
  if (typeof value.homeDir !== "string" || value.homeDir.length === 0) {
    throw new Error("claude_ambient_home_dir_missing");
  }
  assertOptionalString(value.configDir, "claude_config_dir_invalid");
  return value as ClaudeAmbientHomeSession;
}

function freshnessWarnings(
  session: ClaudeOAuthTokenSession,
): readonly RuntimeWarning[] {
  if (!session.expiresAt) return [];
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return [
      {
        code: "claude_session_expiry_unparseable",
        safeMessage: "Claude session expiry could not be parsed.",
      },
    ];
  }
  if (expiresAtMs <= Date.now()) {
    return [
      {
        code: "claude_session_expired",
        safeMessage: "Claude session appears expired.",
      },
    ];
  }
  return [];
}

function assertOptionalString(value: unknown, code: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(code);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!isObject(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}
