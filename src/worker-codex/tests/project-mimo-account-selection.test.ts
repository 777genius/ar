import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
const state = vi.hoisted(() => ({ ready: true, statuses: vi.fn() }));
vi.mock("@vioxen/subscription-runtime/provider-codex", async original => ({ ...await original<object>(),
  hostedMimoCredentialSourceReady: () => state.ready }));
vi.mock("../codex-goal-ops", () => ({ listCodexGoalAccountStatuses: state.statuses }));
import { projectControlCreateAccountNames, projectControlRefillAccountNames } from "../codex-goal-mcp-project-accounts";
beforeEach(() => { state.ready = true; vi.clearAllMocks(); });
describe("project MiMo account selection", () => {
  const input = { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, authRootDir: "/TEST-no-chatgpt-auth",
    requestedAccounts: ["account-q"], allowedAccountIds: ["account-a", "account-q"], jobId: "TEST-child" };
  it("selects the shared scoped account without consulting ChatGPT auth status", async () => {
    expect(await projectControlCreateAccountNames(input)).toEqual(["account-q"]);
    expect(await projectControlRefillAccountNames({ ...input, requestedAccounts: [] })).toEqual(["account-q"]);
    expect(state.statuses).not.toHaveBeenCalled();
  });
  it.each([{ allowedAccountIds: ["account-a"] }, { allowedAccountIds: [] }, { requestedAccounts: ["account-a"] },
    { requestedAccounts: ["account-q", "account-a"] }])("refuses a widened scope or account request %j", async changed => {
    await expect(projectControlRefillAccountNames({ ...input, ...changed })).rejects.toThrow();
    expect(state.statuses).not.toHaveBeenCalled();
  });
  it("refuses a missing trusted source before choosing a worker", async () => {
    state.ready = false;
    await expect(projectControlCreateAccountNames(input)).rejects.toThrow("project_control_mimo_credential_unavailable");
    expect(state.statuses).not.toHaveBeenCalled();
  });
});
