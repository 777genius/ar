import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { claimDependencyConsumer, markDependencyConsumerRunning, DependencyAdmissionError,
  DependencyAdmissionFailure as Failure, DependencyOwnerPhase, DependencyTreeObservationStatus, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence, CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedOrdinaryProcessOrigin } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { assertHostedDependencyQualifiedInventory, assertHostedDependencyPhysicalWorkspace, hostedDependencyOwnerRoot, isHostedDependencyWorkspace,
  readHostedDependencyBinding, readHostedDependencyAttempt, assertHostedDependencyStartAllowed } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { hasHostedDependencyFreshAbsence, materializeHostedDependencyFreshAbsence, matchesHostedDependencyReady,
  readHostedDependencyReceipt, hostedDependencyObservationLimits } from "./hosted-dependency-materialization";

/** First supported profile: safe warm TEST reuse and fresh script-free npm.
 * Actual origin and private grant decide authority; request config carries none.
 */
export async function admitHostedDependencyConsumer(config: CodexGoalRunConfig): Promise<DependencyAttempt | undefined> {
  const selected = isHostedDependencyWorkspace(config.workspacePath);
  if (!isHostedOrdinaryRuntime()) {
    if (selected) fail(Failure.Unsupported);
    return undefined;
  }
  const held = withHostedActivationFence(fence => readHostedOrdinaryProcessOrigin(fence));
  const actualSelected = isHostedDependencyWorkspace(String(held.start.workspacePath));
  if (!actualSelected && !selected) return undefined;
  // Keep the ordinary initial-host principal guard intact. These finite paths
  // are hidden from old managed payloads, not selected by env or model options.
  const admission = withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    if (origin.profileId !== CodexProviderEgressProfileId.TestNpmQualification || !actualSelected ||
        origin.start.workspacePath !== config.workspacePath || origin.start.jobRootDir !== config.jobRootDir ||
        origin.start.jobId !== (config.jobId ?? config.taskId) ||
        (config.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
        config.allowDangerFullAccess || config.providerSandboxMode === "danger-full-access" ||
        config.childLifetime || config.checkpointPublisherSocketPath) fail(Failure.Unsupported);
    if (config.runtimeHomeRootDir !== undefined && config.runtimeHomeRootDir !== `${config.jobRootDir}/home`) fail(Failure.Unsupported);
    const binding = readHostedDependencyBinding(String(origin.start.jobId));
    if (!binding || binding.grantDigest !== origin.start.grantSha256 || binding.installationId !== origin.start.installationId) fail(Failure.Unsupported);
    assertHostedDependencyQualifiedInventory();
    assertHostedDependencyPhysicalWorkspace(binding);
    assertHostedDependencyStartAllowed(String(origin.reservation.startId));
    assertManagedDependencyGitInputs(binding.workspace.canonicalPath);
    const receipt = readHostedDependencyReceipt(binding);
    let tree, absent = false;
    try { tree = lstatSync(`${binding.workspace.canonicalPath}/node_modules`); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (receipt || !hasHostedDependencyFreshAbsence(binding)) fail(Failure.NeedsInstall);
      absent = true;
    }
    if (tree && (!tree.isDirectory() || tree.isSymbolicLink())) fail(Failure.UnsafeTree);
    const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
    try {
      const attempt = claimDependencyConsumer(store, binding.workspace, {
        installationId: binding.installationId, bootId: String(origin.start.bootId), runtimeSha: binding.runtimeSha,
        grantDigest: binding.grantDigest, startId: String(origin.reservation.startId), unit: String(origin.start.unit),
      }, randomUUID());
      return { binding, attempt, absent, receipt };
    } finally { store.close(); }
  });
  // Capture safety while durable ExclusiveMutation prevents other managed
  // consumers/materializers. Incomplete capture stays held, never legacy reuse.
  if (admission.absent) await materializeHostedDependencyFreshAbsence(admission.binding, admission.attempt);
  else if (!admission.receipt || !matchesHostedDependencyReady(admission.binding, admission.receipt)) {
    const observation = await observeDependencyTree({ workspacePath: admission.binding.workspace.canonicalPath,
      treeName: "node_modules", expectedWorkspace: admission.binding.workspace, limits: hostedDependencyObservationLimits });
    if (observation.status !== DependencyTreeObservationStatus.Complete) fail(Failure.UnsafeTree);
  }
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(admission.binding, origin.start, String(origin.reservation.startId),
      // Final ownership remains exclusive until either warm safety capture or
      // contained install verification has completed.
      DependencyOwnerPhase.ExclusiveMutation);
    const current = readHostedDependencyBinding(String(origin.start.jobId));
    if (!current || JSON.stringify(current) !== JSON.stringify(admission.binding)) fail(Failure.Unsupported);
    const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
    try { markDependencyConsumerRunning(store, admission.binding.workspace, admission.attempt); }
    finally { store.close(); }
  });
  return admission.attempt;
}

/** A project cannot configure executable filters/hooks/fsmonitor for privileged
 * host hygiene. Provider .git is OS read-only; host global config is disabled.
 */
export function assertManagedDependencyGitInputs(workspacePath: string): void {
  const fd = openSync(`${workspacePath}/.git/config`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o022)) fail(Failure.Unsupported);
    const bytes = readFileSync(fd);
    config = bytes.toString("utf8");
    if (bytes.length > 65536 || !Buffer.from(config).equals(bytes) || config.includes("\0")) fail(Failure.Unsupported);
  } finally { closeSync(fd); }
  let section = "";
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[(core|user)\]$/i.test(line)) { section = line.slice(1, -1).toLowerCase(); continue; }
    const setting = /^([a-zA-Z]+)\s*=\s*(.*)$/.exec(line);
    if (!setting || (section === "core" ? !["repositoryformatversion", "filemode", "bare", "logallrefupdates"].includes(setting[1]!.toLowerCase()) :
        section === "user" ? !["name", "email"].includes(setting[1]!.toLowerCase()) : true)) fail(Failure.Unsupported);
    if (section === "core" && setting[1]!.toLowerCase() === "bare" && setting[2]!.toLowerCase() !== "false") fail(Failure.Unsupported);
  }
}
/** Mandatory direct-library/prewarm entry, separate from the legacy optional
 * provider callback. A path or a fabricated config cannot mint host authority. */
export function assertHostedDependencyExecutionWorkspace(workspacePath: string | undefined): void {
  if (workspacePath === undefined || !isHostedDependencyWorkspace(workspacePath)) return;
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    if (origin.profileId !== CodexProviderEgressProfileId.TestNpmQualification || origin.start.workspacePath !== workspacePath) fail(Failure.Unsupported);
    const binding = readHostedDependencyBinding(String(origin.start.jobId));
    if (!binding || binding.workspace.canonicalPath !== workspacePath) fail(Failure.Unsupported);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId));
  });
}
function fail(reason: Failure): never { throw new DependencyAdmissionError(reason); }
