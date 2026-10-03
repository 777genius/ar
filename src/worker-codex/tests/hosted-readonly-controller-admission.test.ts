import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId, codexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { admitHostedControllerLaunch } from "../hosted-readonly-controller-admission";
import { buildCodexControlledAgentProfile, withControlledAgentEgress } from "../controlled-agent/codex-controlled-agent-profile";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";

const gates = vi.hoisted(() => ({ egress: vi.fn(), readonly: vi.fn(), spawn: vi.fn() }));
vi.mock("../hosted-test-egress-admission", () => ({ admitHostedTestEgress: gates.egress }));
vi.mock("../hosted-readonly-admission", () => ({ admitHostedReadonlyInputs: gates.readonly }));
const launch: CodexGoalLaunchInput = { cwd: "/workspace", logPath: "/job/run.log", cliCommand: ["node", "cli.js"], config: { jobId: "controller", taskId: "task", jobRootDir: "/job", workspacePath: "/workspace", authRootDir: "/auth", promptPath: "/job/prompt", accounts: [{ name: "TEST" }],
  sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } } };
const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification);
beforeEach(() => {
  vi.resetAllMocks();
  gates.egress.mockResolvedValue(policy);
  gates.readonly.mockReturnValue(gates.spawn);
});
describe("controller trusted admission composition", () => {
  it("uses exact launch identity and keeps egress outside the admitted spawn", async () => {
    const admitted = await admitHostedControllerLaunch(launch);
    expect(gates.egress).toHaveBeenCalledWith(expect.objectContaining({ jobId: "controller", jobRootDir: "/job", workspacePath: "/workspace" }));
    expect(gates.readonly).toHaveBeenCalledWith(expect.objectContaining({ providerEgressPolicy: policy }));
    expect(gates.spawn).not.toHaveBeenCalled();
    admitted.processFactory({ command: "codex", args: [], cwd: "/workspace", env: {} });
    expect(gates.spawn).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: policy.profileId }), args: expect.arrayContaining(["features.network_proxy.enabled=true"]) }));
  });
  it("rejects a missing grant before readonly admission", async () => {
    gates.egress.mockRejectedValue(new Error("missing grant"));
    await expect(admitHostedControllerLaunch(launch)).rejects.toThrow("missing grant");
    expect(gates.readonly).not.toHaveBeenCalled();
  });
  it("rereads admission and fails revocation on the next adapter entry", async () => {
    await admitHostedControllerLaunch(launch);
    gates.readonly.mockImplementation(() => { throw new Error("revoked"); });
    await expect(admitHostedControllerLaunch(launch)).rejects.toThrow("revoked");
    expect(gates.egress).toHaveBeenCalledTimes(2);
    expect(gates.spawn).not.toHaveBeenCalled();
  });
  it("binds configuration and materializer policy without changing broker tools", () => {
    const base = buildCodexControlledAgentProfile({ stateDir: "/state" });
    const managed = withControlledAgentEgress(base, policy);
    expect(managed.providerEgressPolicy).toBe(policy);
    expect(managed.configToml).not.toBe(base.configToml);
    expect(managed.enabledTools).toEqual(base.enabledTools);
    expect(managed.enforcement).toEqual(base.enforcement);
    expect(withControlledAgentEgress(base, codexProviderEgressPolicy(CodexProviderEgressProfileId.ProviderApi)).configToml).toBe(base.configToml);
    expect(() => withControlledAgentEgress({ ...base, configToml: "arbitrary" }, policy)).toThrow("generated_egress");
  });
});
