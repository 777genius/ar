import { HostedInventoryCategory, type HostedInventoryV5 } from "./host-inventory";

/**
 * Pure wire contract of the INSTALLATION SUCCESSOR of an already-installed V5 host. Parsing supplies DATA, never process
 * ownership or authority: the Host adapter (`hosted-installation-successor.ts`) binds these records to the actual fresh
 * supervisor, the actual predecessor bytes and the activation fence before one fenced activation publication selects them.
 *
 * Why a successor exists. The V5 inventory is create-only and names the birth of the installation supervisor process; the
 * immutable installation embeds that inventory's digest. After the supervisor operation ends no process can ever satisfy the
 * kernel admission against it. The successor is a NEW supervised installation operation that stages versioned, create-once
 * `host-installation.json` and `readonly-inventory.json` copies under `installation-successors/<selection digest>/`, plus a
 * content-addressed selection record, and then ONE fenced activation publication whose optional
 * `installationSelectionSha256` selects exactly that record. The predecessor files are never rewritten or removed.
 *
 * Version contract.
 * - Request (`<id>.request.json`) schemaVersion 3 = schemaVersion 2 (retention) + one closed `successor` pin set; funded
 *   installation packet schemaVersion 4 = schemaVersion 3 + `successor`. A successor is only authorized together with the
 *   one closed retention request; a successor-only operation does not exist.
 * - Funded installation packet versions the consumers accept: `hostedFundedInstallationVersions` (2, 3, 4) and nothing else.
 * - The activation gains the optional key `installationSelectionSha256`. Absent means the original fixed records; it is
 *   emitted only when selecting, so every existing activation keeps its exact bytes.
 */
export const hostedFundedInstallationVersions: readonly number[] = Object.freeze([2, 3, 4]);
export const hostedInstallationSuccessorDirectory = "installation-successors";
export const hostedSelectedRecordNames = Object.freeze(["host-installation.json", "readonly-inventory.json"] as const);
export type HostedSelectedRecordName = typeof hostedSelectedRecordNames[number];

function fail(): never { throw new Error("hosted_installation_successor_invalid"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !pattern.test(value)) fail();
  return value;
}
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const birth = /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/;
function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}

/** What the funded successor request pins: the exact committed predecessor, nothing derived from the new supervisor. */
export type HostedSuccessorRequest = Readonly<{
  installationId: string; installationSha256: string; inventorySha256: string; activationSha256: string; activationGeneration: number;
}>;
export function parseHostedSuccessorRequest(value: unknown): HostedSuccessorRequest {
  const row = object(value, "installationId,installationSha256,inventorySha256,activationSha256,activationGeneration");
  return Object.freeze({ installationId: text(row.installationId, /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/),
    installationSha256: text(row.installationSha256, digest), inventorySha256: text(row.inventorySha256, digest),
    activationSha256: text(row.activationSha256, digest), activationGeneration: generation(row.activationGeneration) });
}

/**
 * The content-addressed selection record (`installation-successors/<its sha256>.json`). `predecessor.selectionSha256` links
 * the chain (null for the original fixed records); `generation` counts successors (the original is generation 0).
 */
export type HostedInstallationSelection = Readonly<{
  schemaVersion: 1; installationId: string; generation: number; operationId: string; bootId: string; supervisorBirth: string;
  predecessor: Readonly<{ selectionSha256: string | null; installationSha256: string; inventorySha256: string; activationSha256: string; activationGeneration: number }>;
  installationSha256: string; inventorySha256: string;
}>;
export function parseHostedInstallationSelection(value: unknown): HostedInstallationSelection {
  const row = object(value, "schemaVersion,installationId,generation,operationId,bootId,supervisorBirth,predecessor,installationSha256,inventorySha256");
  if (row.schemaVersion !== 1) fail();
  const p = object(row.predecessor, "selectionSha256,installationSha256,inventorySha256,activationSha256,activationGeneration");
  return Object.freeze({ schemaVersion: 1, installationId: text(row.installationId, /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/),
    generation: generation(row.generation), operationId: text(row.operationId, uuid), bootId: text(row.bootId, uuid),
    supervisorBirth: text(row.supervisorBirth, birth),
    predecessor: Object.freeze({ selectionSha256: p.selectionSha256 === null ? null : text(p.selectionSha256, digest),
      installationSha256: text(p.installationSha256, digest), inventorySha256: text(p.inventorySha256, digest),
      activationSha256: text(p.activationSha256, digest), activationGeneration: generation(p.activationGeneration) }),
    installationSha256: text(row.installationSha256, digest), inventorySha256: text(row.inventorySha256, digest) });
}
/** Relative names beneath the private Host-policy root; the digest in every name is verified by the reader, never trusted. */
export const hostedSelectionRecordName = (selectionSha256: string) => `${hostedInstallationSuccessorDirectory}/${text(selectionSha256, digest)}.json`;
export const hostedSelectedFileName = (selectionSha256: string, name: HostedSelectedRecordName) =>
  `${hostedInstallationSuccessorDirectory}/${text(selectionSha256, digest)}/${name}`;

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The runtime CLI the creator launch runs; it lives under the artifact's OWN runtime directory, so it is the only argument that may differ. */
export const hostedCreatorCliSuffix = "/dist/worker-codex/codex-goal-cli.js";
/**
 * What a creator launch MEANS, without the parts that legitimately follow the artifact: the cwd and every argument after the
 * runtime CLI path (the tool, its closed `--args-json` payload and `--json`) are compared as they are; the CLI path itself
 * (`args[0]`) must end in `hostedCreatorCliSuffix` but its runtime directory is normalized away; the command is the pinned node
 * of each artifact (verified against its own packet) and is not compared across artifacts.
 */
function launchSemantics(launch: HostedInventoryV5["ordinaryCreators"][number]["launch"]): { cwd: string; args: readonly string[] } {
  const [cli, ...rest] = launch.args;
  if (typeof cli !== "string" || !cli.endsWith(hostedCreatorCliSuffix)) fail();
  return { cwd: launch.cwd, args: rest };
}

/**
 * The census of the candidate (collected by the FRESH supervisor on the live host) must describe the same host as the
 * predecessor, except for the supervisor itself. Active ordinary/hosted units cannot appear (the V5 parser refuses their
 * names as borrowed units); here every other unit, activator and cgroup must be byte-identical (invocation ids and main-pid
 * births included, so nothing restarted), the creator identity (creator, job, roots, child slot, and the launch semantics: cwd
 * and runtime-normalized arguments) and disabled creators are retained, and the old supervisor unit may linger only as a
 * process-less row. A reboot (other boot id) never qualifies. The parser already makes `runtimeLaunch` equal to the creator launch.
 */
export function assertHostedInventorySuccessorCongruent(predecessor: HostedInventoryV5, candidate: HostedInventoryV5): void {
  if (predecessor.hostId !== candidate.hostId || predecessor.bootId !== candidate.bootId) fail();
  const oldSupervisor = predecessor.supervisorUnit, newSupervisor = candidate.supervisorUnit;
  // The old identity is never relabeled: a successor is another unit, another process birth, another operation.
  if (oldSupervisor === newSupervisor || predecessor.supervisor.birth === candidate.supervisor.birth ||
      predecessor.supervisor.operationId === candidate.supervisor.operationId) fail();
  const pc = predecessor.ordinaryCreators[0]!, cc = candidate.ordinaryCreators[0]!;
  if (pc.creatorId !== cc.creatorId || pc.jobId !== cc.jobId || pc.jobRootDir !== cc.jobRootDir || pc.workspacePath !== cc.workspacePath ||
      pc.childSlotSha256 !== cc.childSlotSha256 || !same(predecessor.disabledCreators, candidate.disabledCreators) ||
      !same(launchSemantics(pc.launch), launchSemantics(cc.launch)) || !same(launchSemantics(predecessor.runtimeLaunch), launchSemantics(candidate.runtimeLaunch))) fail();
  const oldRow = predecessor.units.find(u => u.name === oldSupervisor), newRow = candidate.units.find(u => u.name === newSupervisor);
  if (!oldRow || !newRow || newRow.category !== HostedInventoryCategory.Supervisor) fail();
  const keptBefore = predecessor.units.filter(u => u.name !== oldSupervisor);
  const keptAfter = candidate.units.filter(u => u.name !== newSupervisor && !(u.name === oldSupervisor && u.mainPidBirth === null));
  if (keptBefore.length !== keptAfter.length || keptBefore.some(u => !same(u, keptAfter.find(c => c.name === u.name)))) fail();
  const byName = <T extends { readonly name: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));
  if (!same(byName(predecessor.activators), byName(candidate.activators))) fail();
  const skipped = new Set([oldRow.controlGroup, newRow.controlGroup]);
  const groupsBefore = predecessor.cgroups.filter(c => !skipped.has(c.path)), groupsAfter = candidate.cgroups.filter(c => !skipped.has(c.path));
  if (groupsBefore.length !== groupsAfter.length || groupsBefore.some(g => !same(g, groupsAfter.find(c => c.path === g.path)))) fail();
}

/**
 * SUPERVISOR GENERATIONS. After a successor the one installation has several supervisor generations: the original, then every
 * selected successor. Each ordinary start keeps the birth of the supervisor that ADMITTED it (`start.supervisorId`), and its
 * identity attachment keeps that supervisor's work/cleanup windows. A generation is therefore named by the facts of its own
 * inventory and is never relabelled to a later one; the Host proves each generation from the committed selection chain.
 */
export type HostedSupervisorGeneration = Readonly<{ birth: string; operationId: string; bootId: string; workEndEpochMs: number; cleanupEndEpochMs: number }>;
export const hostedSupervisorGeneration = (inventory: HostedInventoryV5): HostedSupervisorGeneration => Object.freeze({
  birth: inventory.supervisor.birth, operationId: inventory.supervisor.operationId, bootId: inventory.bootId,
  workEndEpochMs: inventory.supervisor.workEndEpochMs, cleanupEndEpochMs: inventory.supervisor.cleanupEndEpochMs });
/** Proven generations by process birth. Two generations never share a birth or an operation: that would be a relabelled supervisor. */
export function hostedSupervisorGenerationMap(generations: readonly HostedSupervisorGeneration[]): ReadonlyMap<string, HostedSupervisorGeneration> {
  const byBirth = new Map(generations.map(g => [g.birth, g] as const));
  if (byBirth.size !== generations.length || new Set(generations.map(g => g.operationId)).size !== generations.length) fail();
  return byBirth;
}

export type HostedOrdinaryStartAdmission = Readonly<{
  /** Every generation proven for this installation (the committed selected world and its predecessors). */
  generations: ReadonlyMap<string, HostedSupervisorGeneration>;
  /** The generation whose supervisor the COMMITTED activation names. */
  subject: HostedSupervisorGeneration;
  /** The inventory under census is a not-yet-selected candidate: the committed activation is a predecessor view, no start may be active. */
  candidateCensus: boolean;
  /** Boot of the inventory under census; a start of another boot is never history of this world. */
  bootId: string;
  activationGeneration: number;
  terminal: boolean;
  /** The activation row's generation and the start record, as read (untrusted). */
  rowGeneration: unknown; start: Readonly<{ supervisorId: unknown; bootId: unknown; activationGeneration: unknown }>;
}>;
/**
 * The generation that ADMITTED one ordinary start, validated against its own origin and never against the candidate:
 * - an unknown admitting birth (not in the proven chain), another boot, or an activation row / start record that disagree on the
 *   reservation generation refuse (mixed or unknown history);
 * - an ACTIVE start belongs to the generation the committed activation names and nowhere else, and never exists in a candidate
 *   census (a successor needs every start terminal);
 * - a TERMINAL start keeps its own admitting generation, so the later supervisor never adopts the birth of an earlier one.
 */
export function admittingSupervisorGeneration(input: HostedOrdinaryStartAdmission): HostedSupervisorGeneration {
  const born = typeof input.start.supervisorId === "string" ? input.generations.get(input.start.supervisorId) : undefined;
  if (!born || born.bootId !== input.bootId || input.start.bootId !== born.bootId) fail();
  if (!Number.isSafeInteger(input.rowGeneration) || input.start.activationGeneration !== input.rowGeneration ||
      (input.rowGeneration as number) < 1 || (input.rowGeneration as number) > input.activationGeneration) fail();
  if (!input.terminal && (input.candidateCensus || born.birth !== input.subject.birth)) fail();
  return born;
}
