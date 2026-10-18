import { createHash } from "node:crypto";
import { decodeHostedActivationBytes, readHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { parseHostedInstallation, type HostedActivation } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import {
  assertHostedInventorySuccessorCongruent, hostedSelectedFileName, hostedSelectionRecordName, parseHostedInstallationSelection,
  type HostedInstallationSelection,
} from "../core/host-infrastructure/host-installation-successor";

/**
 * Structural re-validation of an installation-selection transition. `HostedInstallationActivationStore.publish` calls it for
 * EVERY activation publication, so the first publication and the recovery of a retained `host-activation.next` pass through
 * the same check (recovery finishes only the retained immediate successor after this revalidation, never a fresh attempt).
 * It reads the COMMITTED predecessor world (the activation still names the prior selection while it runs) and the immutable
 * successor records; it cannot observe the live host - that was done by the fresh supervisor before the records existed.
 */
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refuse(reason: string): never { throw new Error(`hosted_installation_selection_invalid:${reason}`); }

function selectionRecord(selection: string): HostedInstallationSelection {
  const bytes = readHostedActivationBytes(hostedSelectionRecordName(selection));
  if (!bytes || sha(bytes) !== selection) refuse("selection_record");
  return parseHostedInstallationSelection(decodeHostedActivationBytes(bytes));
}
export function assertInstallationSelectionTransition(prior: HostedActivation, next: HostedActivation): void {
  if (prior.installationSelectionSha256 === next.installationSelectionSha256) return;
  const selection = next.installationSelectionSha256;
  if (!selection) refuse("selection_removed");
  const record = selectionRecord(selection);
  // Chain: the very first successor links the original fixed records (generation 1, no selection); later ones link the prior.
  const priorGeneration = prior.installationSelectionSha256 ? selectionRecord(prior.installationSelectionSha256).generation : 0;
  if (record.generation !== priorGeneration + 1 || record.predecessor.selectionSha256 !== (prior.installationSelectionSha256 ?? null)) refuse("chain");
  if (record.installationId !== prior.installationId || next.installationId !== prior.installationId) refuse("installation_id");
  if (next.bootId !== record.bootId || next.supervisorId !== record.supervisorBirth) refuse("session");
  // The predecessor world, exactly as the prior committed activation resolves it right now.
  const activationBytes = readHostedActivationBytes("host-activation.json"), installationBytes = readHostedActivationBytes("host-installation.json"),
    inventoryBytes = readHostedActivationBytes("readonly-inventory.json");
  if (!activationBytes || !installationBytes || !inventoryBytes) refuse("predecessor_missing");
  if (record.predecessor.activationGeneration !== prior.generation || record.predecessor.activationSha256 !== sha(activationBytes) ||
      record.predecessor.installationSha256 !== sha(installationBytes) || record.predecessor.inventorySha256 !== sha(inventoryBytes)) refuse("predecessor_pins");
  // The immutable successor records.
  const newInstallationBytes = readHostedActivationBytes(hostedSelectedFileName(selection, "host-installation.json"));
  const newInventoryBytes = readHostedActivationBytes(hostedSelectedFileName(selection, "readonly-inventory.json"));
  if (!newInstallationBytes || !newInventoryBytes || sha(newInstallationBytes) !== record.installationSha256 || sha(newInventoryBytes) !== record.inventorySha256) refuse("successor_files");
  const installation = parseHostedInstallation(decodeHostedActivationBytes(newInstallationBytes));
  const old = parseHostedInstallation(decodeHostedActivationBytes(installationBytes));
  if (installation.installationId !== old.installationId || installation.hostId !== old.hostId || installation.inventorySha256 !== record.inventorySha256) refuse("installation_record");
  const candidate = parseHostedInventoryV5(decodeHostedActivationBytes(newInventoryBytes)), predecessor = parseHostedInventoryV5(decodeHostedActivationBytes(inventoryBytes));
  if (candidate.hostId !== installation.hostId || candidate.bootId !== record.bootId || candidate.supervisor.birth !== record.supervisorBirth ||
      candidate.supervisor.operationId !== record.operationId) refuse("inventory_identity");
  try { assertHostedInventorySuccessorCongruent(predecessor, candidate); } catch { refuse("census_congruence"); }
}
