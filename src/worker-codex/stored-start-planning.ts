import { createHash } from "node:crypto";
import { join } from "node:path";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { goalLaunchInputFromRecord } from "./application/codex-goal-launch-input";
import { codexGoalJobManifestPath, codexGoalJobToArgs, parseStoredCodexGoalJobManifest,
  type CodexGoalJobManifest } from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

/** Equality data only. The actual inventory/start and broker supply authority. */
export type StoredProjectStartBinding = Readonly<{
  schemaVersion: 1;
  controllerManifestSha256: string;
  workerManifestSha256: string;
  scopeSha256: string;
  launchSha256: string;
  promptSha256: string;
  preStart: Readonly<{ contractSha256: string; stateSha256: string; receiptSha256: string }> | null;
}>;
export type StoredProjectStartPlan = Readonly<{
  args: ProjectControlMcpArgs;
  jobId: string;
  jobRoot: string;
  workspace: string;
  output: string;
  taskId: string;
  registryRootDir: string;
  controller: CodexGoalJobManifest;
  manifest: CodexGoalJobManifest;
  launch: CodexGoalLaunchInput;
  binding: StoredProjectStartBinding;
}>;
export type StoredProjectStartSnapshots = Readonly<{
  controller: Buffer;
  worker: Buffer;
  prompt: Buffer;
  preStart: Readonly<{ contract: Buffer; state: Buffer; receipt: Buffer }> | null;
}>;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new Error("hosted_stored_project_start_binding_invalid"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",") ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"))) invalid();
  return value as Record<string, unknown>;
}
export function parseStoredProjectStartBinding(value: unknown): StoredProjectStartBinding {
  const row = record(value, ["schemaVersion", "controllerManifestSha256", "workerManifestSha256",
    "scopeSha256", "launchSha256", "promptSha256", "preStart"]);
  const sha = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value;
  };
  if (row.schemaVersion !== 1) invalid();
  const preStart = row.preStart === null ? null : record(row.preStart,
    ["contractSha256", "stateSha256", "receiptSha256"]);
  return Object.freeze({ schemaVersion: 1,
    controllerManifestSha256: sha(row.controllerManifestSha256), workerManifestSha256: sha(row.workerManifestSha256),
    scopeSha256: sha(row.scopeSha256), launchSha256: sha(row.launchSha256), promptSha256: sha(row.promptSha256),
    preStart: preStart === null ? null : Object.freeze({ contractSha256: sha(preStart.contractSha256),
      stateSha256: sha(preStart.stateSha256), receiptSha256: sha(preStart.receiptSha256) }) });
}
function canonicalPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 4096 &&
    /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) &&
    !path.split("/").some(part => part === "." || part === "..");
}
export function parseStoredProjectStartArgs(originalJson: string): ProjectControlMcpArgs {
  if (Buffer.byteLength(originalJson) > 4096) invalid();
  const value: unknown = JSON.parse(originalJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const keys = ["controllerJobId", "jobId", "registryRootDir", "confirmStart", "forceStart", "skipDoctor",
    "dependencyBootstrap", ...(row.storedStartBinding === undefined ? [] : ["storedStartBinding"])];
  record(row, keys);
  if (![row.controllerJobId, row.jobId].every(value => typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) || !canonicalPath(row.registryRootDir) ||
      row.controllerJobId === row.jobId || row.confirmStart !== true || row.forceStart !== false ||
      row.skipDoctor !== false || row.dependencyBootstrap !== "off") invalid();
  if (row.storedStartBinding !== undefined) parseStoredProjectStartBinding(row.storedStartBinding);
  return Object.freeze(row) as ProjectControlMcpArgs;
}
function manifest(bytes: Buffer): CodexGoalJobManifest {
  return parseStoredCodexGoalJobManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

/** Pure planning over actual read snapshots; never invokes observation, doctor,
 * account reservation, validators, the start tool or workspace mutation. */
export function planStoredProjectStart(originalJson: string, cwd: string,
  snapshots: StoredProjectStartSnapshots): StoredProjectStartPlan {
  const args = parseStoredProjectStartArgs(originalJson), controller = manifest(snapshots.controller), worker = manifest(snapshots.worker);
  if (controller.jobId !== args.controllerJobId || worker.jobId !== args.jobId ||
      controller.accessBoundary !== AccessBoundary.ProjectScopedControl || !controller.projectAccessScope) invalid();
  const launch = goalLaunchInputFromRecord({ ...codexGoalJobToArgs(worker),
    durableHandoffRootDir: worker.durableHandoffRootDir ?? join(args.registryRootDir!, "durable-handoffs") },
    worker.cwd ?? cwd);
  const config = launch.config, jobRoot = worker.jobRootDir, output = config.outputPath;
  const defaultOutput = `${jobRoot}/${worker.taskId}.latest-result.json`;
  const stateOutput = typeof output === "string" && output.startsWith(`${jobRoot}/state/`) &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}-result\.json$/.test(output.slice(`${jobRoot}/state/`.length));
  if (!canonicalPath(jobRoot) || !jobRoot.endsWith(`/jobs/${worker.jobId}`) ||
      worker.workspacePath !== `${jobRoot}/workspace` || cwd !== worker.workspacePath || launch.cwd !== cwd ||
      config.jobRootDir !== jobRoot || config.workspacePath !== cwd || config.taskId !== worker.taskId ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(worker.taskId) || !canonicalPath(output) ||
      output !== defaultOutput && !stateOutput ||
      [config.promptPath, config.progressPath, launch.logPath].includes(output) ||
      [config.authRootDir, config.workspacePath, args.registryRootDir, config.durableHandoffRootDir]
        .some(path => path !== undefined && (output === path || output.startsWith(path + "/")))) invalid();
  if ((worker.projectPreStartAdmission === undefined) !== (snapshots.preStart === null)) invalid();
  const preStart = snapshots.preStart;
  const binding: StoredProjectStartBinding = Object.freeze({ schemaVersion: 1,
    controllerManifestSha256: digest(snapshots.controller), workerManifestSha256: digest(snapshots.worker),
    scopeSha256: digest(JSON.stringify(controller.projectAccessScope)), launchSha256: digest(JSON.stringify(launch)),
    promptSha256: digest(snapshots.prompt), preStart: preStart === null ? null : Object.freeze({
      contractSha256: digest(preStart.contract), stateSha256: digest(preStart.state), receiptSha256: digest(preStart.receipt) }) });
  return Object.freeze({ args, jobId: worker.jobId, jobRoot, workspace: cwd, output, taskId: worker.taskId,
    registryRootDir: args.registryRootDir!, controller, manifest: worker, launch, binding });
}
function bytes(path: string, maximum: number): Buffer {
  const value = readHostedPrivateBytes(path, maximum); if (!value) invalid(); return value;
}
/** Bounded synchronous protected reads are required because the original
 * activation fence is synchronous. No async work is released from that fence. */
export function readStoredProjectStartPlan(originalJson: string, cwd: string): StoredProjectStartPlan {
  const args = parseStoredProjectStartArgs(originalJson), registryRootDir = args.registryRootDir!;
  const controller = bytes(codexGoalJobManifestPath({ registryRootDir, jobId: args.controllerJobId! }), 64 * 1024);
  const worker = bytes(codexGoalJobManifestPath({ registryRootDir, jobId: args.jobId! }), 64 * 1024);
  const parsed = manifest(worker), descriptor = parsed.projectPreStartAdmission;
  if (descriptor && [descriptor.contractPath, descriptor.statePath, descriptor.receiptPath].some((path, index) =>
      path !== `${parsed.jobRootDir}/pre-start-admission/${["contract", "state", "receipt"][index]}.json`)) invalid();
  const snapshots = { controller, worker, prompt: bytes(parsed.promptPath, 1024 * 1024),
    preStart: descriptor ? { contract: bytes(descriptor.contractPath, 256 * 1024),
      state: bytes(descriptor.statePath, 1024 * 1024), receipt: bytes(descriptor.receiptPath, 64 * 1024) } : null };
  const plan = planStoredProjectStart(originalJson, cwd, snapshots);
  // Bracket every protected file: a collection spanning a revision is rejected.
  if (!bytes(codexGoalJobManifestPath({ registryRootDir, jobId: args.controllerJobId! }), 64 * 1024).equals(controller) ||
      !bytes(codexGoalJobManifestPath({ registryRootDir, jobId: args.jobId! }), 64 * 1024).equals(worker) ||
      !bytes(parsed.promptPath, 1024 * 1024).equals(snapshots.prompt) || descriptor && snapshots.preStart &&
      (!bytes(descriptor.contractPath, 256 * 1024).equals(snapshots.preStart.contract) ||
       !bytes(descriptor.statePath, 1024 * 1024).equals(snapshots.preStart.state) ||
       !bytes(descriptor.receiptPath, 64 * 1024).equals(snapshots.preStart.receipt))) invalid();
  return plan;
}
export function assertStoredProjectStartBinding(plan: StoredProjectStartPlan): void {
  const expected = parseStoredProjectStartBinding(plan.args.storedStartBinding);
  if (JSON.stringify(expected) !== JSON.stringify(plan.binding)) invalid();
}
export function resolveStoredProjectStartPlan(originalJson: string, cwd: string): StoredProjectStartPlan {
  const plan = readStoredProjectStartPlan(originalJson, cwd); assertStoredProjectStartBinding(plan); return plan;
}
