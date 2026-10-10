import { decodeHostedInventoryBytes, hostedInventoryMaximumBytes } from "../core/host-infrastructure/host-inventory";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostedInstallation, HostedActivation } from "@vioxen/subscription-runtime/worker-core";
import { decodeHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
function digest(bytes:Buffer):string {return createHash("sha256").update(bytes).digest("hex");}
function invalid():never {throw new Error("hosted_activation_evidence_invalid");}
// Fixed physical/read-only installation facts. No store, origin map, child,
// callback or publication authority is created or registered by this module.
export function inspectedInstallation(): Omit<HostedInstallation, "schemaVersion" | "installationId"> {
  const inventory = readHostedReadonlyHostInventory();
  if (inventory.schemaVersion !== 2 && inventory.schemaVersion !== 3 && inventory.schemaVersion !== 4 && inventory.schemaVersion !== 5) invalid();
  const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const cliPath = join(runtimeDirectory, "dist/worker-codex/codex-goal-cli.js");
  for (const creator of inventory.ordinaryCreators) {
    const launch = creator.launch;
    if (launch.cwd !== creator.workspacePath || !(launch.command === cliPath ||
        (launch.command === process.execPath && launch.args[0] === cliPath))) invalid();
  }
  const stagePath = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + digest(Buffer.from(runtimeDirectory)) + ".json";
  const stageBytes = readHostedPrivateBytes(stagePath, 4096);
  if (!stageBytes) throw new Error("hosted_readonly_verified_stage_required");
  const stage = decodeHostedActivationBytes(stageBytes);
  if (!stage || typeof stage !== "object" || Array.isArray(stage) ||
      Object.keys(stage).sort().join(",") !== "runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion" ||
      !("schemaVersion" in stage) || stage.schemaVersion !== 1 || !("runtimeDirectory" in stage) || stage.runtimeDirectory !== runtimeDirectory ||
      !("runtimeSha" in stage) || typeof stage.runtimeSha !== "string" || !("runtimeManifestSha256" in stage) || typeof stage.runtimeManifestSha256 !== "string") invalid();
  const inventoryBytes = readHostedPrivateBytes(join(readonlySupervisorRoot, "readonly-inventory.json"), hostedInventoryMaximumBytes);
  if (!inventoryBytes) invalid();
  decodeHostedInventoryBytes(inventoryBytes);
  return { hostId: inventory.hostId, runtimeDirectory, runtimeSha: stage.runtimeSha,
    runtimeManifestSha256: stage.runtimeManifestSha256, inventorySha256: digest(inventoryBytes) };
}
export function assertInspectedInstallation(installation: HostedInstallation): void {
  const binding = inspectedInstallation();
  if (Object.keys(binding).some(key => installation[key as keyof typeof binding] !== binding[key as keyof typeof binding])) invalid();
}
export function assertActivationSession(activation: HostedActivation, session: { hostId: string; bootId: string; supervisorId: string }): void {
  if (activation.hostId !== session.hostId || activation.bootId !== session.bootId || activation.supervisorId !== session.supervisorId) invalid();
}
