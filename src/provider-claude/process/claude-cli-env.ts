import type { ClaudeOAuthSession } from "../session/session-artifact";

export type ClaudeCliChildEnvInput =
  | {
      readonly authMode: "oauth";
      readonly baseEnv: Readonly<Record<string, string | undefined>>;
      readonly configDir: string;
      readonly oauthToken: string;
    }
  | {
      readonly authMode: "ambient-home";
      readonly baseEnv: Readonly<Record<string, string | undefined>>;
      readonly homeDir: string;
      readonly configDir?: string;
    };

/**
 * Isolated OAuth mode always pins HOME/CLAUDE_CONFIG_DIR to the same
 * subscription-runtime-managed directory and injects CLAUDE_CODE_OAUTH_TOKEN.
 * Ambient-home mode never injects a token: HOME points at the caller-supplied
 * ambient directory, and CLAUDE_CONFIG_DIR is only set when explicitly given
 * (otherwise the installed Claude CLI resolves its own default under HOME,
 * exactly as it would for a direct, non-runtime invocation).
 */
export function claudeCliChildEnv(
  input: ClaudeCliChildEnvInput,
): Readonly<Record<string, string>> {
  const shared = {
    ...pruneClaudeChildEnv(input.baseEnv),
    CI: "true",
  };
  if (input.authMode === "ambient-home") {
    assertClaudeAmbientHomeLocalContext(input.baseEnv);
    return definedEnv({
      ...shared,
      HOME: input.homeDir,
      ...(input.configDir === undefined
        ? {}
        : { CLAUDE_CONFIG_DIR: input.configDir }),
    });
  }
  return definedEnv({
    ...shared,
    HOME: input.configDir,
    CLAUDE_CONFIG_DIR: input.configDir,
    CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken,
  });
}

/**
 * Shared branch used by every engine that shells out via claudeCliChildEnv
 * (the CLI print engine and the Agent SDK engine). Requires configDir for the
 * oauth session, exactly as before; ambient-home sessions never need one.
 */
export function claudeCliEnvForSession(input: {
  readonly session: ClaudeOAuthSession;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, string>> {
  const { session, baseEnv } = input;
  if (session.authMode === "ambient-home") {
    return claudeCliChildEnv({
      authMode: "ambient-home",
      baseEnv,
      homeDir: session.homeDir,
      ...(session.configDir === undefined ? {} : { configDir: session.configDir }),
    });
  }
  if (!session.configDir) throw new Error("claude_config_dir_required");
  return claudeCliChildEnv({
    authMode: "oauth",
    baseEnv,
    configDir: session.configDir,
    oauthToken: session.oauthToken,
  });
}

function pruneClaudeChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const allowed = new Set([
    "CI",
    "LANG",
    "LC_ALL",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) =>
      value !== undefined &&
      (allowed.has(key) || key.startsWith("LC_"))
    ),
  );
}

function definedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  );
}

/** Check the marker before pruning the environment; an empty marker is present. */
export function assertClaudeAmbientHomeLocalContext(
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== undefined) {
    throw new Error("claude_ambient_home_hosted_context_denied");
  }
}
