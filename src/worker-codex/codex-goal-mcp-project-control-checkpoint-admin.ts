import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { codexGoalJobManifestPath, summarizeCodexGoalJob, updateCodexGoalJob } from "./codex-goal-jobs";
import { projectControlWorkspaceLocks } from "./codex-goal-project-workspace-lock";
import { controllerScopeLockIdentity } from "./codex-goal-mcp-project-control-ledger-epoch";
import { projectControlAuditPath } from "./codex-goal-mcp-project-broker";
import { booleanValue, stringValue } from "./codex-goal-mcp-values";
import type { JobUpdateMcpArgs, ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type {
  CodexGoalMcpProjectControlAdminDeps,
  LoadedProjectControlController,
} from "./codex-goal-mcp-project-control-admin";

/** Publish the monotonic controller policy under the same lock as child starts. */
export async function enableProjectControllerCheckpoint(
  args: ProjectControlMcpArgs & JobUpdateMcpArgs,
  loaded: LoadedProjectControlController,
  deps: Pick<CodexGoalMcpProjectControlAdminDeps, "loadProjectControlController">,
): Promise<Readonly<Record<string, unknown>>> {
  if (args.checkpointRequired !== true) {
    throw new Error("project_control_repair_checkpoint_required_true_only");
  }
  if (args.accounts !== undefined || args.serviceTier !== undefined ||
    args.reviewedOutputId !== undefined || args.description !== undefined ||
    args.tags !== undefined) {
    throw new Error("project_control_repair_controller_fields_mixed");
  }
  const manifestPath = codexGoalJobManifestPath({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.controller.jobId,
  });
  const manifestSha256 = async () => createHash("sha256")
    .update(await readFile(manifestPath)).digest("hex");
  if (loaded.controller.checkpointRequired === true) {
    return {
      ok: true,
      mode: "brokered_project_manifest_repair",
      reason: "no_repair_needed",
      controllerJobId: loaded.controller.jobId,
      registryRootDir: loaded.registryRootDir,
      manifest: loaded.controller,
      summary: summarizeCodexGoalJob(loaded.controller, loaded.registryRootDir),
    };
  }
  if (booleanValue(args.confirmRepair) !== true) {
    return {
      ok: false,
      reason: "confirm_repair_required",
      mode: "brokered_project_manifest_repair",
      controllerJobId: loaded.controller.jobId,
      registryRootDir: loaded.registryRootDir,
      jobId: loaded.controller.jobId,
      auditPath: projectControlAuditPath(loaded.controller),
      expectedManifestSha256: await manifestSha256(),
      proposedPatch: { checkpointRequired: true },
    };
  }
  const expectedManifestSha256 = stringValue(args.expectedManifestSha256);
  if (!expectedManifestSha256) {
    throw new Error("project_control_repair_expected_manifest_sha256_required");
  }
  const locks = projectControlWorkspaceLocks(loaded.registryRootDir);
  const lease = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(
      loaded.registryRootDir, loaded.controller.jobId,
    ),
    owner: `controller-checkpoint-enable:${loaded.controller.jobId}`,
  });
  try {
    const current = await deps.loadProjectControlController(args);
    if (await manifestSha256() !== expectedManifestSha256) {
      throw new Error("project_control_controller_scope_cas_mismatch");
    }
    if (current.controller.checkpointRequired === true) {
      return {
        ok: true,
        mode: "brokered_project_manifest_repair",
        reason: "no_repair_needed",
        controllerJobId: current.controller.jobId,
        registryRootDir: current.registryRootDir,
        manifest: current.controller,
        summary: summarizeCodexGoalJob(current.controller, current.registryRootDir),
      };
    }
    const manifest = await updateCodexGoalJob({
      registryRootDir: current.registryRootDir,
      jobId: current.controller.jobId,
      patch: { checkpointRequired: true },
      expectedManifestSha256,
      expectedParsedManifestSha256: createHash("sha256")
        .update(JSON.stringify(current.controller)).digest("hex"),
    });
    return {
      ok: true,
      mode: "brokered_project_manifest_repair",
      controllerJobId: current.controller.jobId,
      registryRootDir: current.registryRootDir,
      auditPath: projectControlAuditPath(current.controller),
      manifest,
      summary: summarizeCodexGoalJob(manifest, current.registryRootDir),
    };
  } finally {
    await locks.release(lease);
  }
}
