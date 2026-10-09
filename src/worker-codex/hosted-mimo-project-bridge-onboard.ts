import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { researchCustody } from "./research-launch-files";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation } from "./hosted-mimo-project-bridge-contract";
import { assertHostedMimoProjectRouteOpen, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { loadProjectControlController } from "./codex-goal-mcp-project-control-deps";

/** Operator-only enrollment of an already onboarded workstream/controller.
 * This mode is never reachable from the restricted transport's request DTO. */
export async function onboardHostedMimoProject(inputPath: string): Promise<unknown> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const input = JSON.parse(hostedMimoBridgeMetadataBytes(inputPath).toString());
  const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1,
    machineId: input.machineId, projectId: input.projectId, workstreamId: input.workstreamId,
    operation: MimoProjectBridgeOperation.Status, jobId: "onboarding-validation" });
  const binding = parseHostedMimoProjectBinding(input, request);
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== binding.machineId)
    throw new Error("mimo_project_bridge_machine_mismatch");
  assertHostedMimoProjectRouteOpen(binding);
  researchCustody(binding.stateRoot); researchCustody(binding.scratchRoot);
  researchCustody(binding.sourceWorkspacePath); researchCustody(binding.registryRootDir);
  const controller = await loadProjectControlController({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId });
  if (controller.scope.projectId !== binding.projectId || !controller.scope.allowedAccountIds?.includes("account-q"))
    throw new Error("mimo_project_bridge_scope_denied");
  const jobPrefixes = controller.scope.jobIdPrefixes ?? [], tmuxPrefixes = controller.scope.tmuxSessionPrefixes ?? [];
  if (!jobPrefixes.some(job => job.length > 0 && tmuxPrefixes.some(tmux => tmux.length > 0 &&
      (job.startsWith(tmux) || tmux.startsWith(job)))))
    throw new Error("mimo_project_bridge_worker_prefix_scope_denied");
  // Freeze the reviewed branch before enrollment; no clone, fetch or source
  // mutation belongs to this metadata installer.
  const commit = researchCommand("/usr/bin/git", ["-C", binding.sourceWorkspacePath, "rev-parse", "--verify", binding.sourceRef + "^{commit}"]).trim();
  if (commit !== binding.sourceCommit) throw new Error("mimo_project_bridge_source_mismatch");
  for (const selected of [binding.codexBinaryPath, "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js"]) {
    const path = realpathSync(selected); researchCustody(dirname(path)); const file = lstatSync(path);
    if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0) throw new Error("mimo_project_bridge_runtime_invalid");
  }
  const root = "/etc/subscription-runtime/mimo-projects", project = root + "/" + binding.projectId;
  researchCustody("/etc/subscription-runtime");
  for (const path of [root, project]) { if (!existsSync(path)) mkdirSync(path, { mode: 0o700 }); researchCustody(path); }
  writeFileSync(project + "/" + binding.workstreamId + ".json", JSON.stringify(binding) + "\n", { flag: "wx", mode: 0o600 });
  return { ok: true, projectId: binding.projectId, workstreamId: binding.workstreamId, sourceCommit: binding.sourceCommit };
}
