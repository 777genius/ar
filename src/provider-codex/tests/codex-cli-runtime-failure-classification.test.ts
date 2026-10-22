import { describe, expect, it } from "vitest";
import { classifyCodexRuntimeFailure } from "../codex-cli-domain";

describe("classifyCodexRuntimeFailure transient provider classes", () => {
  it.each([
    ["proxy_upstream_failed with upstream 401", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":401}', "provider_session_invalid"],
    ["proxy_upstream_failed with upstream 403", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":403}', "provider_session_invalid"],
    ["proxy_upstream_failed with upstream 503", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":503}', "needs_reconnect"],
    ["proxy_upstream_failed with upstream 502", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":502}', "needs_reconnect"],
    ["proxy_upstream_failed without upstream status", "codex_app_server_error: proxy_upstream_failed upstream unreachable", "needs_reconnect"],
    ["waiting for network", "codex_app_server_error: waiting for network to become reachable", "needs_reconnect"],
    ["ECONNRESET transport drop", "request failed: read ECONNRESET", "needs_reconnect"],
    ["socket hang up", "other side closed: socket hang up", "needs_reconnect"],
    ["fetch failed", "fetch failed while refreshing session", "needs_reconnect"],
    ["EAI_AGAIN dns", "getaddrinfo EAI_AGAIN token-plan-sgp.xiaomimimo.com", "needs_reconnect"],
  ])("classifies %s", (_label, message, expected) => {
    expect(classifyCodexRuntimeFailure(message)).toBe(expected);
  });

  it("keeps upstream quota at the quota class, not reconnect", () => {
    expect(classifyCodexRuntimeFailure('codex_app_server_error: proxy_upstream_failed {"upstream_status":429}')).toBe("quota_limited");
    expect(classifyCodexRuntimeFailure("rate limit exceeded, try later")).toBe("quota_limited");
  });

  it.each([
    ["token_invalidated with reconnecting text", "token_invalidated while reconnecting", "provider_session_invalid"],
    ["invalid auth.json with fetch failed", "codex_auth_json_invalid_format: fetch failed", "provider_session_invalid"],
    ["upstream 401 over transport text", 'proxy_upstream_failed {"upstream_status":401} socket hang up', "provider_session_invalid"],
  ])("prefers the auth class over transport fragments for %s", (_label, message, expected) => {
    expect(classifyCodexRuntimeFailure(message)).toBe(expected);
  });

  it.each([
    ["upstream 400", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":400}'],
    ["upstream 404", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":404}'],
    ["upstream 422", 'codex_app_server_error: proxy_upstream_failed {"upstream_status":422}'],
  ])("does not reconnect a permanent %s refusal", (_label, message) => {
    expect(classifyCodexRuntimeFailure(message)).not.toBe("needs_reconnect");
  });

  it.each([
    ["SessionBudgetExceeded", "budget_exceeded"],
    ["codex_app_server_goal_max_turns_exceeded", "goal_slice_exhausted"],
    ["usage_limit_exceeded", "quota_limited"],
    ["unauthorized: token rejected", "needs_reconnect"],
    ["invalid_grant", "needs_reconnect"],
  ])("preserves the existing class for %s", (message, expected) => {
    expect(classifyCodexRuntimeFailure(message)).toBe(expected);
  });
});
