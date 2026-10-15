import { existsSync, mkdirSync, writeFileSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { preparationSafeGit, assertPreparationGitMetadata } from "./hosted-mimo-project-source";
export { preparationSafeGit, assertPreparationGitMetadata } from "./hosted-mimo-project-source";
import { dirname, join, relative } from "node:path";
import { AccessBoundary, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob } from "./codex-goal-jobs";
import { assertResearchInitialRoot, assertResearchSharedHost } from "./research-launch-host";
import { researchCustody, researchPath, researchRecord, researchRead, researchHash, researchPublish, assertResearchDirectory, researchAuthorityRoot, type ResearchDirectoryIdentity } from "./research-launch-files";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation } from "./hosted-mimo-project-bridge-contract";
import { assertHostedMimoProjectRouteOpen, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding, captureHeldMimoPreparationFence, type HeldMimoPreparationFence } from "./hosted-mimo-project-bridge";
import { onboardHostedMimoProject } from "./hosted-mimo-project-bridge-onboard";
import { workerLaunchAdmissionSchema } from "./application/project-control/worker-launch-spec";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { prepareProtectedCodexGoalJobBirth, withProtectedCodexGoalJobBirthPublication, type ProtectedCodexGoalJobBirthPreparation } from "./protected-job-birth";
import { researchJobRuntimeNamespaceAbsent } from "./research-job-runtime-provenance";
import { hostedOrdinaryWriterAuthorityAbsent } from "./hosted-ordinary-writer-authority";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import { resolveHostScratchTempRoot } from "./host-scratch-temp";

const controllerPrompt = "Operator-owned MiMo project controller. Never launch this controller.\n";

/** Reviewed operator data only; never reachable through the remote wire DTO. */
export function parseHostedMimoPreparationPlan(value: unknown) {
  const row = researchRecord(value, "schemaVersion,binding,sourceSnapshotPath,repositoryKey,repositoryUrl,workerJobPrefix,authRootDir,commitIdentity");
  const identity = researchRecord(row.commitIdentity, "name,email");
  if (row.schemaVersion !== 1 || typeof row.repositoryKey !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.repositoryKey) ||
      typeof row.repositoryUrl !== "string" || !/^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(row.repositoryUrl) ||
      typeof row.workerJobPrefix !== "string" || !/^[a-z0-9][a-z0-9._-]{0,80}-$/.test(row.workerJobPrefix) ||
      identity.name !== "iliya" || identity.email !== "iliyazelenkog@gmail.com") throw new Error("mimo_project_bridge_prepare_plan_invalid");
  const raw = row.binding as Record<string, unknown>;
  const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1, operation: MimoProjectBridgeOperation.Status,
    jobId: "preparation-validation", machineId: raw?.machineId, projectId: raw?.projectId, workstreamId: raw?.workstreamId });
  const binding = parseHostedMimoProjectBinding(raw, request);
  const sourceSnapshotPath = researchPath(row.sourceSnapshotPath), authRootDir = researchPath(row.authRootDir);
  if (binding.sourceWorkspacePath !== join(binding.scratchRoot, "source") ||
      sourceSnapshotPath === binding.scratchRoot || sourceSnapshotPath.startsWith(binding.scratchRoot + "/") ||
      [binding.stateRoot, binding.scratchRoot].some(root => authRootDir === root || authRootDir.startsWith(root + "/") || root.startsWith(authRootDir + "/")))
    throw new Error("mimo_project_bridge_prepare_plan_invalid");
  return { binding, sourceSnapshotPath, authRootDir, repositoryKey: row.repositoryKey, repositoryUrl: row.repositoryUrl,
    workerJobPrefix: row.workerJobPrefix, commitIdentity: { name: identity.name, email: identity.email } };
}
function scalar(raw: string): unknown { try { return raw.startsWith('"') ? JSON.parse(raw) : raw; } catch { throw new Error("mimo_project_bridge_repository_invalid"); } }
function configuredRepository(yaml: string, key: string): Record<string, unknown> {
  const lines = yaml.split("\n"), start = lines.findIndex(line => line === "repositories:");
  if (start < 0 || lines.filter(line => line === "repositories:").length !== 1) throw new Error("mimo_project_bridge_repository_invalid");
  let selected = false, matches = 0; const result: Record<string, unknown> = {};
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(" ") && !line.startsWith("#")) break;
    const section = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (section) { selected = section[1] === key; if (selected) matches++; continue; }
    if (!selected || !line.trim() || line.trimStart().startsWith("#")) continue;
    const field = /^    (url|branch|exact_head):\s*(\S.*?)\s*$/.exec(line);
    if (!field || Object.hasOwn(result, field[1]!)) throw new Error("mimo_project_bridge_repository_invalid");
    result[field[1]!] = scalar(field[2]!);
  }
  if (matches !== 1) throw new Error("mimo_project_bridge_repository_invalid"); return result;
}
function makePrivate(path: string): void {
  if (!existsSync(path)) { researchCustody(dirname(path)); mkdirSync(path, { mode: 0o700 }); }
  researchCustody(path, true);
}
export function assertPreparationSandbox(workspace: string, subdirectory: string): void {
  const path = join(workspace, subdirectory); researchCustody(path);
  if (!lstatSync(path).isDirectory()) throw new Error("mimo_project_bridge_sandbox_directory_required");
  const tracked = preparationSafeGit(["-C", workspace, "ls-files", "--", subdirectory + "/"]);
  if (!tracked || !tracked.split("\n").every(file => file.startsWith(subdirectory + "/")))
    throw new Error("mimo_project_bridge_sandbox_tracked_required");
}
export async function prepareHostedMimoProject(inputPath: string): Promise<unknown> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const plan = parseHostedMimoPreparationPlan(JSON.parse(hostedMimoBridgeMetadataBytes(inputPath).toString()));
  const { binding: b } = plan;
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== b.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  assertHostedMimoProjectRouteOpen(b);
  const repo = configuredRepository(hostedMimoBridgeMetadataBytes(`/etc/subscription-runtime/projects/${b.projectId}.d/${b.workstreamId}.yml`).toString(), plan.repositoryKey);
  if (repo.url !== plan.repositoryUrl || "origin/" + repo.branch !== b.sourceRef || repo.exact_head !== b.sourceCommit)
    throw new Error("mimo_project_bridge_repository_mismatch");
  researchCustody(plan.sourceSnapshotPath); researchCustody(plan.authRootDir);
  assertPreparationGitMetadata(plan.sourceSnapshotPath);
  const git = (args: string[]) => preparationSafeGit(["-C", plan.sourceSnapshotPath, ...args]);
  if (git(["ls-files", "--stage"]).split("\n").some(line => line.startsWith("160000 "))) throw new Error("mimo_project_bridge_snapshot_linked_git");
  if (git(["remote", "get-url", "origin"]) !== plan.repositoryUrl || git(["rev-parse", "--verify", b.sourceRef + "^{commit}"]) !== b.sourceCommit ||
      git(["rev-parse", "HEAD"]) !== b.sourceCommit || git(["status", "--porcelain"]) !== "") throw new Error("mimo_project_bridge_snapshot_invalid");
  const admission = workerLaunchAdmissionSchema.parse(b.admission), contract = admission.contract;
  if ([contract.canonicalSha, contract.baseSha, contract.phaseStartSha].some(sha => sha !== undefined && sha !== b.sourceCommit))
    throw new Error("mimo_project_bridge_admission_source_mismatch");
  for (const path of [contract.controllerPacket, contract.lanePacket, ...contract.mandatoryDocs, ...contract.mandatoryScripts, ...contract.mandatoryFixtures])
    {
      hostedMimoBridgeMetadataBytes(join(plan.sourceSnapshotPath, path), 1048576);
      if (git(["ls-files", "--error-unmatch", "--", path]) !== path) throw new Error("mimo_project_bridge_packet_untracked");
    }
  // Fail before effects if there is no actual sandbox directory in the snapshot.
  const sandboxRelative = relative(b.sourceWorkspacePath, contract.executionPolicy.sandboxRoot);
  assertPreparationSandbox(plan.sourceSnapshotPath, sandboxRelative);
  if (existsSync(b.stateRoot) || existsSync(b.scratchRoot) || existsSync(`/etc/subscription-runtime/mimo-projects/${b.projectId}/${b.workstreamId}.json`))
    throw new Error("mimo_project_bridge_prepare_already_exists");
  for (const base of ["/srv/worker-state/mimo-projects", "/srv/workers/mimo-projects"]) { makePrivate(base); makePrivate(join(base, b.projectId)); }
  makePrivate(b.stateRoot); makePrivate(b.scratchRoot);
  // A retained once-only plan marks partial preparation; never silently replay it.
  writeFileSync(join(b.stateRoot, "preparation.json"), JSON.stringify(plan) + "\n", { flag: "wx", mode: 0o600 });
  preparationSafeGit(["clone", "--no-hardlinks", "--no-local", "--", plan.sourceSnapshotPath, b.sourceWorkspacePath]);
  preparationSafeGit(["-C", b.sourceWorkspacePath, "remote", "set-url", "origin", plan.repositoryUrl]);
  preparationSafeGit(["-C", b.sourceWorkspacePath, "checkout", "--detach", b.sourceCommit]);
  preparationSafeGit(["-C", b.sourceWorkspacePath, "update-ref", "refs/remotes/" + b.sourceRef, b.sourceCommit]);
  researchCustody(b.sourceWorkspacePath);
  assertPreparationGitMetadata(b.sourceWorkspacePath);
  assertPreparationSandbox(b.sourceWorkspacePath, sandboxRelative);
  makePrivate(b.registryRootDir); makePrivate(join(b.scratchRoot, "workspaces"));
  const reviewedOutputRoot = join(b.stateRoot, "reviewed-worker-outputs");
  // Canonical job birth materializes ledger/evidence custody before publication.
  for (const path of [reviewedOutputRoot, join(reviewedOutputRoot, ".locks"), join(reviewedOutputRoot, ".locks", "workspace-locks")]) makePrivate(path);
  const promptPath = join(b.stateRoot, "controller-prompt.md");
  writeFileSync(promptPath, controllerPrompt, { flag: "wx", mode: 0o600 });
  await publishPreparedController(plan);
  return await onboardPreparedController(plan);
}

type Preparation = ReturnType<typeof parseHostedMimoPreparationPlan>;
function preparationController(plan: Preparation) {
  const b = plan.binding;
  const evidenceRoot = join(b.registryRootDir, "archives"), ledgerRoot = join(b.registryRootDir, "consumed-output-ledger");
  const scope: ProjectAccessScope = { projectId: b.projectId, registryRoot: b.registryRootDir, authRoot: plan.authRootDir,
    workspaceRoots: [b.scratchRoot], worktreeRoots: [join(b.scratchRoot, "workspaces")], observedWorkspaceRoots: [b.sourceWorkspacePath],
    jobIdPrefixes: [plan.workerJobPrefix, b.controllerJobId], tmuxSessionPrefixes: [plan.workerJobPrefix, b.controllerJobId],
    allowedBranches: [b.sourceRef, b.sourceRef.slice(7), "feat/" + plan.workerJobPrefix + "*"], allowedGitRemotes: ["origin"],
    consumedOutputEvidenceRoots: [evidenceRoot], consumedOutputLedgerRoots: [ledgerRoot],
    allowedAccountIds: ["account-q"], commitIdentity: plan.commitIdentity, preStartAdmission: { required: true, mode: "serial-builtin" } };
  return { jobId: b.controllerJobId,
    taskId: b.controllerJobId, jobRootDir: join(b.stateRoot, "controller"), workspacePath: b.sourceWorkspacePath, promptPath: join(b.stateRoot, "controller-prompt.md"),
    authRootDir: plan.authRootDir, accounts: ["account-q"], accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: scope };
}
async function publishPreparedController(plan: Preparation, preparation?: ProtectedCodexGoalJobBirthPreparation, assertCurrent?: () => void) {
  assertCurrent?.();
  const b = plan.binding;
  await createCodexGoalJob({ registryRootDir: b.registryRootDir, overwrite: false, manifest: preparationController(plan),
    ...(preparation ? { protectedBirthPreparation: preparation } : {}) });
  assertCurrent?.();
  const reviewedPath = join(b.stateRoot, "reviewed-binding.json");
  writeFileSync(reviewedPath, JSON.stringify(b) + "\n", { flag: "wx", mode: 0o600 });
  return reviewedPath;
}
async function onboardPreparedController(plan: Preparation, context?: Parameters<typeof onboardHostedMimoProject>[1]) {
  return { ...await onboardHostedMimoProject(join(plan.binding.stateRoot, "reviewed-binding.json"), context) as object, workerJobPrefix: plan.workerJobPrefix };
}


/** Trusted one-shot continuation of the exact pre-controller phase only. This
 * cannot adopt an existing controller root, re-clone source, or replay an intent. */
export type MimoPreparationProducerClosure = (original: Readonly<{
  planSha256: string; retainedPreparationSha256: string; failedResultSha256: string;
}>) => string;
export async function resumeHostedMimoProjectPreparation(inputPath: string, assertOriginalProducerClosed: MimoPreparationProducerClosure): Promise<unknown> {
  if (typeof assertOriginalProducerClosed !== "function") throw new Error("mimo_project_bridge_prepare_resume_refused");
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const inputBytes = hostedMimoBridgeMetadataBytes(inputPath), input = researchRecord(JSON.parse(inputBytes.toString()),
    "schemaVersion,preparationPlanPath,expectedPlanSha256,expectedPreparationSha256,failedResultPath,expectedFailedResultSha256,runtimeDirectory,artifactSha256,directories");
  const refused = (): never => { throw new Error("mimo_project_bridge_prepare_resume_refused"); };
  if (input.schemaVersion !== 1) refused();
  for (const key of ["expectedPlanSha256", "expectedPreparationSha256", "expectedFailedResultSha256", "artifactSha256"])
    if (typeof input[key] !== "string" || !/^[a-f0-9]{64}$/.test(input[key] as string)) refused();
  const planPath = researchPath(input.preparationPlanPath), failurePath = researchPath(input.failedResultPath);
  const planBytes = hostedMimoBridgeMetadataBytes(planPath), plan = parseHostedMimoPreparationPlan(JSON.parse(planBytes.toString()));
  const b = plan.binding, runtimeDirectory = researchPath(input.runtimeDirectory);
  const admission = workerLaunchAdmissionSchema.parse(b.admission);
  const artifactSha256 = input.artifactSha256 as string;
  if (researchHash(planBytes) !== input.expectedPlanSha256 || !Array.isArray(input.directories) || input.directories.length !== 4) refused();
  const paths = [b.stateRoot, b.scratchRoot, b.registryRootDir, b.sourceWorkspacePath];
  const directories = (input.directories as unknown[]).map((value, index) => {
    const row = researchRecord(value, "path,device,inode");
    if (row.path !== paths[index] || !Number.isSafeInteger(row.device) || (row.device as number) < 0 ||
        !Number.isSafeInteger(row.inode) || (row.inode as number) < 1) refused();
    return row as ResearchDirectoryIdentity;
  });
  const preparationPath = join(b.stateRoot, "preparation.json"), promptPath = join(b.stateRoot, "controller-prompt.md");
  const intentPath = join(b.stateRoot, "preparation-resume.intent.json");
  const controllerRoot = join(b.stateRoot, "controller"), birthBase = join(researchAuthorityRoot, "job-births", researchHash(controllerRoot));
  const absent = (path: string): boolean => {
    let parent = dirname(path);
    for (;;) { try { researchCustody(parent); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === "/") throw error; parent = dirname(parent); } }
    try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  };
  const yamlPath = `/etc/subscription-runtime/projects/${b.projectId}.d/${b.workstreamId}.yml`, yamlBytes = hostedMimoBridgeMetadataBytes(yamlPath);
  let heldFence: HeldMimoPreparationFence | undefined, closureSha256: string | undefined, intentBytes: Buffer | undefined;
  const assertProducerClosed = (): void => {
    // The internal operator supplies a live source-owned verifier, never a DTO
    // assertion. Its positive terminal/cold proof must bind this exact failure.
    const current = assertOriginalProducerClosed(Object.freeze({ planSha256: researchHash(planBytes),
      retainedPreparationSha256: input.expectedPreparationSha256 as string, failedResultSha256: input.expectedFailedResultSha256 as string }));
    if (typeof current !== "string" || !/^[a-f0-9]{64}$/.test(current) || (closureSha256 !== undefined && current !== closureSha256)) refused();
    closureSha256 = current;
  };
  const assertCurrentPreparation = (): void => {
    assertResearchInitialRoot(true); assertResearchSharedHost();
    if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== b.machineId ||
        realpathSync(fileURLToPath(new URL("../../", import.meta.url))) !== runtimeDirectory ||
        realpathSync("/opt/subscription-runtime/mimo-project-bridge-current") !== runtimeDirectory) refused();
    assertQualifiedResearchRuntimeArtifact(runtimeDirectory, artifactSha256);
    const routing = JSON.parse(hostedMimoBridgeMetadataBytes("/etc/subscription-runtime/mimo-project-runtime-routing.json").toString());
    if (routing.schemaVersion !== 2 || routing.currentRuntimeDirectory !== runtimeDirectory || routing.currentArtifactSha256 !== artifactSha256) refused();
    assertHostedMimoProjectRouteOpen(b, heldFence);
    if (intentBytes && !hostedMimoBridgeMetadataBytes(intentPath).equals(intentBytes)) refused();
    for (const directory of directories) assertResearchDirectory(directory);
    if (!hostedMimoBridgeMetadataBytes(inputPath).equals(inputBytes) || !hostedMimoBridgeMetadataBytes(planPath).equals(planBytes)) refused();
    const retained = hostedMimoBridgeMetadataBytes(preparationPath), failure = hostedMimoBridgeMetadataBytes(failurePath);
    if (researchHash(retained) !== input.expectedPreparationSha256 || !isDeepStrictEqual(JSON.parse(retained.toString()), plan) ||
        researchHash(failure) !== input.expectedFailedResultSha256 || !isDeepStrictEqual(JSON.parse(failure.toString()), { ok: false, error: "mimo_project_bridge_operation_failed" }) ||
        hostedMimoBridgeMetadataBytes(promptPath).toString() !== controllerPrompt) refused();
    if (!hostedMimoBridgeMetadataBytes(yamlPath).equals(yamlBytes)) refused();
    const repo = configuredRepository(yamlBytes.toString(), plan.repositoryKey);
    if (repo.url !== plan.repositoryUrl || "origin/" + repo.branch !== b.sourceRef || repo.exact_head !== b.sourceCommit) refused();
    for (const workspace of [plan.sourceSnapshotPath, b.sourceWorkspacePath]) {
      researchCustody(workspace); assertPreparationGitMetadata(workspace);
      const git = (args: string[]) => preparationSafeGit(["-C", workspace, ...args]);
      if (git(["remote", "get-url", "origin"]) !== plan.repositoryUrl || git(["rev-parse", "HEAD"]) !== b.sourceCommit ||
          git(["rev-parse", "--verify", b.sourceRef + "^{commit}"]) !== b.sourceCommit || git(["status", "--porcelain"]) !== "") refused();
      assertPreparationSandbox(workspace, relative(b.sourceWorkspacePath, admission.contract.executionPolicy.sandboxRoot));
    }
    // Reuse the existing validated scratch policy and its actual 5 GiB free floor;
    // no retained-after-build or later-install budget is added here.
    if (!resolveHostScratchTempRoot(controllerRoot)) refused();
    assertProducerClosed();
    assertHostedMimoProjectRouteOpen(b, heldFence);
  };
  const validate = (consumedIntent = false): void => {
    assertCurrentPreparation();
    if (readdirSync(b.registryRootDir).length || readdirSync(join(b.scratchRoot, "workspaces")).length ||
        ![controllerRoot, join(b.stateRoot, "reviewed-binding.json"), `/etc/subscription-runtime/mimo-projects/${b.projectId}/${b.workstreamId}.json`,
          birthBase + ".json", birthBase + ".first-effect.json", join(b.stateRoot, "mimo-runtime-starts", b.controllerJobId + ".json"),
          join(b.stateRoot, "mimo-bridge-operations"), join(b.stateRoot, "jobs")].every(absent) ||
        !researchJobRuntimeNamespaceAbsent(b.controllerJobId) || !hostedOrdinaryWriterAuthorityAbsent(b.controllerJobId) || (!consumedIntent && !absent(intentPath))) refused();
    assertProducerClosed();
    assertHostedMimoProjectRouteOpen(b, heldFence);
  };
  validate();
  const fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: b.stateRoot,
    owner: "mimo-prepare-resume:" + researchHash(inputBytes) });
  try {
    heldFence = captureHeldMimoPreparationFence(b, fence);
    await withProtectedCodexGoalJobBirthPublication(async () => {
      validate();
      researchPublish(intentPath, { schemaVersion: 1, resumePlanSha256: researchHash(inputBytes),
        retainedPreparationSha256: input.expectedPreparationSha256, failedResultSha256: input.expectedFailedResultSha256,
        originalProducerClosureSha256: closureSha256, runtimeDirectory, artifactSha256, directories }, true);
      intentBytes = hostedMimoBridgeMetadataBytes(intentPath);
    });
    // Recheck under the same publication mutex before exclusive root birth.
    // Tail failure retains the intent and cannot be resumed again.
    const preparation = await withProtectedCodexGoalJobBirthPublication(async () => {
      validate(true);
      return await prepareProtectedCodexGoalJobBirth({ manifest: preparationController(plan), registryRootDir: b.registryRootDir });
    });
    if (!preparation) refused();
    assertCurrentPreparation();
    await publishPreparedController(plan, preparation, assertCurrentPreparation);
    assertCurrentPreparation();
    const answer = await onboardPreparedController(plan, { heldFence, assertCurrent: assertCurrentPreparation });
    assertCurrentPreparation();
    return { ...answer as object, resumeIntentSha256: researchHash(researchRead(intentPath)) };
  } finally { await releaseLocalControllerMaintenanceFence(fence); }
}
