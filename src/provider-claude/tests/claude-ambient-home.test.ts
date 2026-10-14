import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  type ProcessResult,
  type RedactorPort,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import {
  ClaudeCliTaskExecutionEngine,
  registerClaudeSecrets,
  sessionArtifactFromClaudeAmbientHome,
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
  type ClaudeTaskEngineInput,
} from "../index";
import { claudeCliChildEnv, claudeCliEnvForSession } from "../process/claude-cli-env";

describe("claudeCliChildEnv (ambient-home vs. isolated oauth)", () => {
  const noisyBaseEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/real-operator",
    CLAUDE_CONFIG_DIR: "/Users/real-operator/.claude",
    SECRET_UNRELATED: "should-never-leak",
  };

  it("never injects CLAUDE_CODE_OAUTH_TOKEN for ambient-home, and ignores baseEnv HOME/CLAUDE_CONFIG_DIR", () => {
    const env = claudeCliChildEnv({
      authMode: "ambient-home",
      baseEnv: noisyBaseEnv,
      homeDir: "/tmp/ambient-home",
    });
    expect(env.HOME).toBe("/tmp/ambient-home");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("SECRET_UNRELATED");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.CI).toBe("true");
  });

  it("sets CLAUDE_CONFIG_DIR only when explicitly supplied for ambient-home", () => {
    const env = claudeCliChildEnv({
      authMode: "ambient-home",
      baseEnv: noisyBaseEnv,
      homeDir: "/tmp/ambient-home",
      configDir: "/tmp/ambient-home/.claude",
    });
    expect(env.HOME).toBe("/tmp/ambient-home");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/ambient-home/.claude");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("keeps the isolated OAuth path unchanged: HOME/CLAUDE_CONFIG_DIR pinned, token injected", () => {
    const env = claudeCliChildEnv({
      authMode: "oauth",
      baseEnv: noisyBaseEnv,
      configDir: "/tmp/isolated-config",
      oauthToken: "claude-oauth-secret",
    });
    expect(env.HOME).toBe("/tmp/isolated-config");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/isolated-config");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-secret");
  });

  it("claudeCliEnvForSession still requires configDir for an oauth session", () => {
    expect(() =>
      claudeCliEnvForSession({
        session: { authMode: "oauth", oauthToken: "secret" },
        baseEnv: noisyBaseEnv,
      }),
    ).toThrow("claude_config_dir_required");
  });

  it("claudeCliEnvForSession does not require configDir for an ambient-home session", () => {
    const env = claudeCliEnvForSession({
      session: { authMode: "ambient-home", homeDir: "/tmp/ambient-home" },
      baseEnv: noisyBaseEnv,
    });
    expect(env.HOME).toBe("/tmp/ambient-home");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("Claude session artifact", () => {
  it("validates json and env-token Claude sessions", () => {
    const jsonResult = validateClaudeSessionArtifact(sessionArtifactFromClaudeOAuth({
      oauthToken: "claude-oauth-secret",
      configDir: "/tmp/claude-config",
      refreshedAt: "2026-06-01T00:00:00.000Z",
    }));
    const envResult = validateClaudeSessionArtifact({
      kind: "env-token",
      providerId: "claude",
      formatVersion: "claude-oauth-session-v1",
      bytes: new TextEncoder().encode("env-claude-token"),
      contentType: "text/plain",
    });

    expect(jsonResult.session).toMatchObject({
      authMode: "oauth",
      oauthToken: "claude-oauth-secret",
      configDir: "/tmp/claude-config",
    });
    if (envResult.session.authMode !== "oauth") {
      throw new Error("expected an oauth session artifact");
    }
    expect(envResult.session.oauthToken).toBe("env-claude-token");
  });


  it("round-trips through sessionArtifactFromClaudeAmbientHome / validateClaudeSessionArtifact", () => {
    const artifact = sessionArtifactFromClaudeAmbientHome({
      homeDir: "/tmp/ambient-home",
      configDir: "/tmp/ambient-home/.claude",
    });
    const validation = validateClaudeSessionArtifact(artifact);
    expect(validation.session).toEqual({
      authMode: "ambient-home",
      homeDir: "/tmp/ambient-home",
      configDir: "/tmp/ambient-home/.claude",
    });
    expect(validation.warnings).toEqual([]);
  });

  it("rejects an ambient-home artifact with a missing homeDir", () => {
    const artifact = sessionArtifactFromClaudeAmbientHome({ homeDir: "x" });
    (artifact as { bytes: Uint8Array }).bytes = new TextEncoder().encode(
      JSON.stringify({ authMode: "ambient-home" }),
    );
    expect(() => validateClaudeSessionArtifact(artifact)).toThrow(
      "claude_ambient_home_dir_missing",
    );
  });

  it("never registers ambient-home state as a secret", () => {
    const redactor = new DefaultRedactor();
    const registered: unknown[] = [];
    const spyRedactor: RedactorPort = {
      registerSecret: (...args) => {
        registered.push(args);
        redactor.registerSecret(...args);
      },
      redact: (input) => redactor.redact(input),
      assertNoKnownSecret: (...args) => redactor.assertNoKnownSecret(...args),
    };
    registerClaudeSecrets(spyRedactor, {
      authMode: "ambient-home",
      homeDir: "/tmp/ambient-home",
    });
    expect(registered).toHaveLength(0);
  });

  it("still registers the oauth token as a secret", () => {
    const redactor = new DefaultRedactor();
    const registered: unknown[] = [];
    const spyRedactor: RedactorPort = {
      registerSecret: (...args) => {
        registered.push(args);
        redactor.registerSecret(...args);
      },
      redact: (input) => redactor.redact(input),
      assertNoKnownSecret: (...args) => redactor.assertNoKnownSecret(...args),
    };
    registerClaudeSecrets(spyRedactor, {
      authMode: "oauth",
      oauthToken: "claude-oauth-secret",
    });
    expect(registered).toHaveLength(1);
  });
});

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "spawn-test-runner",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: false,
  supportsReadOnlySandbox: false,
  readOnlyFilesystem: false,
  platform: "node-process",
};

/** Minimal real-subprocess RunnerPort: spawns the given command exactly as the production NodeProcessRunner would, without depending on the worker-local layer from a provider-claude test. */
class SpawnRunner implements RunnerPort {
  readonly runnerId = runnerCapabilities.runnerId;
  readonly capabilities = runnerCapabilities;

  async run(
    input: Parameters<RunnerPort["run"]>[0],
  ): Promise<ProcessResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

async function writeFakeClaudePrintBinary(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  home: process.env.HOME ?? null,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  hasOauthToken: Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CODE_OAUTH_TOKEN"),
}));
`,
    "utf8",
  );
  await chmod(path, 0o700);
}

function baseEngineInput(
  overrides: Partial<ClaudeTaskEngineInput>,
): ClaudeTaskEngineInput {
  return {
    prompt: "hello from ambient-home test",
    workspacePath: process.cwd(),
    runner: new SpawnRunner(),
    redactor: new DefaultRedactor(),
    model: "sonnet",
    abortSignal: new AbortController().signal,
    session: { authMode: "ambient-home", homeDir: "/tmp/unused" },
    ...overrides,
  };
}

describe("ClaudeCliTaskExecutionEngine against a fake Claude CLI binary", () => {
  it.each(["hosted-TEST-job", ""])("refuses ambient execution with sandbox marker %j before spawning", async (marker) => {
    const rootDir = await mkdtemp(join(tmpdir(), "pr168-TEST-engine-"));
    const launchPath = join(rootDir, "TEST-launched");
    const binaryPath = join(rootDir, "TEST-claude.cjs");
    try {
      await writeFile(binaryPath, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(launchPath)}, "TEST launched");\n`);
      await chmod(binaryPath, 0o700);
      const engine = new ClaudeCliTaskExecutionEngine({
        claudePath: binaryPath,
        baseEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: marker },
      });
      await expect(engine.run(baseEngineInput({
        workspacePath: rootDir,
        session: { authMode: "ambient-home", homeDir: join(rootDir, "TEST-home") },
      }))).rejects.toThrow("claude_ambient_home_hosted_context_denied");
      await expect(readFile(launchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("passes the explicit ambient HOME to the child process without an oauth token or an inherited HOME", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "claude-ambient-home-fake-"));
    const fakeClaudePath = join(tempDir, "fake-claude.mjs");
    const fakeAmbientHome = join(tempDir, "ambient-home");
    try {
      await writeFakeClaudePrintBinary(fakeClaudePath);
      const engine = new ClaudeCliTaskExecutionEngine({
        claudePath: fakeClaudePath,
        baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/Users/real-operator" },
      });
      const result = await engine.run(
        baseEngineInput({
          session: { authMode: "ambient-home", homeDir: fakeAmbientHome },
        }),
      );
      const observed = JSON.parse(result.outputText);
      expect(observed).toEqual({
        home: fakeAmbientHome,
        claudeConfigDir: null,
        hasOauthToken: false,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("still passes CLAUDE_CODE_OAUTH_TOKEN and the isolated config dir for the default oauth session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "claude-oauth-fake-"));
    const fakeClaudePath = join(tempDir, "fake-claude.mjs");
    const isolatedConfigDir = join(tempDir, "isolated-config");
    try {
      await writeFakeClaudePrintBinary(fakeClaudePath);
      const engine = new ClaudeCliTaskExecutionEngine({
        claudePath: fakeClaudePath,
        baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      const result = await engine.run(
        baseEngineInput({
          session: {
            authMode: "oauth",
            oauthToken: "claude-oauth-secret",
            configDir: isolatedConfigDir,
          },
        }),
      );
      const observed = JSON.parse(result.outputText);
      expect(observed).toEqual({
        home: isolatedConfigDir,
        claudeConfigDir: isolatedConfigDir,
        hasOauthToken: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
