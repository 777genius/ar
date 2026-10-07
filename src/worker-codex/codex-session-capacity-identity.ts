import { createHash } from "node:crypto";
import { AgentProvider, identityFromAuthJson } from "@vioxen/agent-account-observability";

export function isCodexSessionCapacityAccountId(value: unknown): value is string {
  return typeof value === "string" && /^codex-session:[a-f0-9]{64}$/.test(value);
}

/** A refresh session is stable across access-token renewal and file rewrites.
 * Only its opaque digest may enter the shared capacity store. */
export function codexSessionCapacityAccountId(authJson: unknown): string | null {
  if (!authJson || typeof authJson !== "object" || Array.isArray(authJson)) return null;
  const tokens = (authJson as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const refreshToken = (tokens as Record<string, unknown>).refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  const identity = identityFromAuthJson(authJson, { provider: AgentProvider.Codex,
    slotId: "session-capacity", authHome: "/", authJsonPath: "/auth.json" });
  return `codex-session:${createHash("sha256")
    .update(JSON.stringify([identity.accountKeyHash ?? null, refreshToken])).digest("hex")}`;
}
