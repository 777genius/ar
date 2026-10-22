import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexCliAgentDriver } from "../codex-cli-agent-driver";
import {
  CodexModelBackend,
  codexMimoApiKeyEnvVarDefault,
  codexMimoConfirmedBaseUrl,
  codexMimoDefaultModel,
} from "../codex-model-backend";
import { codexProviderEgressProfileEnvVar, CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { StaticRunner } from "./codex-provider-test-support";

const FAKE_MIMO_KEY = "tp-fixture-not-a-real-token-plan-key-0000000000";

describe("CodexCliAgentDriver MiMo backend", () => {
  it("runs a session-less MiMo task: custom model_provider config, no auth.json, disabled web_search", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-mimo-test-"));
    let observedConfigToml = "";
    let authJsonExists = true;
    const runner = new StaticRunner("mimo output", async (input) => {
      const codexHome = input.env.CODEX_HOME!;
      observedConfigToml = await readFile(join(codexHome, "config.toml"), "utf8");
      authJsonExists = await stat(join(codexHome, "auth.json")).then(() => true, () => false);
    });
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      sourceEnv: { [codexMimoApiKeyEnvVarDefault]: FAKE_MIMO_KEY },
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "completed", outputText: "mimo output" });

      expect(runner.lastArgs).toContain(codexMimoDefaultModel);
      expect(runner.lastArgs).toContain("--config");
      expect(runner.lastArgs).toContain('model_provider="mimo"');

      expect(authJsonExists).toBe(false);
      expect(observedConfigToml).toContain("[model_providers.mimo]");
      expect(observedConfigToml).toContain(`base_url = ${JSON.stringify(codexMimoConfirmedBaseUrl)}`);
      expect(observedConfigToml).toContain('wire_api = "responses"');
      expect(observedConfigToml).toContain(`env_key = ${JSON.stringify(codexMimoApiKeyEnvVarDefault)}`);
      expect(observedConfigToml).toContain('web_search = "disabled"');
      // The key must never be reachable from model-executed shell tool calls.
      expect(observedConfigToml).not.toContain(FAKE_MIMO_KEY);
      expect(observedConfigToml.match(/include_only = \[([^\]]*)\]/)?.[1] ?? "").not.toContain(
        codexMimoApiKeyEnvVarDefault,
      );

      expect(runner.lastEnv?.[codexMimoApiKeyEnvVarDefault]).toBe(FAKE_MIMO_KEY);
      expect(runner.lastEnv?.[codexProviderEgressProfileEnvVar]).toBe(
        CodexProviderEgressProfileId.MimoTokenPlan,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("never mixes the MiMo egress domain with the OpenAI one", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-mimo-egress-test-"));
    let observedConfigToml = "";
    const runner = new StaticRunner("mimo output", async (input) => {
      const codexHome = input.env.CODEX_HOME!;
      observedConfigToml = await readFile(join(codexHome, "config.toml"), "utf8");
    });
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      sourceEnv: { [codexMimoApiKeyEnvVarDefault]: FAKE_MIMO_KEY },
    });

    try {
      await driver.runTask({
        session: null,
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(observedConfigToml).toContain("token-plan-sgp.xiaomimimo.com");
      expect(observedConfigToml).not.toContain("api.openai.com");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed with a safe message when the MiMo credential env var is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-mimo-missing-key-test-"));
    const runner = new StaticRunner("unused");
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      sourceEnv: {},
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("failed");
      // A missing env key is a local configuration gap, not a dead provider
      // session: provider_session_invalid would disable the shared account
      // capacity record (disabled, never rechecked) for every later run, and
      // a reconnect cannot fix a missing env var.
      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "provider_runtime_unavailable",
          retryable: false,
          reconnectRequired: false,
        },
      });
      if (result.status === "failed") {
        expect(result.failure.safeMessage).toContain(codexMimoApiKeyEnvVarDefault);
        expect(result.failure.safeMessage).not.toContain(FAKE_MIMO_KEY);
      }
      expect(runner.lastArgs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts the MiMo key out of returned stdout even if the process echoes it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-mimo-leak-test-"));
    const runner = new StaticRunner(`leaked key: ${FAKE_MIMO_KEY}`);
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      sourceEnv: { [codexMimoApiKeyEnvVarDefault]: FAKE_MIMO_KEY },
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.outputText).not.toContain(FAKE_MIMO_KEY);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("still requires a session artifact on the default OpenAI/ChatGPT backend", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-chatgpt-still-required-test-"));
    const runner = new StaticRunner("unused");
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      modelBackend: CodexModelBackend.OpenAiChatGpt,
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "provider_session_invalid" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
