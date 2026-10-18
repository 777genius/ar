import { createHash } from "node:crypto";
import { join } from "node:path";
import { decodeHostedActivationBytes, readHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase, HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { decodeHostedInventoryBytes, hostedInventoryMaximumBytes, parseHostedInventoryV5, type HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import {
  hostedSelectedFileName, hostedSelectionRecordName, hostedSupervisorGeneration, hostedSupervisorGenerationMap, parseHostedInstallationSelection,
  type HostedInstallationSelection, type HostedSuccessorRequest, type HostedSupervisorGeneration,
} from "../core/host-infrastructure/host-installation-successor";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

/**
 * The COMMITTED activation as the exclusive census must read it, with explicit supervisor-generation semantics.
 *
 * - SELECTED census (no `successor`): the inventory under census is the one the committed activation selects, and the activation
 *   names ITS supervisor. Terminal history admitted by an earlier generation of the same installation is proven from the
 *   committed selection chain and keeps that generation; it is never relabelled to the current supervisor.
 * - CANDIDATE census (`successor` = the funded predecessor pins): the inventory under census is a fresh supervisor's census that
 *   NO activation selects yet. The committed activation is authenticated, by the pinned bytes and generation, as the PREDECESSOR
 *   view: it must be exactly the pinned CLOSED activation naming the predecessor supervisor, with every start terminal. The
 *   candidate's own birth must be a new one. Nothing is published, selected or rewritten here; candidate activation is not
 *   pretended to exist.
 *
 * Every chain record, inventory and activation byte is read through the existing private readers and digest-verified; a missing,
 * foreign, stale or mixed reference refuses. The only reader of the ORIGINAL fixed inventory is the same private reader the
 * Host already uses for fixed records.
 */
export type OrdinaryCensusHistory = Readonly<{
  activation: Readonly<Record<string, unknown>>;
  subject: HostedSupervisorGeneration;
  generations: ReadonlyMap<string, HostedSupervisorGeneration>;
  candidateCensus: boolean;
}>;

/** Successor chains are short (one record per funded successor operation); a longer one is not a chain this Host created. */
export const maximumSelectionChainDepth = 64;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[a-f0-9]{64}$/;
function refuse(reason: string): never { throw new Error(`hosted_ordinary_history_refused:${reason}`); }
const required = (name: string) => readHostedActivationBytes(name) ?? refuse(`missing:${name}`);
const inventoryOf = (bytes: Uint8Array) => parseHostedInventoryV5(decodeHostedInventoryBytes(bytes));

function selectionRecord(selectionSha256: string): HostedInstallationSelection {
  const bytes = required(hostedSelectionRecordName(selectionSha256));
  if (sha(bytes) !== selectionSha256) refuse("selection_record");
  return parseHostedInstallationSelection(decodeHostedActivationBytes(bytes));
}

/** The generations of the selected world, newest first: the selected inventory, then every predecessor down to the original record. */
function selectedGenerations(activation: Readonly<Record<string, unknown>>, selected: HostedInventoryV5): HostedSupervisorGeneration[] {
  const chain = [hostedSupervisorGeneration(selected)], head = activation.installationSelectionSha256;
  if (head === undefined) return chain; // the original fixed records: one generation
  if (typeof head !== "string" || !digest.test(head)) refuse("selection_digest");
  let record = selectionRecord(head), world = selected;
  for (let depth = 0; depth < maximumSelectionChainDepth; depth++) {
    if (record.installationId !== activation.installationId || record.supervisorBirth !== world.supervisor.birth ||
        record.operationId !== world.supervisor.operationId || record.bootId !== world.bootId) refuse("selection_world");
    const link = record.predecessor;
    const previousBytes = link.selectionSha256 === null ? readHostedPrivateBytes(join(readonlySupervisorRoot, "readonly-inventory.json"), hostedInventoryMaximumBytes)
      : readHostedActivationBytes(hostedSelectedFileName(link.selectionSha256, "readonly-inventory.json"));
    if (!previousBytes || sha(previousBytes) !== link.inventorySha256) refuse("selection_predecessor_inventory");
    const previous = inventoryOf(previousBytes);
    if (previous.hostId !== world.hostId) refuse("selection_predecessor_host");
    chain.push(hostedSupervisorGeneration(previous));
    if (link.selectionSha256 === null) { if (record.generation !== 1) refuse("selection_chain"); return chain; }
    const earlier = selectionRecord(link.selectionSha256);
    if (earlier.generation + 1 !== record.generation || earlier.inventorySha256 !== link.inventorySha256) refuse("selection_chain");
    record = earlier; world = previous;
  }
  return refuse("selection_chain_depth");
}

/** The committed activation must be EXACTLY the pinned predecessor: pins, closed phase, the predecessor's supervisor, no live start. */
function assertPinnedPredecessor(activationBytes: Buffer, activation: Readonly<Record<string, unknown>>, selected: HostedInventoryV5,
  pins: HostedSuccessorRequest, candidate: HostedInventoryV5): void {
  const installationBytes = required("host-installation.json"), inventoryBytes = required("readonly-inventory.json");
  if (activation.installationId !== pins.installationId || sha(activationBytes) !== pins.activationSha256 || activation.generation !== pins.activationGeneration ||
      sha(installationBytes) !== pins.installationSha256 || sha(inventoryBytes) !== pins.inventorySha256) refuse("stale_predecessor");
  const installation = decodeHostedActivationBytes(installationBytes) as Record<string, unknown> | null;
  if (!installation || installation.installationId !== pins.installationId || installation.inventorySha256 !== pins.inventorySha256) refuse("predecessor_installation");
  if (activation.phase !== HostedActivationPhase.Closed) refuse("predecessor_not_closed");
  if ((activation.ordinaryStarts as readonly Record<string, unknown>[]).some(row => row.state !== HostedCustodyReservationState.Terminal)) refuse("predecessor_active_start");
  if (selected.hostId !== candidate.hostId || selected.bootId !== candidate.bootId || activation.supervisorId !== selected.supervisor.birth) refuse("predecessor_session");
}

export function resolveOrdinaryCensusHistory(inventory: HostedInventoryV5, successor?: HostedSuccessorRequest): OrdinaryCensusHistory | null {
  const activationBytes = readHostedActivationBytes("host-activation.json");
  if (!activationBytes) return successor ? refuse("missing:host-activation.json") : null;
  const activation = decodeHostedActivationBytes(activationBytes) as Record<string, unknown> | null;
  if (!activation || typeof activation !== "object" || activation.hostId !== inventory.hostId || activation.bootId !== inventory.bootId ||
      !Array.isArray(activation.ordinaryStarts) || activation.ordinaryStarts.length > 256 || !Number.isSafeInteger(activation.generation)) refuse("activation_session");
  // The world the committed activation selects. A selected census must be exactly that world; a candidate census is not.
  const selected = inventoryOf(required("readonly-inventory.json"));
  if (successor) assertPinnedPredecessor(activationBytes, activation, selected, successor, inventory);
  else if (selected.supervisor.birth !== inventory.supervisor.birth || selected.supervisor.operationId !== inventory.supervisor.operationId ||
      selected.bootId !== inventory.bootId || selected.hostId !== inventory.hostId) refuse("selected_world");
  const chain = selectedGenerations(activation, selected), generations = hostedSupervisorGenerationMap(chain), subject = chain[0]!;
  if (activation.supervisorId !== subject.birth) refuse("activation_supervisor");
  // A candidate is a NEW supervisor generation: never a relabelled earlier one.
  if (successor && (generations.has(inventory.supervisor.birth) || chain.some(g => g.operationId === inventory.supervisor.operationId))) refuse("candidate_relabelled");
  return Object.freeze({ activation, subject, generations, candidateCensus: !!successor });
}
