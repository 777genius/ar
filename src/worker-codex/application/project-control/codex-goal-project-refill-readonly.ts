import { inspectStandaloneProjectDependencies } from "./codex-goal-project-dependency-inspection";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AccessBoundary, ProjectAdmissionWorkerRole, ProjectControlDeniedError, createAccessPolicyService } from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalJob, parseCodexGoalJobManifest, type CodexGoalJobManifest,
  type CodexGoalJobManifestInput } from "../../codex-goal-jobs";
import type { ProjectControlMcpArgs } from "../../codex-goal-mcp-inputs";
import type { CodexGoalMcpProjectControlJobsDeps, LoadedProjectControlController } from
  "../../codex-goal-mcp-project-control-jobs-types";
import { projectControlAuditPath } from "../../codex-goal-mcp-project-broker";
import { inspectDependencyBootstrap } from "../../dependency-bootstrap";
import { assertProjectControlCreateManifestPaths, assertProjectControlDependencyBootstrapReady } from "../../codex-goal-mcp-project-scope";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "../../codex-goal-project-workspace-lock";
import { withCurrentControllerScopeActivity } from "./codex-goal-current-controller-activity";
import { assertExistingRefillJobMatches, assertReadablePrompt, assertReusableProjectWorktree } from "./codex-goal-project-refill";
import { assertSafeGitRefName, execGitStdout } from "./codex-goal-project-git";
import { projectControlCanonicalWorkspacePath } from "./codex-goal-project-workspace-scope";
import { noopOperationResult, type CodexGoalProjectCreateWorktreeInput } from "./codex-goal-project-control-contracts";
import { defaultProjectControlGitPort, type ProjectControlGitPort } from "./adapters/host-command-adapters";

// The shared reuse validator needs only these fixed offline readers. Disable
// optional index refresh and configured fsmonitor commands on the no-effect path.
const readOnlyGit: ProjectControlGitPort = {
  async run(input) {
    const [literal, changeDirectory, path, command, ...operands] = input.args;
    const allowed = (command === "rev-parse" && (operands.join("\0") === "--show-toplevel" ||
      (operands.length === 2 && operands[0] === "--verify" && /^(?:HEAD|[a-f0-9]{40})\^\{commit\}$/.test(operands[1] ?? "")))) ||
      command === "status" && operands.join("\0") === "--porcelain" ||
      command === "symbolic-ref" && operands.join("\0") === "--short\0HEAD";
    if (literal !== "--literal-pathspecs" || changeDirectory !== "-C" || !path || !allowed)
      throw new Error("project_control_read_only_git_operation_invalid");
    const options = { ...input, env: { ...process.env, ...input.env, GIT_NO_LAZY_FETCH: "1" },
      args: ["--no-optional-locks", "-c", "core.fsmonitor=false", ...input.args] };
    if (command === "status") {
      try {
        const filters = await defaultProjectControlGitPort.run({ ...options,
          args: ["--no-optional-locks", "-C", path, "config", "--get-regexp", "^filter\\..*\\.(clean|process)$"] });
        if (filters.stdout.trim()) throw new Error("project_control_read_only_git_filter_unsupported");
      } catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
    }
    const result = await defaultProjectControlGitPort.run(options);
    if (command === "rev-parse" && operands[0] === "--show-toplevel" && result.stdout.trim() !== path)
      throw new Error("project_control_existing_worktree_invalid");
    return result;
  },
  async runBuffered() { throw new Error("project_control_read_only_git_operation_invalid"); },
};

type ReadOnlyRefillInput = {
  readonly args: ProjectControlMcpArgs;
  readonly controller: LoadedProjectControlController;
  readonly deps: CodexGoalMcpProjectControlJobsDeps;
  readonly manifest: CodexGoalJobManifestInput;
  readonly promptBody: string;
  readonly workerRole: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly sourceWorkspacePath: string;
  readonly sealedSource: boolean;
};

/** A same-request observation grants no writer claim or launch authority. All
 * creation, adoption, patching, remote refresh and installation retain the
 * original admission path; unknown writer authority is never treated as release.
 */
export async function tryReadOnlyProjectRefillContinuation(input: ReadOnlyRefillInput):
  Promise<Readonly<Record<string, unknown>> | undefined> {
  const { args, manifest, controller } = input;
  if (args.startWorker !== false || args.prewarmOnStart !== false || args.overwrite === true ||
      args.confirmRefill !== true || manifest.accounts.length === 0 ||
      !/^[a-f0-9]{40}$/.test(args.sourceRef ?? "") || args.expectedSourceCommit !== undefined ||
      input.sealedSource || args.requireCanonicalRemoteHead === true ||
      args.mergeBinding !== undefined || args.preStartAdmission !== undefined ||
      args.producerJobId !== undefined || args.reviewedOutputId !== undefined || args.reviewedOutputIds !== undefined ||
      args.confirmDependencyBootstrap === true ||
      (args.dependencyBootstrap !== undefined && args.dependencyBootstrap !== "off" && args.dependencyBootstrap !== "preflight") ||
      input.workerRole !== ProjectAdmissionWorkerRole.Producer || manifest.executionEngine !== "app-server-goal" ||
      manifest.projectPreStartAdmission !== undefined)
    return undefined;
  assertProjectControlCreateManifestPaths({ scope: controller.scope,
    registryRootDir: controller.registryRootDir, manifest });
  let existing: CodexGoalJobManifest;
  try { existing = await readCodexGoalJob({ registryRootDir: controller.registryRootDir, jobId: manifest.jobId }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const expected = parseCodexGoalJobManifest({ ...manifest,
    durableHandoffRootDir: manifest.durableHandoffRootDir ?? join(controller.registryRootDir, "durable-handoffs"),
    schemaVersion: existing.schemaVersion, createdAt: manifest.createdAt ?? existing.createdAt,
    updatedAt: manifest.updatedAt ?? existing.updatedAt });
  // Compare the complete normalized contract, including engine/model, state,
  // accounts, auth, tags and confinement, beyond the shared minimum matcher.
  if (!isDeepStrictEqual(existing, expected)) throw new Error("project_control_existing_job_mismatch:read_only_contract");
  const sourceRevision = args.sourceRef as string;
  const baseBranch = args.baseBranch?.trim() || sourceRevision;
  const newBranch = args.newBranch?.trim() || undefined;
  assertSafeGitRefName(baseBranch, "baseBranch");
  if (newBranch) assertSafeGitRefName(newBranch, "newBranch");
  const canonicalWorkspacePath = await projectControlCanonicalWorkspacePath(manifest.workspacePath, controller.scope);
  const sourceRealPath = await projectControlCanonicalWorkspacePath(input.sourceWorkspacePath, controller.scope);
  const worktreeInput: CodexGoalProjectCreateWorktreeInput = { jobId: manifest.jobId, path: manifest.workspacePath,
    sourceWorkspacePath: input.sourceWorkspacePath, expectedSourceRealPath: sourceRealPath,
    expectedRealPath: canonicalWorkspacePath, expectedRevision: sourceRevision, sourceRef: sourceRevision,
    baseBranch, ...(newBranch ? { newBranch } : {}) };
  // Reuse the exact existing policy directly: observation records no broker
  // audit event, account refresh claim or writer admission.
  const policy = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope: controller.scope });
  for (const decision of [policy.canCreateWorktree({ ...worktreeInput, realSourceWorkspacePath: sourceRealPath,
    realPath: canonicalWorkspacePath }), ...manifest.accounts.map(accountId => policy.canUseAccount({ accountId }))])
    if (!decision.allowed) throw new ProjectControlDeniedError(decision);
  const dependencyMode = args.dependencyBootstrap === "off" ? "off" : "preflight";
  const before = await lstat(manifest.workspacePath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("project_control_existing_worktree_invalid");
  return await withCurrentControllerScopeActivity({
    controllerJobRootDir: controller.controller.jobRootDir,
    owner: `project-refill-read-only:${controller.controller.jobId}:${manifest.jobId}`,
    expectedScope: controller.scope,
    loadCurrentScope: async () => (await input.deps.loadProjectControlController(args)).scope,
    effect: async () => await withValidatedProjectWorkspaceLock({
      locks: projectControlWorkspaceLocks(controller.registryRootDir), scope: controller.scope,
      requestedWorkspacePath: manifest.workspacePath, expectedCanonicalWorkspacePath: canonicalWorkspacePath,
      owner: `project-refill-read-only:${controller.controller.jobId}:${manifest.jobId}`,
      effect: async (workspace) => {
        const assertCurrent = async (): Promise<void> => {
          const current = await readCodexGoalJob({ registryRootDir: controller.registryRootDir, jobId: manifest.jobId });
          if (!isDeepStrictEqual(current, existing)) throw new Error("project_control_existing_job_mismatch:read_only_contract");
          await assertExistingRefillJobMatches({ existing: current, expected, promptBody: input.promptBody });
          if (await realpath(worktreeInput.sourceWorkspacePath) !== worktreeInput.expectedSourceRealPath ||
              (await execGitStdout(["-C", worktreeInput.expectedSourceRealPath, "rev-parse", "--verify",
                `${sourceRevision}^{commit}`], readOnlyGit)).trim() !== sourceRevision)
            throw new Error("project_control_existing_worktree_real_path_changed");
          await assertReusableProjectWorktree({ createWorktreeInput: worktreeInput, scope: controller.scope }, readOnlyGit);
          const after = await lstat(manifest.workspacePath, { bigint: true });
          if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
            throw new Error("project_control_existing_worktree_real_path_changed");
        };
        await assertCurrent();
        const dependencyPreflight = await inspectStandaloneProjectDependencies({ manifest, target: worktreeInput,
          scope: controller.scope, registryRootDir: controller.registryRootDir, workspace, mode: dependencyMode }) ??
          await inspectDependencyBootstrap(manifest.workspacePath, dependencyMode);
        assertProjectControlDependencyBootstrapReady(dependencyPreflight);
        const prompt = await assertReadablePrompt({ promptPath: manifest.promptPath, expectedBody: input.promptBody });
        await assertCurrent();
        return { ok: true, mode: "project_control_refill_worker", readOnlyContinuation: true,
          controllerJobId: controller.controller.jobId, registryRootDir: controller.registryRootDir,
          auditPath: projectControlAuditPath(controller.controller), workerRole: input.workerRole,
          targetJobId: manifest.jobId, jobId: manifest.jobId, baseBranch, prompt,
          worktree: noopOperationResult(manifest.jobId, "existing worktree inspected without mutation"),
          createJob: noopOperationResult(manifest.jobId, "existing job inspected without publication"), dependencyPreflight };
      },
    }),
  });
}
