import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  codexProviderApiEgressPolicy, codexProviderEgressPolicy, CodexProviderEgressProfileId,
  codexProviderEgressPolicyFromEnv, codexProviderEgressConfigToml, codexProviderEgressCliConfigArgs, codexProviderEgressEnv,
} from "../codex-provider-egress-policy";
import { codexJsonHomeConfigToml, CodexWorkerCacheSessionPoolMaterializer } from "../codex-session-materializer";
import { sessionArtifactFromCodexAuthJson } from "../codex-auth-json-codec";
import { buildCodexRefreshBootstrapPlan } from "../codex-cli-domain";
import { codexAppServerSandboxPolicy } from "../app-server/domain/app-server-types";
import { egressBoundCodexProcessFactory } from "../app-server/adapters/egress-bound-process";
import { codexAppServerProcessInvocation } from "../app-server/adapters/node-app-server-process";
import type { CodexAppServerChildProcess, CodexAppServerProcessFactory } from "../app-server/application/app-server-process-port";

const testPolicy = () => codexProviderEgressPolicy(CodexProviderEgressProfileId.TestNpmQualification);
const managedPolicy = () => codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification);
const policies = [codexProviderApiEgressPolicy(), testPolicy(), managedPolicy()];
describe("finite TEST egress propagation", () => {
  it("keeps defaults API-only, freezes domains, and refuses unknown profiles", () => {
    expect(codexProviderApiEgressPolicy().domains).toEqual(["api.openai.com"]);
    expect(testPolicy().domains).toEqual(["api.openai.com", "registry.npmjs.org", "tuf-repo-cdn.sigstore.dev"]);
    expect(managedPolicy().domains).toEqual(["api.openai.com", "registry.npmjs.org", "tuf-repo-cdn.sigstore.dev", "api.github.com", "raw.githubusercontent.com"]);
    for (const policy of policies) {
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.domains)).toBe(true);
      expect(codexProviderEgressPolicyFromEnv(codexProviderEgressEnv(policy))).toEqual(policy);
    }
    for (const marker of ["unknown", "api.github.com", "*.github.com", "https://api.github.com/", ""]) {
      expect(codexProviderEgressPolicyFromEnv({ SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: marker })).toBeNull();
      expect(() => codexProviderEgressPolicy(marker as CodexProviderEgressProfileId)).toThrow("codex_provider_egress_profile_invalid");
    }
    expect(() => (testPolicy().domains as string[]).push("*")).toThrow();
    expect(() => codexProviderEgressPolicy("other" as CodexProviderEgressProfileId)).toThrow();
    expect(codexProviderEgressConfigToml()).not.toContain("registry.npmjs.org");
  });
  it.each(policies)("reconstructs a fixed domain set even if a caller tampers: $profileId", policy => {
    const forged = { profileId: policy.profileId, domains: ["evil.example", "*.github.com", "https://api.github.com/"] };
    expect(codexProviderEgressConfigToml(forged)).not.toContain("evil.example");
    expect(codexProviderEgressCliConfigArgs(forged)).toEqual(codexProviderEgressCliConfigArgs(policy));
    expect(codexProviderEgressConfigToml(forged)).toBe(codexProviderEgressConfigToml(policy));
  });
  it.each(policies)("captures policy before namespace launch: $profileId", policy => {
    const observed: Parameters<CodexAppServerProcessFactory>[0][] = [];
    const spawn: CodexAppServerProcessFactory = input => {
      observed.push(input); return {} as CodexAppServerChildProcess;
    };
    egressBoundCodexProcessFactory(policy, spawn)({
      command: "/synthetic/codex", args: ["app-server", "--listen", "stdio://", "--config", "features.network_proxy.enabled=false",
        "--config", 'features.network_proxy.domains={ "unrelated.invalid" = "allow" }'], cwd: "/synthetic/home",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
        SUBSCRIPTION_RUNTIME_JOB_ID: "synthetic-job",
        SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "forged" },
    });
    const input = observed[0]!;
    expect(input.env).toMatchObject(codexProviderEgressEnv(policy));
    expect(input.args.slice(-6)).toEqual(codexProviderEgressCliConfigArgs(policy));
    // The final whole-table CLI assignment follows any conflicting earlier overrides.
    expect(input.args.at(-1)).not.toContain("unrelated.invalid");
    expect(codexAppServerSandboxPolicy({ workspacePath: "/synthetic/workspace",
      sourceEnv: input.env })).toMatchObject({ networkAccess: true });
    const invocation = codexAppServerProcessInvocation({ ...input, platform: "linux" });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[1]).toBe("provider");
    expect(JSON.parse(invocation.args[2]!).operation).toBe("provider");
    expect(JSON.parse(invocation.stdinBootstrap!).args).toEqual(input.args);
  });
  it("keeps refresh bootstrap explicitly API-only", () => {
    const plan = buildCodexRefreshBootstrapPlan({ codexBinaryPath: "/synthetic/codex",
      tempHome: "/synthetic/home", tempCodexHome: "/synthetic/codex-home",
      emptyWorkingDirectory: "/synthetic/empty", authJsonPath: "/synthetic/auth.json" });
    expect(plan.args).toEqual(expect.arrayContaining([...codexProviderEgressCliConfigArgs()]));
    expect(plan.args.join(" ")).not.toContain("registry.npmjs.org");
    expect(plan.args.join(" ")).not.toContain("tuf-repo-cdn.sigstore.dev");
  });
  it("isolates and reopens all three cache roots with the same worker key", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-egress-cache-"));
    const materializers: CodexWorkerCacheSessionPoolMaterializer[] = [];
    const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "fixture-id", access_token: "fixture-access", refresh_token: "fixture-refresh", account_id: "fixture-account" }, last_refresh: "2026-09-06T00:00:00.000Z" });
    const input = { session: sessionArtifactFromCodexAuthJson(auth), redactor: new DefaultRedactor() };
    try {
      const homes: string[] = [];
      for (const policy of [...policies, ...policies]) {
        const m = new CodexWorkerCacheSessionPoolMaterializer({
          cacheKey: "same-test-worker", slots: 1, rootDir: root,
          providerEgressPolicy: policy, preserveOnDispose: true, scrubAuthOnDispose: true,
        });
        materializers.push(m);
        const session = await m.materialize(input);
        try {
          homes.push(session.codexHome);
          const config = await readFile(join(session.codexHome, "config.toml"), "utf8");
          expect(config).toBe(codexJsonHomeConfigToml({ providerEgressPolicy: policy }));
          const key = "same-test-worker:slot:1" + (policy.profileId === CodexProviderEgressProfileId.ProviderApi ? "" : `:${policy.profileId}`);
          const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
          expect(session.codexHome).toBe(join(root, `codex-${hash}`, "codex-home"));
          expect(session.env).toMatchObject(codexProviderEgressEnv(policy));
        } finally { await session.release(); }
        await m.dispose();
      }
      expect(new Set(homes.slice(0, 3)).size).toBe(3);
      expect(homes.slice(3)).toEqual(homes.slice(0, 3));
    } finally {
      await Promise.all(materializers.map(m => m.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
