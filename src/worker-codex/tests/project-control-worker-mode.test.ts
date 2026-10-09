import { isDeepStrictEqual } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessBoundary, NetworkAccessMode, WorkerMode } from "@vioxen/subscription-runtime/worker-core";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { defaultWorkerModeWhenScopeUnset, resolveNewChildWorkerMode, projectControlNewChildWorkerMode,
  projectControlWorkerModeRepairAllowed, resolveOpenWorkerLaunch, openWorkerProfileApplies, OpenWorkerFallbackReason, openWorkerEvidence,
  projectControlWorkerToolRootRequest, codexGoalOpenWorkerSystemPrompt, type OpenWorkerProfileInput } from "../project-control-worker-mode";
import { inspectWorkerToolRoot, WorkerToolRootBinding, workerToolRootPath } from "../worker-tool-root";
import { assertProjectControlScopeRepairAllowed, projectControlChildScope } from "../codex-goal-mcp-project-scope";
import { parseCodexGoalProjectAccessScope } from "../codex-goal-access-plan";
import { createCodexGoalJob, readCodexGoalJob, codexGoalJobToArgs, codexGoalJobManifestPath, parseCodexGoalJobManifest } from "../codex-goal-jobs";
import { goalLaunchInput } from "../application/codex-goal-launch-input";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "worker-mode-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const modes = [undefined, WorkerMode.Open, WorkerMode.Strict];
describe("new child worker mode and repair", () => {
  it("defaults to staged strict and preserves network in all controller/default combinations", () => {
    expect(defaultWorkerModeWhenScopeUnset).toBe(WorkerMode.Strict);
    for (const workerMode of modes) for (const defaultMode of [WorkerMode.Strict, WorkerMode.Open]) {
      const scope = { projectId: "TEST", ...(workerMode ? { workerMode } : {}) };
      expect(resolveNewChildWorkerMode(scope, defaultMode)).toBe(workerMode ?? defaultMode);
      for (const networkAccess of Object.values(NetworkAccessMode)) {
        const manifest = { networkAccess, ...projectControlNewChildWorkerMode(scope, defaultMode) };
        expect(manifest.networkAccess).toBe(networkAccess);
        expect(Object.hasOwn(manifest, "workerMode")).toBe((workerMode ?? defaultMode) === WorkerMode.Open);
        if (manifest.workerMode) expect(manifest.workerMode).toBe(WorkerMode.Open);
      }
      expect(projectControlChildScope(scope, "/TEST/workspace")).not.toHaveProperty("workerMode");
    }
  });
  it("allows unchanged and tighten-only repairs, including absent to strict", () => {
    for (const existing of modes) for (const proposed of modes) {
      const allowed = existing === proposed || proposed === WorkerMode.Strict;
      expect(projectControlWorkerModeRepairAllowed(existing, proposed)).toBe(allowed);
      const repair = () => assertProjectControlScopeRepairAllowed({
        existing: { projectId: "TEST", ...(existing ? { workerMode: existing } : {}) },
        proposed: { projectId: "TEST", ...(proposed ? { workerMode: proposed } : {}) },
      });
      if (allowed) expect(repair).not.toThrow();
      else expect(repair).toThrow("project_control_scope_workerMode_repair_denied");
    }
    expect(parseCodexGoalProjectAccessScope({ projectId: "TEST", workerMode: WorkerMode.Open })?.workerMode).toBe(WorkerMode.Open);
    expect(() => parseCodexGoalProjectAccessScope({ projectId: "TEST", workerMode: "unknown" })).toThrow("workerMode_invalid");
  });
});
describe("effective open predicate", () => {
  const baseline: OpenWorkerProfileInput = { platform: "linux", rootBaseline: true, contained: false,
    modelBackend: CodexModelBackend.OpenAiChatGpt, executionEngine: "app-server-goal", boundedWorkspaceTools: false,
    dependencyTools: false, projectReadBoundary: true };
  const failures: readonly [Partial<OpenWorkerProfileInput>, OpenWorkerFallbackReason][] = [
    [{ platform: "darwin" }, OpenWorkerFallbackReason.NotLinux], [{ rootBaseline: false }, OpenWorkerFallbackReason.NotRootBaseline],
    [{ contained: true }, OpenWorkerFallbackReason.Contained], [{ modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }, OpenWorkerFallbackReason.ModelBackend],
    [{ executionEngine: "plain-exec" }, OpenWorkerFallbackReason.ExecutionEngine], [{ boundedWorkspaceTools: true }, OpenWorkerFallbackReason.BoundedWorkspaceTools],
    [{ dependencyTools: true }, OpenWorkerFallbackReason.DependencyTools], [{ projectReadBoundary: false }, OpenWorkerFallbackReason.NoProjectReadBoundary],
  ];
  it("accepts the baseline and returns the first failed condition", () => {
    expect(openWorkerProfileApplies(baseline)).toEqual({ applies: true });
    for (const [changes, reason] of failures) expect(openWorkerProfileApplies({ ...baseline, ...changes })).toEqual({ applies: false, reason });
    expect(openWorkerProfileApplies({ ...baseline, platform: "darwin", contained: true })).toEqual({ applies: false, reason: OpenWorkerFallbackReason.NotLinux });
  });
  it("records a reason only for open falling back", () => {
    for (const requested of [WorkerMode.Strict, WorkerMode.Open]) for (const effective of [WorkerMode.Strict, WorkerMode.Open]) {
      const evidence = openWorkerEvidence({ requested, effective, reason: OpenWorkerFallbackReason.ToolRootAbsent });
      expect(evidence).toMatchObject({ workerModeRequested: requested, workerModeEffective: effective });
      expect(Object.hasOwn(evidence, "workerModeReason")).toBe(requested === WorkerMode.Open && effective === WorkerMode.Strict);
    }
  });
  it("binds only a completed tool root for the exact job and rejects a non-directory", async () => {
    const workspacePath = join(await fixture(), "workspace"), toolRoot = workerToolRootPath(workspacePath);
    const inspect = () => inspectWorkerToolRoot({ workspacePath, jobId: "TEST-a" });
    expect(await inspect()).toBe(WorkerToolRootBinding.Absent);
    await mkdir(toolRoot); expect(await inspect()).toBe(WorkerToolRootBinding.Foreign);
    await writeFile(join(toolRoot, "owner.json"), '{"jobId":"TEST-b"}'); expect(await inspect()).toBe(WorkerToolRootBinding.Foreign);
    await writeFile(join(toolRoot, "owner.json"), '{"jobId":"TEST-a"}'); expect(await inspect()).toBe(WorkerToolRootBinding.Owned);
    await rm(join(toolRoot, "owner.json")); await symlink("missing", join(toolRoot, "owner.json"));
    expect(await inspect()).toBe(WorkerToolRootBinding.Foreign);
    await rm(toolRoot, { recursive: true }); await writeFile(toolRoot, "file");
    await expect(inspect()).rejects.toThrow("hosted_open_worker_layout_invalid:tool_root_not_directory");
  });
});
it("preserves manifest object and serialized bytes across storage and launch", async () => {
  const root = await fixture(), registryRootDir = join(root, "registry");
  const input = { jobId: "TEST-a", jobRootDir: join(root, "job"), authRootDir: join(root, "auth"),
    workspacePath: join(root, "workspace"), promptPath: join(root, "prompt.md"), taskId: "TEST-a", accounts: ["TEST-account"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, projectAccessScope: { projectId: "TEST", workspaceRoots: [join(root, "workspace")] },
    networkAccess: NetworkAccessMode.Unrestricted, workerMode: WorkerMode.Open };
  const written = await createCodexGoalJob({ registryRootDir, manifest: input });
  const read = await readCodexGoalJob({ registryRootDir, jobId: input.jobId });
  expect(isDeepStrictEqual(written, read)).toBe(true);
  expect(JSON.stringify(read)).toBe(JSON.stringify(written));
  const stored = JSON.parse(await readFile(codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId }), "utf8"));
  expect(JSON.stringify(stored)).toBe(JSON.stringify(read));
  const args = codexGoalJobToArgs(read); expect(args.workerMode).toBe(WorkerMode.Open);
  const launch = await goalLaunchInput(args); expect(launch.config.workerMode).toBe(WorkerMode.Open);
  expect(launch.config.networkAccess).toBe(NetworkAccessMode.Unrestricted);
  await expect(resolveOpenWorkerLaunch({ config: { ...launch.config, workerMode: "unknown" as WorkerMode } })).rejects.toThrow("workerMode_invalid");
  expect(parseCodexGoalJobManifest({ ...written, workerMode: WorkerMode.Strict }).workerMode).toBe(WorkerMode.Strict);
  expect(() => parseCodexGoalJobManifest({ ...written, workerMode: "unknown" })).toThrow("workerMode_invalid");
  const scope = { projectId: "TEST", commitIdentity: { name: "iliya", email: "iliyazelenkog@gmail.com" } };
  expect(projectControlWorkerToolRootRequest(input, scope)).toEqual({ workerToolRoot: { jobId: input.jobId, commitAllowed: true, commitIdentity: scope.commitIdentity } });
  expect(projectControlWorkerToolRootRequest({ ...input, workerMode: WorkerMode.Strict }, scope)).toEqual({});
  expect(codexGoalOpenWorkerSystemPrompt(true)).toContain("do not rebase, reset, merge");
  expect(codexGoalOpenWorkerSystemPrompt(false)).toContain("workspace is read-only");
});
