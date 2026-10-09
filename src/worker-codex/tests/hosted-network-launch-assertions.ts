import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { codexProviderEgressCliConfigArgs, codexProviderEgressPolicy, codexProviderHasPublicSources,
  CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import type { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { hostedCredentialDenyDirectories } from "../../provider-codex/hosted-codex-permissions";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { spawnCodexAppServerProcess } from "../../provider-codex/app-server/adapters/node-app-server-process";

export async function assertDefaultInternetEngine(identity: Parameters<typeof admitHostedTestEgress>[0] & {
  readonly sourceEnv: Readonly<Record<string, string>>;
},
  launch: Parameters<typeof spawnCodexAppServerProcess>[0]): Promise<void> {
  if (identity.executionEngine === "packaged-exec" || identity.executionEngine === "plain-exec") {
    await expect(admitHostedTestEgress(identity)).rejects.toThrow("hosted_permission_profiles_engine_unsupported");
    return;
  }
  const policy = await admitHostedTestEgress(identity);
  expect(policy.profileId).toBe(CodexProviderEgressProfileId.FullInternetV1);
  expect(() => spawnCodexAppServerProcess({ ...launch, env: identity.sourceEnv })).toThrow();
  expect(admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy })).toBeUndefined();
}

/** Verify captured launch bytes and materialized config, across account fallback. */
export function assertHostedNetworkLaunch(frames: readonly { env: Record<string, string>; args: string[] }[],
  profileId: CodexProviderEgressProfileId, providers: readonly FakeAppServerFactory[]): void {
  const policy = codexProviderEgressPolicy(profileId);
  for (const frame of frames) {
    expect(frame.args.slice(-4)).toEqual(codexProviderEgressCliConfigArgs(policy, { namedPermissions: true }));
    if (profileId === CodexProviderEgressProfileId.FullInternetV1) {
      const config = readFileSync(join(frame.env.CODEX_HOME!, "config.toml"), "utf8");
      expect(config).toContain('[features.network_proxy]\nenabled = false');
      expect(config).toContain('":root" = "deny"');
      expect(config).toContain('".git" = "read"');
      for (const dir of hostedCredentialDenyDirectories) expect(config).toContain(`"${dir}" = "deny"`);
      expect(config).not.toContain('"/etc/subscription-runtime/secrets"');
    }
  }
  if (codexProviderHasPublicSources(policy)) for (const provider of providers.filter(p => p.spawnCount)) {
    expect(provider.requests.find(row => row.method === "thread/start")?.params).toMatchObject({
      config: { web_search: "live" }, dynamicTools: [{ name: "public_source_read" }],
    });
  }
}
