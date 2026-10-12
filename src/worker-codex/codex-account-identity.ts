import { createHash } from "node:crypto";
import {
  validateCodexAuthJsonBytes,
  type ValidatedCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";

export type CodexAccountIdentity = {
  readonly label: string;
  readonly key: string;
  readonly hash: string;
  readonly source: string;
};

export function codexAccountIdentityFromAuthJson(input: {
  readonly authJson: string;
  readonly label: string;
}): CodexAccountIdentity {
  const validation = validateCodexAuthJsonBytes({
    authJsonBytes: input.authJson,
  });
  const identity = resolveCodexAccountIdentity(validation.parsed);
  return {
    label: input.label,
    key: identity.key,
    hash: hashText(identity.key).slice(0, 16),
    source: identity.source,
  };
}

function resolveCodexAccountIdentity(authJson: ValidatedCodexAuthJson): {
  readonly key: string;
  readonly source: string;
} {
  const directAccountId = firstNonEmptyString(
    authJson.tokens.account_id,
    authJson.tokens.chatgpt_account_id,
    authJson.account_id,
    authJson.chatgpt_account_id,
  );
  if (directAccountId) {
    return {
      key: `account:${directAccountId.toLowerCase()}`,
      source: "auth_json_account_id",
    };
  }

  const idTokenClaims = decodeJwtClaims(authJson.tokens.id_token);
  if (idTokenClaims) {
    const authNamespace = objectClaim(
      idTokenClaims["https://api.openai.com/auth"],
    );
    const accountId = firstNonEmptyString(
      idTokenClaims["https://api.openai.com/auth.chatgpt_account_id"],
      idTokenClaims["chatgpt_account_id"],
      idTokenClaims["account_id"],
      authNamespace?.chatgpt_account_id,
      authNamespace?.account_id,
      idTokenClaims["sub"],
    );
    if (accountId) {
      return {
        key: `account:${accountId.toLowerCase()}`,
        source: "id_token_account_id",
      };
    }

    const email = firstNonEmptyString(
      idTokenClaims["https://api.openai.com/profile.email"],
      idTokenClaims["email"],
      authNamespace?.email,
    );
    if (email) {
      return {
        key: `email:${email.toLowerCase()}`,
        source: "id_token_email",
      };
    }
  }

  return {
    key: `refresh:${hashText(authJson.tokens.refresh_token)}`,
    source: "refresh_token_hash",
  };
}

function decodeJwtClaims(
  token: string | undefined,
): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function objectClaim(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Default pool identity shared by allocation planning and worker creation. */
export function codexSafeExecutorId(workspacePath: string): string {
  return `file-backend-codex-safe:${hashText(workspacePath).slice(0, 12)}`;
}
