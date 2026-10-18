import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase, HostedCustodyReservationState, parseHostedInstallation, type HostedActivation } from "@vioxen/subscription-runtime/worker-core";
import { decodeHostedInventoryBytes, parseHostedInventoryV5, type HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import {
  assertHostedInventorySuccessorCongruent, hostedInstallationSuccessorDirectory, hostedSelectionRecordName, parseHostedInstallationSelection,
  type HostedInstallationSelection, type HostedSuccessorRequest,
} from "../core/host-infrastructure/host-installation-successor";
import { assertInspectedInstallation, readHostedInstallationActivation, type HostedInstallationActivationStore } from "./hosted-installation-activation";
import { HostedReadonlyHostKernel, parseHostedInventoryRecord } from "./hosted-readonly-host-kernel";
import { createReadonlyPrivateRecordOnce, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { collectBootId } from "./hosted-readonly-linux-collector";

/**
 * INSTALLATION SUCCESSOR of an already-installed V5 host, run INSIDE the fresh installation supervisor of a funded
 * schemaVersion-4 operation (see `hosted-ordinary-installation-bootstrap.ts`). It is the only place the selection of another
 * installation/inventory generation is created, and it runs once the existing owned-operation proofs already hold: the outside
 * issuer bound this supervisor's unit, invocation, cgroup, argv, executable and process birth (`original-supervisor.json`),
 * and the supervisor re-proved its own MainPID/cgroup/argv/executable/descriptors before collecting the candidate census.
 *
 * Transaction (all under the common activation fence, nothing is rewritten, nothing is removed):
 *  1. admit the fresh supervisor against its OWN candidate census (`new HostedReadonlyHostKernel(candidate).operatorSession()`:
 *     live cgroup membership, unit MainPID and birth) and require the outside issuer's independent record to agree;
 *  2. re-read the COMMITTED predecessor (selected installation, inventory and activation bytes) and require the funded pins:
 *     installation id, the three digests and the activation generation, a CLOSED activation, every start terminal, the same
 *     boot, no pending publication (the reader refuses it), and a census congruent to the predecessor except for the supervisor;
 *  3. the complete CANDIDATE exclusive physical census, under the same held fence and BEFORE anything is staged or selected
 *     (a10 F2): `new HostedReadonlyHostKernel(candidate, request).verifyExclusiveInventory(fence)`. The two generations are named
 *     separately (`hosted-ordinary-installation-history.ts`): the committed activation is authenticated again, by the pinned bytes
 *     and generation, as the PREDECESSOR view (CLOSED, naming the predecessor supervisor, every start terminal); the candidate
 *     is the fresh supervisor admitted in 1 with its own birth, unit, invocation and windows. Terminal predecessor history keeps
 *     the generation that admitted it; an active or unknown start, a mixed reference, a relabelled candidate birth, an unexpected
 *     reserved group or a changing host refuses here, with nothing written;
 *  4. stage the versioned successor records create-once (inventory, installation, then the content-addressed selection record
 *     LAST); until step 5 they are inert files that no reader selects;
 *  5. publish ONE activation successor selecting that record (same installation id, origins, enrollment; new boot session). The
 *     publish path re-validates the selection transition (`hosted-installation-selection-transition.ts`), also on recovery, which
 *     is the predecessor CAS that still holds at the moment of the publication;
 *  6. re-read through the normal readers (selected installation re-inspected against the staged runtime and the selected
 *     inventory) and run the normal exclusive-inventory verification against the NEW selected world (now the activation names
 *     the candidate, and the terminal predecessor history is proven from the committed selection chain).
 *
 * Partial states. Failure before 5: staged files remain as evidence and nothing selects them; a new funded operation (new
 * operation id, so a new selection digest) is required - there is no blind retry of this one. A crash inside 5 leaves the
 * retained `host-activation.next`, finished only by the existing `recoverSerialized` after the same revalidation. Failure in 6
 * (the host drifted after the publication) leaves the selection committed and CLOSED; there is no automatic rollback (the dead
 * predecessor supervisor cannot be re-admitted anyway) - a later reviewed successor operation supersedes it, and the predecessor
 * records stay intact. The 3 census makes that window the time between 3 and 5 under the held fence, not the whole operation.
 */
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function refuse(reason: string): never { throw new Error(`hosted_installation_successor_held:${reason}`); }
const required = (name: string) => readHostedActivationBytes(name) ?? refuse(`missing:${name}`);

/** The facts the outside issuer recorded about the supervisor it launched (`original-supervisor.json`). */
export type OutsideSupervisorRecord = Readonly<{ operationId: string; unit: string; bootId: string; birth: string; invocationId: string; controlGroup: string }>;
export type InstallationSuccessorInput = Readonly<{
  store: HostedInstallationActivationStore; operationId: string; request: HostedSuccessorRequest; candidateBytes: Buffer;
  runtime: Readonly<{ runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string }>; outside: OutsideSupervisorRecord;
}>;

function assertStagedRuntime(runtime: InstallationSuccessorInput["runtime"]): void {
  if (runtime.runtimeDirectory !== fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "")) refuse("runtime_directory");
  const stage = readHostedPrivateBytes("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + sha(Buffer.from(runtime.runtimeDirectory)) + ".json", 4096);
  const value = stage ? decodeHostedActivationBytes(stage) as Record<string, unknown> : null;
  if (!value || Object.keys(value).sort().join(",") !== "runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion" || value.schemaVersion !== 1 ||
      value.runtimeDirectory !== runtime.runtimeDirectory || value.runtimeSha !== runtime.runtimeSha || value.runtimeManifestSha256 !== runtime.runtimeManifestSha256) refuse("runtime_stage");
}

export function commitInstallationSuccessor(input: InstallationSuccessorInput): HostedActivation {
  assertHostedActivationOperator();
  const candidate: HostedInventoryV5 = parseHostedInventoryV5(decodeHostedInventoryBytes(input.candidateBytes));
  const kernel = new HostedReadonlyHostKernel(parseHostedInventoryRecord(input.candidateBytes), input.request);
  // (1) admission of the fresh supervisor + the outside issuer's independent record of it.
  const session = kernel.operatorSession();
  const supervisorRow = candidate.units.find(u => u.name === candidate.supervisorUnit)!;
  const o = input.outside;
  if (candidate.supervisor.operationId !== input.operationId || o.operationId !== input.operationId || o.unit !== candidate.supervisorUnit ||
      o.birth !== candidate.supervisor.birth || o.birth !== session.supervisorId || o.bootId !== candidate.bootId || o.controlGroup !== supervisorRow.controlGroup ||
      o.invocationId !== supervisorRow.invocationId) refuse("outside_supervisor_record");
  if (collectBootId() !== candidate.bootId || readFileSync("/etc/machine-id", "utf8").trim() !== candidate.hostId) refuse("boot_or_machine");
  assertStagedRuntime(input.runtime);
  return input.store.serialized(fence => {
    // (2) the committed predecessor, exactly as pinned by the funded request.
    const { installation, activation } = readHostedInstallationActivation();
    const activationBytes = required("host-activation.json"), installationBytes = required("host-installation.json"), inventoryBytes = required("readonly-inventory.json");
    const pins = input.request;
    if (installation.installationId !== pins.installationId || sha(installationBytes) !== pins.installationSha256 || sha(inventoryBytes) !== pins.inventorySha256 ||
        sha(activationBytes) !== pins.activationSha256 || activation.generation !== pins.activationGeneration) refuse("predecessor_pins");
    if (activation.phase !== HostedActivationPhase.Closed || activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal)) refuse("predecessor_not_closed");
    if (activation.bootId !== candidate.bootId || activation.hostId !== candidate.hostId || installation.hostId !== candidate.hostId) refuse("predecessor_session");
    const predecessor = parseHostedInventoryV5(decodeHostedInventoryBytes(inventoryBytes));
    assertHostedInventorySuccessorCongruent(predecessor, candidate);
    // (3) the candidate's complete exclusive census under THIS fence, before anything is staged or selected (a10 F2). The census
    // authenticates the committed activation as the pinned predecessor itself; it does not rely on the checks above.
    kernel.verifyExclusiveInventory(fence);
    // (4) stage the versioned records, the content-addressed selection LAST.
    const successorInstallation = parseHostedInstallation({ schemaVersion: 1, installationId: installation.installationId, hostId: installation.hostId,
      runtimeDirectory: input.runtime.runtimeDirectory, runtimeSha: input.runtime.runtimeSha, runtimeManifestSha256: input.runtime.runtimeManifestSha256,
      inventorySha256: sha(input.candidateBytes) });
    const installationRecord = encoded(successorInstallation);
    const priorGeneration = activation.installationSelectionSha256
      ? parseHostedInstallationSelection(decodeHostedActivationBytes(required(hostedSelectionRecordName(activation.installationSelectionSha256)))).generation : 0;
    const selection: HostedInstallationSelection = { schemaVersion: 1, installationId: installation.installationId, generation: priorGeneration + 1,
      operationId: input.operationId, bootId: candidate.bootId, supervisorBirth: candidate.supervisor.birth,
      predecessor: { selectionSha256: activation.installationSelectionSha256 ?? null, installationSha256: pins.installationSha256,
        inventorySha256: pins.inventorySha256, activationSha256: pins.activationSha256, activationGeneration: pins.activationGeneration },
      installationSha256: sha(installationRecord), inventorySha256: sha(input.candidateBytes) };
    const selectionBytes = encoded(parseHostedInstallationSelection(selection)), selectionSha256 = sha(selectionBytes);
    const base = join(readonlySupervisorRoot, hostedInstallationSuccessorDirectory);
    try { mkdirSync(base, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    mkdirSync(join(base, selectionSha256), { mode: 0o700 }); // a consumed selection digest refuses; it is never reused
    createReadonlyPrivateRecordOnce(join(base, selectionSha256, "readonly-inventory.json"), input.candidateBytes);
    createReadonlyPrivateRecordOnce(join(base, selectionSha256, "host-installation.json"), installationRecord);
    createReadonlyPrivateRecordOnce(join(base, `${selectionSha256}.json`), selectionBytes);
    // (5) ONE fenced activation publication; `publish` re-validates the selection transition.
    input.store.publish(fence, { ...activation, generation: activation.generation + 1, bootId: candidate.bootId, supervisorId: session.supervisorId,
      installationSelectionSha256: selectionSha256 });
    // (6) the NEW selected world through the normal readers and the normal exclusive-inventory verification.
    const after = readHostedInstallationActivation();
    if (after.activation.installationSelectionSha256 !== selectionSha256 || after.installation.inventorySha256 !== selection.inventorySha256) refuse("selected_world");
    assertInspectedInstallation(after.installation);
    const selected = new HostedReadonlyHostKernel();
    selected.verifyExclusiveInventory(fence); selected.verifyDescriptorBoundary();
    return after.activation;
  });
}
