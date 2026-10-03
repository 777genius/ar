import { describe, expect, it } from "vitest";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { CodexModelBackend } from "../../codex-model-backend";

describe("Codex app-server execution engine options", () => {
  it("fails closed before creating a hosted dynamic tool engine with an unconfined effective route", () => {
    const hostedControllerTools = { dispatch: async () => ({ status: "disabled" as const }) };
    expect(() => new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/test",
      hostedControllerTools, goalMode: true, nativeToolSurface: "disabled", cleanThreadPrewarm: false }))
      .toThrow("hosted_controller_engine_profile_invalid");
    expect(() => new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/test",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, hostedControllerTools,
      goalMode: true, nativeToolSurface: "disabled", cleanThreadPrewarm: false })).not.toThrow();
  });
  it("rejects invalid startup timeout options", () => {
    expect(() =>
      new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        timeoutMs: 0,
      })
    ).toThrow("codex_app_server_timeout_invalid");
    expect(() =>
      new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        startupTimeoutMs: 0,
      })
    ).toThrow("codex_app_server_startup_timeout_invalid");
    expect(() =>
      new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        startupTimeoutMs: 1.5,
      })
    ).toThrow("codex_app_server_startup_timeout_invalid");
  });
});
