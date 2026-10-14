import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ delegate: vi.fn(), create: vi.fn(), refill: vi.fn(), start: vi.fn(), stop: vi.fn(), readJob: vi.fn() }));
vi.mock("../mimo-project-bridge-client", () => ({ delegateMimoProjectOperation: mock.delegate }));
vi.mock("../codex-goal-mcp-project-control-jobs", async original => ({ ...await original<object>(), projectControlCreateCodexGoalJobView: mock.create, projectControlRefillWorkerView: mock.refill }));
vi.mock("../codex-goal-mcp-project-control-actions", async original => ({ ...await original<object>(), projectControlStartStoredJobView: mock.start, projectControlStopStoredJobView: mock.stop }));
vi.mock("../codex-goal-jobs", async original => ({ ...await original<object>(), readCodexGoalJob: mock.readJob }));
import { projectControlCreateCodexGoalJob, projectControlStartStoredJob, projectControlStopStoredJob } from "../codex-goal-mcp-project-control-tool-handlers";
import { getCodexGoalStatusByIdUseCase } from "../application/codex-goal-job-use-cases";
beforeEach(() => { vi.clearAllMocks(); mock.delegate.mockResolvedValue({ ok: true, remote: true }); });
describe("ordinary MCP remote MiMo hooks", () => {
  it("delegates create/start/stop/status before local controller or registry loads", async () => {
    const args = { mimoProjectId: "TEST-project", mimoWorkstreamId: "TEST-work", jobId: "TEST-job" };
    await projectControlCreateCodexGoalJob(args); await projectControlStartStoredJob(args); await projectControlStopStoredJob(args);
    expect(await getCodexGoalStatusByIdUseCase(args)).toEqual({ ok: true, remote: true });
    expect(mock.delegate.mock.calls.map(call => call[0])).toEqual(["create", "start", "stop", "status"]);
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.start).not.toHaveBeenCalled(); expect(mock.stop).not.toHaveBeenCalled(); expect(mock.readJob).not.toHaveBeenCalled();
  });
});
