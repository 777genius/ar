import { assertHostedAppServerEngineOptions } from "../../provider-codex/codex-app-server-hosted-admission";
import { describe, expect, it } from "vitest";
import { CodexModelBackend, CodexProviderEgressProfileId, HostedMimoProfile, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { assertResearchMimoProfileMatch, parseResearchOperatorRequest, parseResearchGrant, researchRunConfig, researchHashRequest } from "../research-launch-contract";
import { codexAppServerToolConfig } from "../../provider-codex/app-server/domain/app-server-tool-config";
const request = { schemaVersion: 1, jobId: "TEST-coding", taskId: "TEST-coding", jobRootDir: "/TEST/jobs/coding", workspacePath: "/TEST/workspaces/coding", promptPath: "/TEST/jobs/coding/prompt.md", authRootDir: "/TEST/auth", accounts: ["account-q"], codexBinaryPath: "/TEST/bin/codex", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel, reasoningEffort: "medium", serviceTier: "default", taskTimeoutMs: 180000, maxAccountCycles: 1, prewarmOnStart: false };
function grant(profile: HostedMimoProfile.Worker | HostedMimoProfile.CodingV1) {
  return parseResearchGrant({ schemaVersion: 1, profileId: CodexProviderEgressProfileId.MimoTokenPlan, hostedProfile: profile, jobId: request.jobId, jobRootDir: request.jobRootDir, workspacePath: request.workspacePath, grantId: "11111111-1111-1111-1111-111111111111", jobDirectory: { path: request.jobRootDir, device: 1, inode: 2 }, workspaceDirectory: { path: request.workspacePath, device: 1, inode: 3 } });
}
describe("hosted MiMo coding profile and authority", () => {
  it("freezes the explicit coding default and finite overrides into request hashes", () => {
    const selected = parseResearchOperatorRequest({ ...request, hostedProfile: HostedMimoProfile.CodingV1 });
    expect(selected.maxGoalTurns).toBe(64);
    const changed = parseResearchOperatorRequest({ ...selected, maxGoalTurns: 256 });
    expect(researchHashRequest(selected)).not.toBe(researchHashRequest(changed));
    expect(Object.isFrozen(selected)).toBe(true);
    expect(researchRunConfig(selected).maxGoalTurns).toBe(64);
    expect(researchRunConfig(changed).maxGoalTurns).toBe(256);
  });
  it.each([1, 64, 256])("preserves the parsed sealed coding turn bound %s", maxGoalTurns => {
    const selected = parseResearchOperatorRequest({ ...request, hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns });
    expect(researchRunConfig(selected).maxGoalTurns).toBe(maxGoalTurns);
  });
  it.each([0, 257, 1.5, "64", null])("rejects invalid coding turn bound %s", maxGoalTurns => {
    expect(() => parseResearchOperatorRequest({ ...request, hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns })).toThrow();
  });
  it("rejects spoofed profile, non-MiMo coding and research budget overrides", () => {
    expect(() => parseResearchOperatorRequest({ ...request, hostedProfile: "coding" })).toThrow();
    expect(() => parseResearchOperatorRequest({ ...request, hostedProfile: HostedMimoProfile.CodingV1, modelBackend: CodexModelBackend.OpenAiChatGpt })).toThrow();
    expect(() => parseResearchOperatorRequest({ ...request, maxGoalTurns: 64 })).toThrow();
    expect(() => parseResearchOperatorRequest({ ...request, hostedProfile: HostedMimoProfile.CodingV1, proxyBaseUrl: "http://caller.invalid" })).toThrow();
  });
  it("requires exact request/grant profile agreement without widening ordinary worker grants", () => {
    const selected = parseResearchOperatorRequest({ ...request, hostedProfile: HostedMimoProfile.CodingV1 });
    expect(() => assertResearchMimoProfileMatch(selected, grant(HostedMimoProfile.Worker))).toThrow();
    expect(() => assertResearchMimoProfileMatch(selected, grant(HostedMimoProfile.CodingV1))).not.toThrow();
    expect(() => assertResearchMimoProfileMatch(parseResearchOperatorRequest(request), grant(HostedMimoProfile.CodingV1))).toThrow();
  });
  it("does not activate native shell from a caller-selected profile", () => {
    expect(() => assertHostedAppServerEngineOptions({ codexBinaryPath: "/TEST/codex", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      nativeToolSurface: HostedMimoProfile.CodingV1 })).toThrow("hosted_mimo_coding_engine_authority_invalid");
    expect(codexAppServerToolConfig({ nativeToolSurface: HostedMimoProfile.CodingV1, fastMode: false, goalMode: false, trustedHooksEnabled: false }))
      .toMatchObject({ features: { shell_tool: true, unified_exec: true, hooks: false, goals: false, apps: false, memories: false, multi_agent: false } });
    const worker = parseResearchOperatorRequest(request);
    expect(worker).not.toHaveProperty("hostedProfile");
    expect(researchRunConfig(worker).maxGoalTurns).toBe(8);
    expect(codexAppServerToolConfig({ nativeToolSurface: "disabled", fastMode: false, goalMode: false, trustedHooksEnabled: false })).toMatchObject({ features: { shell_tool: false, unified_exec: false } });
  });
});
