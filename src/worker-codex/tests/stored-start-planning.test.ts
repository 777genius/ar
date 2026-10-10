import { describe, expect, it } from "vitest";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { goalLaunchInput, goalLaunchInputFromRecord } from "../application/codex-goal-launch-input";
import { assertStoredProjectStartBinding, parseStoredProjectStartArgs, parseStoredProjectStartBinding,
  planStoredProjectStart, type StoredProjectStartSnapshots } from "../stored-start-planning";

const root = "/srv/ordinary-stored-start-NEWTEST";
const jobRoot = `${root}/jobs/test-worker`, cwd = `${jobRoot}/workspace`;
const request = { controllerJobId: "test-controller", jobId: "test-worker", registryRootDir: `${root}/registry`,
  confirmStart: true, forceStart: false, skipDoctor: false, dependencyBootstrap: "off" };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const base = { schemaVersion: 1, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
  taskId: "task-test", accounts: ["test-account"], model: "gpt-6.1-sol", reasoningEffort: "high",
  serviceTier: "default", tmuxSession: "test-worker", cwd };
const worker = { ...base, jobId: "test-worker", jobRootDir: jobRoot, workspacePath: cwd,
  promptPath: `${jobRoot}/prompt.md`, authRootDir: `${root}/auth`,
  outputPath: `${jobRoot}/state/source-result.json`, accessBoundary: AccessBoundary.IsolatedWorkspaceWrite };
const controller = { ...base, jobId: "test-controller", jobRootDir: `${root}/controller`, workspacePath: `${root}/controller/workspace`,
  promptPath: `${root}/controller/prompt.md`, accessBoundary: AccessBoundary.ProjectScopedControl,
  projectAccessScope: { projectId: "test-project", workspaceRoots: [root], registryRoot: request.registryRootDir,
    jobIdPrefixes: ["test-"], tmuxSessionPrefixes: ["test-"], allowedAccountIds: ["test-account"] } };
function snapshots(): StoredProjectStartSnapshots {
  return { controller: json(controller), worker: json(worker), prompt: Buffer.from("Public inert test task."), preStart: null };
}
function boundJson(snapshot: StoredProjectStartSnapshots): string {
  const plan = planStoredProjectStart(JSON.stringify(request), cwd, snapshot);
  return JSON.stringify({ ...request, storedStartBinding: plan.binding });
}

describe("stored project start result planning", () => {
  it("selects the configured job result and full supported launch defaults", async () => {
    const snapshot = snapshots(), plan = planStoredProjectStart(boundJson(snapshot), cwd, snapshot);
    assertStoredProjectStartBinding(plan);
    expect({ jobId: plan.jobId, jobRoot: plan.jobRoot, workspace: plan.workspace, output: plan.output, taskId: plan.taskId })
      .toEqual({ jobId: "test-worker", jobRoot, workspace: cwd, output: `${jobRoot}/state/source-result.json`, taskId: "task-test" });
    expect(plan.launch.config).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "high", serviceTier: "default",
      taskTimeoutMs: 72 * 60 * 60 * 1000, requireGitWorkspace: true, allowDangerFullAccess: false });
    const input = { jobRootDir: jobRoot, workspacePath: cwd, promptPath: worker.promptPath, taskId: "test-task", accounts: ["test-account"], cwd };
    expect(goalLaunchInputFromRecord(input, cwd)).toEqual(await goalLaunchInput(input));
  });

  it("rejects changed raw manifest bytes even when launch fields are unchanged", () => {
    const snapshot = snapshots(), original = boundJson(snapshot);
    const changed = planStoredProjectStart(original, cwd, { ...snapshot, worker: Buffer.concat([snapshot.worker, Buffer.from("\n")]) });
    expect(() => assertStoredProjectStartBinding(changed)).toThrow("hosted_stored_project_start_binding_invalid");
    const changedScope = planStoredProjectStart(original, cwd, { ...snapshot,
      controller: json({ ...controller, projectAccessScope: { ...controller.projectAccessScope, allowedAccountIds: ["test-other"] } }) });
    expect(() => assertStoredProjectStartBinding(changedScope)).toThrow("hosted_stored_project_start_binding_invalid");
  });

  it("rejects changed prompt and preStart revisions, with explicit absent admission", () => {
    const snapshot = snapshots(), original = boundJson(snapshot);
    expect(planStoredProjectStart(original, cwd, snapshot).binding.preStart).toBeNull();
    expect(() => assertStoredProjectStartBinding(planStoredProjectStart(original, cwd,
      { ...snapshot, prompt: Buffer.from("Different task.") }))).toThrow("hosted_stored_project_start_binding_invalid");
    const admitted: StoredProjectStartSnapshots = { ...snapshot, worker: json({ ...worker,
      projectPreStartAdmission: { schemaVersion: 1, mode: "serial-builtin", contractPath: `${jobRoot}/pre-start-admission/contract.json`,
        statePath: `${jobRoot}/pre-start-admission/state.json`, receiptPath: `${jobRoot}/pre-start-admission/receipt.json` } }),
      preStart: { contract: json({ revision: "r1" }), state: json({ queued: true }), receipt: json({ status: "validated_not_launched" }) } };
    const admittedJson = boundJson(admitted);
    for (const field of ["contract", "state", "receipt"] as const) {
      const changed = { ...admitted, preStart: { ...admitted.preStart!, [field]: json({ changed: true }) } };
      expect(() => assertStoredProjectStartBinding(planStoredProjectStart(admittedJson, cwd, changed)))
        .toThrow("hosted_stored_project_start_binding_invalid");
    }
  });

  it("refuses nonmanaged layout and foreign or colliding outputs", () => {
    for (const patch of [{ jobRootDir: `${root}/old-scratch` }, { workspacePath: `${root}/prepared-clone` },
      { outputPath: `${root}/foreign-result.json` }, { outputPath: worker.promptPath }, { outputPath: `${jobRoot}/state/../foreign-result.json` }]) {
      expect(() => planStoredProjectStart(JSON.stringify(request), cwd,
        { ...snapshots(), worker: json({ ...worker, ...patch }) })).toThrow("hosted_stored_project_start_binding_invalid");
    }
  });

  it("refuses bypass/recovery/options outside the closed original JSON", () => {
    for (const patch of [{ forceStart: true }, { skipDoctor: true }, { dependencyBootstrap: "install" },
      { reviewedOutputId: "a".repeat(64) }, { outputPath: `${root}/foreign.json` }, { continuationAccounts: ["test-account"] },
      { confirmStart: false }, { registryRootDir: "relative-registry" }]) {
      expect(() => parseStoredProjectStartArgs(JSON.stringify({ ...request, ...patch })))
        .toThrow("hosted_stored_project_start_binding_invalid");
    }
    expect(() => assertStoredProjectStartBinding(planStoredProjectStart(JSON.stringify(request), cwd, snapshots())))
      .toThrow("hosted_stored_project_start_binding_invalid");
  });

  it("refuses missing, malformed, unknown and accessor binding fields", () => {
    const binding = planStoredProjectStart(JSON.stringify(request), cwd, snapshots()).binding;
    const { preStart: _absent, ...missing } = binding;
    for (const invalid of [missing, { ...binding, workerManifestSha256: "unknown" }, { ...binding, extra: true },
      { ...binding, preStart: {} }, Object.defineProperty({ ...binding }, "promptSha256", { get: () => binding.promptSha256 })]) {
      expect(() => parseStoredProjectStartBinding(invalid)).toThrow("hosted_stored_project_start_binding_invalid");
    }
  });
});
