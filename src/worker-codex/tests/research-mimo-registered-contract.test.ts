import { describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import { CodexModelBackend, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { parseResearchOperatorRequest, researchRunConfig } from "../research-launch-contract";
import { assertRegisteredResearchExecutionSupported } from "../research-registered-execution";
import { codexProjectReservationValueSha256 } from "../application/project-control/codex-goal-project-account-reservation";
import { jobManifestInputFromArgs } from "../application/codex-goal-manifest-input";
import { goalLaunchInputFromRecord } from "../application/codex-goal-launch-input";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
vi.mock("../codex-goal-mcp-project-broker", () => ({ bindProjectChildCheckpointPublisher: ({ launch }: { launch: CodexGoalLaunchInput }) => launch }));
function fixture() {
  const request = parseResearchOperatorRequest({ schemaVersion: 1, jobId: "TEST-mimo", taskId: "TEST-task", projectId: "TEST-project",
    jobRootDir: "/TEST-job", workspacePath: "/TEST-workspace", promptPath: "/TEST-job/prompt.md", authRootDir: "/TEST-auth",
    accounts: ["account-q"], codexBinaryPath: "/usr/bin/codex", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    model: codexMimoDefaultModel, reasoningEffort: "medium", serviceTier: "default", taskTimeoutMs: 600000,
    maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: 330000,
    durableHandoffRootDir: "/TEST-registry/durable-handoffs" });
  const config: CodexGoalLaunchInput["config"] = { ...request, accounts: [{ name: "account-q" }], executionEngine: "app-server",
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, networkAccess: NetworkAccessMode.Unrestricted,
    requireGitWorkspace: true, editMode: "allow-edits", outputPath: "/TEST-job/TEST-task.latest-result.json",
    progressPath: "/TEST-job/TEST-task.progress.json", progressHeartbeatMs: 60000,
    projectAccessScope: { projectId: "TEST-project", isolatedWorkspaceRoot: request.workspacePath, authRoot: request.authRootDir } };
  // schemaVersion belongs to the closed operator packet, never the runner config.
  delete (config as Record<string, unknown>).schemaVersion;
  delete (config as Record<string, unknown>).projectId;
  const execution = { sourceConfigSha256: codexProjectReservationValueSha256(config),
    reservedConfigSha256: codexProjectReservationValueSha256(config), selectedAccountSha256: codexProjectReservationValueSha256(config.accounts[0]),
    accountId: "account-q", projectId: "TEST-project", maxAccountCycles: 1 as const, prewarmOnStart: false, appServerStartupTimeoutMs: 330000 };
  return { registryRootDir: "/TEST-registry", request, execution, launch: { config } as CodexGoalLaunchInput,
    manifest: {} as CodexGoalJobManifest, controller: {} as CodexGoalJobManifest };
}
describe("registered MiMo finite execution contract", () => {
  it("admits the pinned registered worker and derives a contained structured report turn", () => {
    const input = fixture();
    expect(() => assertRegisteredResearchExecutionSupported(input)).not.toThrow();
    expect(researchRunConfig(input.request)).toMatchObject({ executionEngine: "app-server", workerReportMode: "structured-output",
      maxGoalTurns: 8, maxReconnectRetriesPerAccount: 3, safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled" } });
  });
  it.each([{ modelBackend: CodexModelBackend.OpenAiChatGpt }, { model: "gpt-6.1-sol" }, { maxAccountCycles: 2 },
    { prewarmOnStart: true }, { executionEngine: "app-server-goal" }, { workerReportMode: "structured-output" },
    { sourceEnv: { TEST: "override" } }, { allowDangerFullAccess: true }])("rejects stored widening %j", fields => {
    const input = fixture();
    input.launch = { ...input.launch, config: { ...input.launch.config, ...fields } } as CodexGoalLaunchInput;
    expect(() => assertRegisteredResearchExecutionSupported(input)).toThrow("hosted_research_registered_execution_unsupported");
  });
  it("rejects a request backend substitution despite exact stored reservation hashes", () => {
    const input = fixture();
    input.request = { ...input.request, modelBackend: CodexModelBackend.OpenAiChatGpt };
    expect(() => assertRegisteredResearchExecutionSupported(input)).toThrow();
  });
});

describe("public MiMo worker defaults before project reservation", () => {
  const minimal = { jobId: "TEST-public", taskId: "TEST-task", jobRootDir: "/TEST-job", workspacePath: "/TEST-workspace",
    promptPath: "/TEST-job/prompt.md", accounts: ["account-q"], modelBackend: CodexModelBackend.XiaomiMimoTokenPlan };
  it("uses the same finite defaults in create and stored-launch builders", () => {
    const manifest = jobManifestInputFromArgs(minimal);
    const launch = goalLaunchInputFromRecord(minimal, "/TEST-cwd");
    for (const value of [manifest, launch.config]) expect(value).toMatchObject({ model: "mimo-v2.6-pro",
      executionEngine: "app-server", maxAccountCycles: 1, prewarmOnStart: false });
    expect(launch.config.accounts).toEqual([{ name: "account-q" }]);
  });
  it("preserves caller values for independent admission to reject", () => {
    const fields = { ...minimal, model: "gpt-6.1-sol", executionEngine: "app-server-goal" as const, maxAccountCycles: 7, prewarmOnStart: true };
    for (const value of [jobManifestInputFromArgs(fields), goalLaunchInputFromRecord(fields, "/TEST-cwd").config])
      expect(value).toMatchObject({ model: "gpt-6.1-sol", executionEngine: "app-server-goal", maxAccountCycles: 7, prewarmOnStart: true });
  });
  it("preserves ordinary OpenAI defaults", () => {
    const fields = { ...minimal, modelBackend: CodexModelBackend.OpenAiChatGpt };
    for (const value of [jobManifestInputFromArgs(fields), goalLaunchInputFromRecord(fields, "/TEST-cwd").config])
      expect(value).toMatchObject({ executionEngine: "app-server-goal", maxAccountCycles: 5, prewarmOnStart: false });
  });
});
