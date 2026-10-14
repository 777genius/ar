import { existsSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { preparationSafeGit, assertPreparationGitMetadata } from "./hosted-mimo-project-source";
export { preparationSafeGit, assertPreparationGitMetadata } from "./hosted-mimo-project-source";
import { dirname, join, relative } from "node:path";
import { AccessBoundary, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob } from "./codex-goal-jobs";
import { assertResearchInitialRoot, assertResearchSharedHost } from "./research-launch-host";
import { researchCustody, researchPath, researchRecord } from "./research-launch-files";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation } from "./hosted-mimo-project-bridge-contract";
import { assertHostedMimoProjectRouteOpen, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { onboardHostedMimoProject } from "./hosted-mimo-project-bridge-onboard";
import { workerLaunchAdmissionSchema } from "./application/project-control/worker-launch-spec";

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
  const evidenceRoot = join(b.registryRootDir, "archives"), ledgerRoot = join(b.registryRootDir, "consumed-output-ledger");
  const reviewedOutputRoot = join(b.stateRoot, "reviewed-worker-outputs");
  // Canonical job birth materializes ledger/evidence custody before publication.
  for (const path of [reviewedOutputRoot, join(reviewedOutputRoot, ".locks"), join(reviewedOutputRoot, ".locks", "workspace-locks")]) makePrivate(path);
  const promptPath = join(b.stateRoot, "controller-prompt.md");
  writeFileSync(promptPath, "Operator-owned MiMo project controller. Never launch this controller.\n", { flag: "wx", mode: 0o600 });
  const scope: ProjectAccessScope = { projectId: b.projectId, registryRoot: b.registryRootDir, authRoot: plan.authRootDir,
    workspaceRoots: [b.scratchRoot], worktreeRoots: [join(b.scratchRoot, "workspaces")], observedWorkspaceRoots: [b.sourceWorkspacePath],
    jobIdPrefixes: [plan.workerJobPrefix, b.controllerJobId], tmuxSessionPrefixes: [plan.workerJobPrefix, b.controllerJobId],
    allowedBranches: [b.sourceRef, b.sourceRef.slice(7), "feat/" + plan.workerJobPrefix + "*"], allowedGitRemotes: ["origin"],
    consumedOutputEvidenceRoots: [evidenceRoot], consumedOutputLedgerRoots: [ledgerRoot],
    allowedAccountIds: ["account-q"], commitIdentity: plan.commitIdentity, preStartAdmission: { required: true, mode: "serial-builtin" } };
  await createCodexGoalJob({ registryRootDir: b.registryRootDir, overwrite: false, manifest: { jobId: b.controllerJobId,
    taskId: b.controllerJobId, jobRootDir: join(b.stateRoot, "controller"), workspacePath: b.sourceWorkspacePath, promptPath,
    authRootDir: plan.authRootDir, accounts: ["account-q"], accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: scope } });
  const reviewedPath = join(b.stateRoot, "reviewed-binding.json");
  writeFileSync(reviewedPath, JSON.stringify(b) + "\n", { flag: "wx", mode: 0o600 });
  return { ...await onboardHostedMimoProject(reviewedPath) as object, workerJobPrefix: plan.workerJobPrefix };
}
