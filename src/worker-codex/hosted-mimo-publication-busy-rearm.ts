import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { readCodexGoalJob } from "./codex-goal-jobs";
import { loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchAuthorityRoot, researchDirectoryIdentity, researchHash } from "./research-launch-files";
import { hostedOrdinaryWriterAuthorityAbsent } from "./hosted-ordinary-writer-authority";
import { observeCompatibleProtectedCodexGoalJobBirth, withProtectedCodexGoalJobBirthPublication } from "./protected-job-birth";
import { assertProjectPreStartAdmissionLaunchBinding, assertProjectPreStartAdmissionDescriptorPaths } from "./application/project-control/codex-goal-project-pre-start-admission";
import { captureProjectPreStartBinding } from "./application/project-control/codex-goal-project-pre-start-binding";

function refused(): never { throw new Error("mimo_project_bridge_publication_busy_rearm_refused"); }
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
/** Bookkeeping proof only. No lease, receipt, claim, birth or workspace changes. */
export async function capturePublicationBusyStartRearm(request: MimoProjectBridgeRequest) {
  assertResearchInitialRoot(true);
  if (request.operation !== MimoProjectBridgeOperation.Start) refused();
  const deadline = performance.now() + 60_000;
  // Deep Git/controller reads precede our explicit publication section.
  // The existing compatible-birth reader retains its own protected check.
  // An intervening launch retains monotonic first-effect history; the short
  // publication below must still prove its absence and every captured byte.
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`;
  const bindingBytes = hostedMimoBridgeMetadataBytes(bindingPath);
  const binding = parseHostedMimoProjectBinding(JSON.parse(bindingBytes.toString()), request);
  const controllerPath = join(binding.registryRootDir, binding.controllerJobId, "job.json"), manifestPath = join(binding.registryRootDir, request.jobId, "job.json");
  const controllerBytes = hostedMimoBridgeMetadataBytes(controllerPath, 1048576), manifestBytes = hostedMimoBridgeMetadataBytes(manifestPath, 1048576);
  const { scope } = await loadProjectControlController({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId });
  const job = await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: request.jobId });
  const descriptor = job.projectPreStartAdmission;
  if (!descriptor || job.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || job.jobRootDir !== join(binding.stateRoot, "jobs", request.jobId) ||
      job.workspacePath !== join(binding.scratchRoot, "workspaces", request.jobId) ||
      scope.projectId !== binding.projectId || !scope.allowedAccountIds?.includes("account-q") || job.promptPath !== join(job.jobRootDir, "prompt.md")) refused();
  assertProjectPreStartAdmissionDescriptorPaths(descriptor, job.jobRootDir);
  const root = researchDirectoryIdentity(job.jobRootDir);
  const births = [researchHash(job.jobRootDir), `physical-${root.device}-${root.inode}`].map(key => join(researchAuthorityRoot, "job-births", key));
  const absentPaths = [join(researchAuthorityRoot, researchHash(request.jobId)), join(job.jobRootDir, "account-reservation.json"),
    ...births.map(path => path + ".first-effect.json")];
  const checkAbsent = () => { if (absentPaths.some(path => !absent(path)) || !hostedOrdinaryWriterAuthorityAbsent(job.jobId)) refused(); };
  checkAbsent();
  const receiptBytes = hostedMimoBridgeMetadataBytes(descriptor.receiptPath, 65536);
  const receipt = JSON.parse(receiptBytes.toString()) as { status?: unknown; launchAuthorizationCount?: unknown };
  if (receipt.status !== "validated_not_launched" || (receipt.launchAuthorizationCount !== undefined && receipt.launchAuthorizationCount !== 0)) refused();
  const paths = [bindingPath, controllerPath, manifestPath, job.promptPath, descriptor.contractPath, descriptor.statePath, descriptor.receiptPath, ...births.map(path => path + ".json")];
  const bindings = paths.map(path => ({ path, sha256: researchHash(hostedMimoBridgeMetadataBytes(path, 1048576)) }));
  const directories = [binding.registryRootDir, binding.sourceWorkspacePath, job.workspacePath, job.jobRootDir].map(researchDirectoryIdentity);
  await assertProjectPreStartAdmissionLaunchBinding({ manifest: job, scope });
  const workspace = await captureProjectPreStartBinding(job, descriptor);
  if (workspace.workspaceHead !== binding.sourceCommit || workspace.workspaceStatus.trim() !== "" || workspace.workspaceUnstagedDirty) refused();
  if ((await observeCompatibleProtectedCodexGoalJobBirth(job)).status !== "released") refused();
  return await withProtectedCodexGoalJobBirthPublication(async () => {
    checkAbsent();
    if (!hostedMimoBridgeMetadataBytes(bindingPath).equals(bindingBytes) ||
        !hostedMimoBridgeMetadataBytes(controllerPath, 1048576).equals(controllerBytes) ||
        !hostedMimoBridgeMetadataBytes(manifestPath, 1048576).equals(manifestBytes) ||
        !hostedMimoBridgeMetadataBytes(descriptor.receiptPath, 65536).equals(receiptBytes) ||
        bindings.some(({ path, sha256 }) => researchHash(hostedMimoBridgeMetadataBytes(path, 1048576)) !== sha256) ||
        !isDeepStrictEqual(directories, directories.map(({ path }) => researchDirectoryIdentity(path))) || performance.now() > deadline) refused();
    checkAbsent();
    if (performance.now() > deadline) refused();
    return { schemaVersion: 1, requestSha256: researchHash(JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))),
      bindings, directories, workspaceBindingSha256: researchHash(JSON.stringify(workspace)) };
  });
}
export type PublicationBusyStartRearmProof = Awaited<ReturnType<typeof capturePublicationBusyStartRearm>>;
/** Fresh execution guard: an earlier observation is never launch permission. */
export async function assertPublicationBusyStartRearmCurrent(request: MimoProjectBridgeRequest, expected: PublicationBusyStartRearmProof): Promise<void> {
  if (!isDeepStrictEqual(await capturePublicationBusyStartRearm(request), expected)) refused();
}
export function publicationBusyRearmPath(stateRoot: string, jobId: string, previousGeneration: number): string {
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0) refused();
  return join(stateRoot, "mimo-bridge-operations", `${jobId}.start.publication-busy-rearm-${previousGeneration}.json`);
}
export function isPublicationBusyResult(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === "error,ok" &&
    (value as { ok?: unknown }).ok === false && (value as { error?: unknown }).error === "protected_job_birth_publication_busy";
}
