import { describe, expect, it } from "vitest";
import { assertHostedDependencyParentEnvironment, assertHostedDependencyParentRecipe } from "../app-server/adapters/hosted-dependency-parent-recipe";
const job = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-parent", workspace = `${job}/workspace`;
const args = ["/opt/test-runtime/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", "TEST-parent", "--job-root", job,
  "--workspace", workspace, "--prompt", `${job}/prompt`, "--auth-root", `${job}/auth`, "--output", `${job}/TEST-parent.latest-result.json`];
describe("N3 fixed initial-host writer configuration", () => {
  it.each(["read-only", "workspace-write"])("accepts safe default roots for named mode %s", mode => {
    expect(() => assertHostedDependencyParentRecipe([...args, "--provider-sandbox-mode", mode], job, workspace)).not.toThrow();
  });
  it("rejects root writes into the qualified tree or private cache before the payload", () => {
    for (const flag of ["--state-root", "--durable-handoff-root", "--progress", "--output", "--registry-root", "--log"]) {
      const base = flag === "--output" ? args.slice(0, -2) : args;
      for (const target of [`${workspace}/node_modules/marker`, `${job}/tool-cache/vite-vitest-config-free-v1/marker`]) {
        expect(() => assertHostedDependencyParentRecipe([...base, flag, target], job, workspace)).toThrow();
      }
    }
  });
  it("rejects duplicate, equals, alias and unknown writer options", () => {
    for (const tail of [["--task-id", "other"], ["--state-root=/tmp"], ["--state-root", `${job}/state/../workspace`],
      ["--new-writer-root", `${workspace}/node_modules`], ["--dry-run"],
      ["--execution-engine", "codex-cli"], ["--model-backend", "xiaomi-mimo-token-plan"]]) {
      expect(() => assertHostedDependencyParentRecipe([...args, ...tail], job, workspace)).toThrow();
    }
  });
  it("rejects inherited root temp/handoff/loader/PATH redirects while retaining fixed defaults", () => {
    expect(() => assertHostedDependencyParentEnvironment({ PATH: "/usr/bin:/bin", SUBSCRIPTION_RUNTIME_TMPDIR: `${job}/tmp` }, job)).not.toThrow();
    for (const env of [{ SUBSCRIPTION_RUNTIME_TMPDIR: `${workspace}/node_modules` },
      { SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT: `${workspace}/node_modules` }, { PATH: `${workspace}/bin:/usr/bin:/bin` },
      { NODE_OPTIONS: "--import=./payload.js" }, { GIT_CONFIG_GLOBAL: `${workspace}/payload` },
      { CODEX_EXECUTION_ENGINE: "codex-cli" }, { CODEX_MODEL_BACKEND: "xiaomi-mimo-token-plan" },
      { SUBSCRIPTION_RUNTIME_PROJECT_ACCESS_SCOPE_JSON: "{}" },
      { SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: `${workspace}/node_modules/auth` }]) {
      expect(() => assertHostedDependencyParentEnvironment(env, job)).toThrow();
    }
  });
  it("requires the explicit enrolled auth leaf before capacity migration, independent of HOME defaults", () => {
    const withoutAuth = args.filter((_, i) => i !== 10 && i !== 11);
    expect(() => assertHostedDependencyParentRecipe(withoutAuth, job, workspace)).toThrow();
    for (const auth of [`${workspace}/node_modules/auth`, `${job}/tool-cache/auth`, "~/.cache/subscription-runtime/live-codex-auth",
      `${job}/auth/../auth`, "/tmp/auth"]) {
      const redirected = [...args]; redirected[11] = auth;
      expect(() => assertHostedDependencyParentRecipe(redirected, job, workspace)).toThrow();
    }
    expect(() => assertHostedDependencyParentEnvironment({ HOME: `${workspace}/node_modules`, SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: `${job}/auth` }, job)).not.toThrow();
  });
});
