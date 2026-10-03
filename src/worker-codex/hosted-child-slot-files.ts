import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { AccessBoundary, HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { ChildExecutionBudget, parseImmutableChildSlot, type ImmutableChildSlot } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, type HostedActivationFence, decodeHostedActivationBytes, withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedReadonlyHostInventory, type HostedOrdinaryCreator } from "./hosted-readonly-host-kernel";
import { readHostedInstallationActivation, readHostedOrdinaryRuntime, isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { hostedTestEgressGrantRoot, hostedTestEgressGrantName } from "./hosted-test-egress-files";
import { parseHostedTestEgressGrant, assertHostedTestEgressIdentity } from "./hosted-test-egress-contract";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const childSlotRoot = join(readonlySupervisorRoot, "child-slots");
export const childSlotName = (creatorId: string) => digest(creatorId) + ".json";

/** Exact-byte inventory binding is immutable. A partial record cannot be repaired
 * by overwriting it, and resume verifies every inventoried slot before opening. */
export function enrollHostedChildSlot(fence: HostedActivationFence, bytes: Buffer): ImmutableChildSlot {
  assertHostedActivationFence(fence);
  if (readHostedInstallationActivation().activation.phase !== HostedActivationPhase.Closed) invalid();
  if (bytes.length > 32768) invalid();
  try { mkdirSync(childSlotRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const slot = parseImmutableChildSlot(decodeHostedActivationBytes(bytes));
  const creator = readHostedReadonlyHostInventory().ordinaryCreators.find(row => row.creatorId === slot.creatorId);
  if (!creator || creator.childSlotSha256 !== digest(bytes)) invalid();
  assertSlotBinding(slot, creator);
  new ChildExecutionBudget(slot.lifetime).remainingMs();
  for (const other of readHostedReadonlyHostInventory().ordinaryCreators) {
    if (other.creatorId === creator.creatorId || !other.childSlotSha256) continue;
    const retained = readHostedPrivateBytes(join(childSlotRoot, childSlotName(other.creatorId)), 32768);
    if (retained && parseImmutableChildSlot(decodeHostedActivationBytes(retained)).slotId === slot.slotId) invalid();
  }
  const target = join(childSlotRoot, childSlotName(slot.creatorId));
  readHostedPrivateBytes(target, 32768); // Validate private ancestry before first publication too.
  createReadonlyPrivateRecord(target, bytes);
  return slot;
}
export function readHostedChildSlot(creator: HostedOrdinaryCreator): ImmutableChildSlot | undefined {
  if (!creator.childSlotSha256) return undefined;
  const bytes = readHostedPrivateBytes(join(childSlotRoot, childSlotName(creator.creatorId)), 32768);
  if (!bytes || digest(bytes) !== creator.childSlotSha256) invalid();
  const slot = parseImmutableChildSlot(decodeHostedActivationBytes(bytes));
  assertSlotBinding(slot, creator);
  return slot;
}
function assertSlotBinding(slot: ImmutableChildSlot, creator: HostedOrdinaryCreator): void {
  const { installation } = readHostedInstallationActivation();
  const grantBytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, hostedTestEgressGrantName(slot.jobId)), 4096);
  if (!grantBytes || digest(grantBytes) !== slot.grantSha256) invalid();
  const grant = parseHostedTestEgressGrant(decodeHostedActivationBytes(grantBytes));
  assertHostedTestEgressIdentity(grant, slot);
  if (grant.schemaVersion !== 3 || grant.slotId !== slot.slotId || grant.accountId !== slot.lifetime.accountId ||
      slot.creatorId !== creator.creatorId || slot.jobId !== creator.jobId || slot.jobRootDir !== creator.jobRootDir ||
      slot.workspacePath !== creator.workspacePath || slot.artifactSha !== installation.runtimeSha ||
      slot.launch.command !== creator.launch.command || slot.launch.cwd !== creator.launch.cwd || JSON.stringify(slot.launch.args) !== JSON.stringify(creator.launch.args)) invalid();
  // Parents remain root-owned; no child tool can rename the fixed prompt.
  for (let path = dirname(slot.promptPath);; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) invalid();
    if (path === "/") break;
  }
  try {
    const prompt = lstatSync(slot.promptPath);
    if (!prompt.isFile() || prompt.uid !== 0 || prompt.nlink !== 1 || (prompt.mode & 0o077) || prompt.size > 32768) invalid();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const args = slot.launch.args;
  const fixed = (flag: string, value: string) => args.filter(arg => arg === flag).length === 1 && args[args.indexOf(flag) + 1] === value;
  if (!fixed("--prompt", slot.promptPath) || !fixed("--workspace", slot.workspacePath) ||
      !fixed("--job-root", slot.jobRootDir) || !fixed("--job-id", slot.jobId) || !fixed("--task-id", slot.jobId) ||
      !fixed("--auth-root", slot.jobRootDir + "/capacity") || !fixed("--accounts", slot.lifetime.accountId) ||
      args.filter(arg => arg === "--codex-binary").length !== 1 ||
      !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(args[args.indexOf("--codex-binary") + 1] ?? "") ||
      resolve(args[args.indexOf("--codex-binary") + 1] ?? "") !== args[args.indexOf("--codex-binary") + 1] ||
      !fixed("--max-account-cycles", "1") || !fixed("--max-attempts", "1") ||
      !fixed("--continuation-mode", "disabled") || !fixed("--max-goal-turns", String(slot.lifetime.maxGoalTurns)) ||
      !fixed("--child-lifetime-json", JSON.stringify(slot.lifetime)) ||
      !fixed("--execution-engine", "app-server-goal") || !fixed("--model-backend", "xiaomi-mimo-token-plan") ||
      !fixed("--model", "mimo-v2.6-pro") || !fixed("--access-boundary", slot.lifetime.accessBoundary) ||
      !fixed("--edit-mode", slot.lifetime.accessBoundary === AccessBoundary.ReadOnly ? "read-only" : "allow-edits") ||
      (slot.lifetime.accessBoundary === AccessBoundary.ReadOnly ? args.includes("--provider-sandbox-mode") : !fixed("--provider-sandbox-mode", "workspace-write")) ||
      !fixed("--project-access-scope-json", JSON.stringify({ projectId: slot.jobId, readRoots: [slot.workspacePath],
        ...(slot.lifetime.accessBoundary === AccessBoundary.ReadOnly ? {} : { isolatedWorkspaceRoot: slot.workspacePath }) })) ||
      args.some(arg => /(?:auth\.json|MIMO_TOKEN_PLAN_API_KEY|MIMO_KEY_FILE|--prewarm|--force-start|--hosted-lifecycle)/.test(arg))) invalid();
}

/** Caller flags have no authority: actual retained origin and inventory select
 * the record. This also rejects removing all lifetime flags from a child argv. */
export function assertVerifiedHostedChildConfig(config: CodexGoalRunConfig): void {
  if (!isHostedOrdinaryRuntime()) return;
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence);
    const slot = readHostedChildSlot(origin.creator);
    if (!slot) { if (config.childLifetime) invalid(); return; }
    const actualArgs = process.argv.slice(1);
    const expectedArgs = slot.launch.command === process.execPath ? slot.launch.args : [slot.launch.command, ...slot.launch.args];
    if (JSON.stringify(actualArgs) !== JSON.stringify(expectedArgs)) invalid();
    if (JSON.stringify(config.childLifetime) !== JSON.stringify(slot.lifetime) || config.jobRootDir !== slot.jobRootDir ||
        config.workspacePath !== slot.workspacePath || config.promptPath !== slot.promptPath ||
        (config.jobId ?? config.taskId) !== slot.jobId) invalid();
    new ChildExecutionBudget(slot.lifetime).remainingMs();
  });
}
function invalid(): never { throw new Error("hosted_child_slot_binding_invalid"); }
