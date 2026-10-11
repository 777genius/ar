import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProjectOperation, type ProjectAccessScope, type ProjectAdmissionRequest } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifestInput } from "../../codex-goal-jobs";
import { projectControlWorkspaceLockRoot, type ProjectControlWorkspaceLease } from "../../codex-goal-project-workspace-lock";
import { protectedCodexGoalJobBirthPreparationCurrent, type ProtectedCodexGoalJobBirthPreparation } from "../../protected-job-birth";
import { assertGitWorkspaceRawPatchIdentitySupported, captureGitWorkspaceChangedFiles, captureGitWorkspacePatch, type WorkspacePatchGitReadRecipe } from "../../codex-goal-runtime-result-io";
import { managedDependencyGitEnvironment, managedDependencyGitFlags } from "../../managed-dependency-git";
import { assertResearchDirectory, researchCustody, researchDirectoryIdentity } from "../../research-launch-files";
import { ExecFileProjectControlGitAdapter } from "./adapters/host-command-adapters";
import type { CodexGoalProjectCreateWorktreeInput } from "./codex-goal-project-control-contracts";
import { worktreeCreationIdentity } from "./codex-goal-project-admission-target";
import { prospectiveAdmissionResourceBacking } from "./codex-goal-project-admission-paths";
import { MAX_STAGED_PATCH_BYTES } from "./codex-goal-project-git";
import { workerLaunchSpecHasOwnershipBoundWorkKey } from "./codex-goal-project-builtin-pre-start-admission";
import { parseWorkerLaunchSpec, workerLaunchOwnsChangedPath } from "./worker-launch-spec";

/** Only the refill owner supplies its original create capability and planned
 * builtin contract. No role or dirty-directory shape supplies this binding. */
export type PlannedProjectAdoption = {
  readonly target: CodexGoalProjectCreateWorktreeInput;
  readonly manifest: CodexGoalJobManifestInput;
  readonly contract: Readonly<Record<string, unknown>>;
  readonly preparation: ProtectedCodexGoalJobBirthPreparation | undefined;
};
export const adoptionGitReadRecipe: WorkspacePatchGitReadRecipe = Object.freeze({
  binaryPath: "/usr/bin/git", flags: managedDependencyGitFlags, env: managedDependencyGitEnvironment(),
});
const gitPort = new ExecFileProjectControlGitAdapter(adoptionGitReadRecipe.binaryPath);
const git = async (path: string, ...args: string[]): Promise<string> =>
  (await gitPort.run({ args: [...adoptionGitReadRecipe.flags, "-C", path, ...args],
    env: adoptionGitReadRecipe.env, timeoutMs: 10_000, maxBuffer: MAX_STAGED_PATCH_BYTES })).stdout.trim();

export async function readPlannedProjectAdoptionProof(input: {
  readonly registryRootDir: string; readonly controllerJobId: string; readonly scope: ProjectAccessScope;
  readonly request: ProjectAdmissionRequest;
  readonly adoption: PlannedProjectAdoption & { readonly workspaceLease: () => ProjectControlWorkspaceLease | undefined };
}) {
  const { adoption, request } = input, { manifest, target } = adoption;
  const invalid = (): never => { throw new Error("project_control_adoption_target_unproved"); };
  if ((request.operation !== ProjectOperation.CreateWorktree && request.operation !== ProjectOperation.CreateJob) ||
    request.jobId !== manifest.jobId || request.workspacePath !== manifest.workspacePath || target.path !== manifest.workspacePath ||
    target.jobId !== manifest.jobId || !target.expectedRealPath || target.inputPatch || target.fastForwardExisting ||
    target.workerRole !== "adoption" || manifest.projectPreStartAdmission?.mode !== "serial-builtin" ||
    adoption.preparation === undefined) return invalid();
  const contract = parseWorkerLaunchSpec(adoption.contract);
  if (!workerLaunchSpecHasOwnershipBoundWorkKey(contract) || contract.registryStatus !== "queued" || contract.revision !== 0 ||
    contract.retryCount !== 0 || contract.supersedes !== null || contract.jobId !== manifest.jobId ||
    contract.jobRoot !== manifest.jobRootDir || contract.promptPath !== manifest.promptPath || contract.workspaceRoot !== manifest.workspacePath ||
    contract.phaseStartSha !== target.expectedRevision || !contract.inputPatchHash ||
    !isDeepStrictEqual([...(request.ownedPaths ?? [])].sort(), [...contract.ownedPaths].sort()) ||
    !isDeepStrictEqual([...(target.ownedPaths ?? [])].sort(), [...contract.ownedPaths].sort())) return invalid();
  const owner = `project-adoption:${input.controllerJobId}:${manifest.jobId}`;
  const lease = adoption.workspaceLease();
  if (!lease || lease.lease.owner !== owner || lease.lease.workspacePath !== target.expectedRealPath ||
    lease.canonicalWorkspacePath !== target.expectedRealPath) return invalid();
  const held = lease!.lease;
  const assertLease = async () => {
    if (adoption.workspaceLease() !== lease || lease!.lease !== held) return invalid();
    const key = createHash("sha256").update(target.expectedRealPath!).digest("hex");
    const path = join(projectControlWorkspaceLockRoot(input.registryRootDir), "workspace-locks", key, "lock.json");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return invalid();
    const lock = JSON.parse(await readFile(path, "utf8"));
    if (lock.taskId !== held.lockId || lock.ownerId !== owner || lock.workspacePath !== target.expectedRealPath || lock.ownerPid !== process.pid) return invalid();
  };
  const birth = { preparation: adoption.preparation!, manifest, registryRootDir: input.registryRootDir };
  if (!protectedCodexGoalJobBirthPreparationCurrent(birth)) return invalid();
  await assertLease();
  const worktreeRequest = { ...request, operation: ProjectOperation.CreateWorktree };
  const identityInput = { scope: input.scope, binding: { createWorktree: target }, request: worktreeRequest };
  const workspace = await worktreeCreationIdentity(identityInput, true, git);
  if (workspace !== target.expectedRealPath || await git(workspace!, "rev-parse", "HEAD") !== target.expectedRevision) return invalid();
  const source = target.expectedSourceRealPath;
  for (const revision of [contract.baseSha, contract.canonicalSha]) {
    if (await git(source, "rev-parse", `${revision}^{commit}`) !== revision) return invalid();
  }
  const directories = [workspace!, source, manifest.jobRootDir, input.registryRootDir].map(path => {
    researchCustody(path); return researchDirectoryIdentity(path);
  });
  const backing = await prospectiveAdmissionResourceBacking(workspace!);
  if (!backing?.length) return invalid();
  // Fixed Git disables executable presentation/config hooks. Raw conversion
  // eligibility is checked before any diff or ordinary status observation.
  await assertGitWorkspaceRawPatchIdentitySupported(workspace!, adoptionGitReadRecipe);
  // Later existing receipt/reuse readers retain their algorithms. Reject
  // executable repository configuration before they can observe this target.
  try {
    const config = await git(workspace!, "config", "--get-regexp", "^(core\\.fsmonitor|diff\\.external|diff\\..*\\.(command|textconv))$");
    if (config.split("\n").some(line => {
      const [key, ...value] = line.split(/\s+/); const setting = value.join(" ");
      return key === "core.fsmonitor" ? !/^(false|no|off|0)$/i.test(setting) : setting.length > 0;
    })) return invalid();
  } catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  const changedFiles = await captureGitWorkspaceChangedFiles({ workspacePath: workspace!, gitReadRecipe: adoptionGitReadRecipe });
  if (!changedFiles.length || !changedFiles.every(path => workerLaunchOwnsChangedPath(contract, path))) return invalid();
  const patch = await captureGitWorkspacePatch({ workspacePath: workspace!, gitReadRecipe: adoptionGitReadRecipe,
    maxPatchBytes: MAX_STAGED_PATCH_BYTES, deadlineMs: performance.now() + 10_000 });
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  if (patchSha256 !== contract.inputPatchHash) throw new Error("project_control_pre_start_input_patch_hash_mismatch");
  await assertGitWorkspaceRawPatchIdentitySupported(workspace!, adoptionGitReadRecipe);
  if (await worktreeCreationIdentity(identityInput, true, git) !== workspace ||
    await git(workspace!, "rev-parse", "HEAD") !== target.expectedRevision ||
    !isDeepStrictEqual(backing, await prospectiveAdmissionResourceBacking(workspace!))) return invalid();
  await assertLease();
  for (const directory of directories) { researchCustody(directory.path); assertResearchDirectory(directory); }
  if (await realpath(manifest.workspacePath) !== workspace || !protectedCodexGoalJobBirthPreparationCurrent(birth)) return invalid();
  return { workspacePath: workspace!, jobId: manifest.jobId, patchSha256, changedFiles, backing, directories, lockId: held.lockId };
}
