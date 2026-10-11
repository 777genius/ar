import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { HostedInventoryCategory, parseHostedOrdinaryOwnedIdentity, parseHostedInventoryV5, type HostedInventoryV5, type HostedInventoryUnit, type HostedInventoryCgroup, type HostedInventoryActivator } from "../core/host-infrastructure/host-inventory";
import { assertHostedActivationFence, readHostedActivationBytes, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { admittingSupervisorGeneration, type HostedSuccessorRequest } from "../core/host-infrastructure/host-installation-successor";
import { resolveOrdinaryCensusHistory } from "./hosted-ordinary-installation-history";
import { collectBootId, collectCgroupProcesses, collectProcessBirth, collectProcessCgroup } from "./hosted-readonly-linux-collector";
import { ordinaryInstallationSupervisorMembers } from "./hosted-ordinary-installation-owned";
import { readTrustedFragment } from "./hosted-readonly-host-kernel";
import { ordinaryInstallationRemainingMs } from "./trusted-custody-systemd-launch";

type CollectorFailure = Readonly<{ args: readonly string[]; status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
const failures = new WeakMap<object, CollectorFailure>();
export function ordinaryInstallationCollectorFailure(error: unknown): CollectorFailure | undefined {
  return error && typeof error === "object" ? failures.get(error) : undefined;
}
const commonProperties = "Id,Names,FragmentPath,DropInPaths,LoadState,ActiveState,UnitFileState,InvocationID,Job,Triggers";
function propertiesFor(name: string): string {
  if (name.endsWith(".service")) return commonProperties + ",ControlGroup,MainPID,Delegate";
  if (name.endsWith(".scope")) return commonProperties + ",ControlGroup,Delegate";
  if (name.endsWith(".socket")) return commonProperties + ",ControlGroup,Delegate";
  if (/\.(timer|target)$/.test(name)) return commonProperties;
  denied();
}
function denied(): never { throw new Error("hosted_ordinary_inventory_unresolved"); }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const lines = (text: string) => text.split("\n").filter(Boolean);
function remaining(inventory: Pick<HostedInventoryV5, "supervisor">, cleanup = false): number {
  return ordinaryInstallationRemainingMs(inventory.supervisor, cleanup);
}
function joined(args: readonly string[], inventory: Pick<HostedInventoryV5, "supervisor">, cleanup = false): string {
  const receipt = spawnSync("/usr/bin/systemctl", args, { encoding: "utf8", timeout: Math.min(5000, remaining(inventory, cleanup)),
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
  if (receipt.error || receipt.status !== 0 || receipt.signal !== null) {
    const error = new Error("hosted_ordinary_collector_failed", { cause: receipt.error });
    // Retain actual bounded diagnostics; never include ExecStart or environment.
    failures.set(error, Object.freeze({ args: [...args], status: receipt.status, signal: receipt.signal, stdout: receipt.stdout, stderr: receipt.stderr }));
    throw error;
  }
  remaining(inventory, cleanup); return receipt.stdout;
}
function names(text: string): string[] { return text ? text.split(" ").filter(Boolean) : []; }
function show(name: string, inventory: Pick<HostedInventoryV5, "supervisor">, cleanup = false): Record<string, string> {
  const result: Record<string, string> = {}, properties = propertiesFor(name);
  for (const line of lines(joined(["show", `--property=${properties}`, "--", name], inventory, cleanup))) {
    const at = line.indexOf("="); if (at < 1 || line.slice(0, at) in result) denied();
    result[line.slice(0, at)] = line.slice(at + 1);
  }
  if (Object.keys(result).sort().join(",") !== properties.split(",").sort().join(",") || result.Id !== name || result.Job !== "") denied();
  return result;
}
function config(row: Record<string, string>) {
  const absent = row.Id!.endsWith(".scope") && row.FragmentPath === "";
  if (!absent && !row.FragmentPath) denied();
  const dropIns = names(row.DropInPaths!).map(path => ({ path, sha256: hash(readTrustedFragment(path)) }));
  return { fragmentPath: absent ? null : row.FragmentPath!, fragmentSha256: absent ? null : hash(readTrustedFragment(row.FragmentPath!)), dropIns,
    loadState: row.LoadState!, activeState: row.ActiveState!, unitFileState: row.UnitFileState!, invocationId: row.InvocationID!, job: row.Job! };
}
export type OrdinaryInventoryDraftInput = Omit<HostedInventoryV5, "units" | "cgroups" | "activators" | "schemaVersion" | "hostId" | "bootId">;
function managerSnapshot(inventory: Pick<HostedInventoryV5, "supervisor">, cleanup = false) {
  const units = joined(["list-units", "--all", "--type=service,scope,socket,timer,target", "--no-legend", "--plain", "--no-pager"], inventory, cleanup);
  const enabled = joined(["list-unit-files", "--type=service,socket,timer,target", "--state=enabled,enabled-runtime,linked,linked-runtime,alias", "--no-legend", "--no-pager"], inventory, cleanup);
  const jobs = joined(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"], inventory, cleanup);
  return { units, enabled, jobs };
}
/** Fixed synchronous collectors are joined before walking members. A later
 * collection can compare a cohort, but cannot adopt a changed published one. */
export function collectOrdinaryInstallationDraft(input: OrdinaryInventoryDraftInput): HostedInventoryV5 {
  const before = managerSnapshot(input), unitNames = [...new Set(lines(before.units).map(l => l.trim().split(/\s+/)[0]!))].sort();
  if (unitNames.length > 1536) denied();
  const units: HostedInventoryUnit[] = [], activators: HostedInventoryActivator[] = [];
  for (const name of unitNames) {
    const row = show(name, input), configuration = config(row), aliases = names(row.Names!).filter(n => n !== name);
    if (/\.(service|scope)$/.test(name)) {
      if (!["no", "false"].includes(row.Delegate!)) denied();
      if (!row.ControlGroup) {
        // A quiescent row still needs its associated group; absence is not proof.
        denied();
      }
      units.push({ category: name === input.supervisorUnit ? HostedInventoryCategory.Supervisor : HostedInventoryCategory.Borrowed,
        name, aliases, controlGroup: row.ControlGroup, ...configuration, mainPidBirth: name.endsWith(".scope") || row.MainPID === "0" ? null : collectProcessBirth(row.MainPID!), delegate: false });
    } else {
      const socket = name.endsWith(".socket");
      if (socket && !["no", "false"].includes(row.Delegate!)) denied();
      activators.push({ name, aliases, targets: names(row.Triggers!), controlGroup: socket ? row.ControlGroup! : null,
        delegate: socket ? false : null, ...configuration, fragmentPath: configuration.fragmentPath!, fragmentSha256: configuration.fragmentSha256! });
    }
  }
  // All helpers above have positively returned. No collector PID is exempted.
  const cgroups = walkGroups(units, input);
  const after = managerSnapshot(input);
  if (JSON.stringify(before) !== JSON.stringify(after)) denied();
  for (const row of [...units, ...activators]) {
    const current = show(row.name, input);
    if (JSON.stringify(config(current)) !== JSON.stringify({ fragmentPath: row.fragmentPath, fragmentSha256: row.fragmentSha256, dropIns: row.dropIns,
        loadState: row.loadState, activeState: row.activeState, unitFileState: row.unitFileState, invocationId: row.invocationId, job: row.job }) ||
        JSON.stringify(names(current.Names!).filter(n => n !== row.name)) !== JSON.stringify(row.aliases) ||
        "targets" in row && (JSON.stringify(names(current.Triggers!)) !== JSON.stringify(row.targets) ||
          (row.name.endsWith(".socket") ? current.ControlGroup !== row.controlGroup || !["no", "false"].includes(current.Delegate!) : row.controlGroup !== null || row.delegate !== null)) ||
        "mainPidBirth" in row && (!["no", "false"].includes(current.Delegate!) || current.ControlGroup !== row.controlGroup || (row.name.endsWith(".scope") || current.MainPID === "0" ? null : collectProcessBirth(current.MainPID!)) !== row.mainPidBirth)) denied();
  }
  const inventory = parseHostedInventoryV5({ ...input, schemaVersion: 5, hostId: readFileSync("/etc/machine-id", "utf8").trim(), bootId: collectBootId(), units, cgroups, activators });
  const supervisorGroup = units.find(u => u.name === input.supervisorUnit)!.controlGroup;
  const members = cgroups.find(c => c.path === supervisorGroup)!.members.map(m => m.birth);
  if (JSON.stringify(members) !== JSON.stringify([input.supervisor.birth])) denied();
  return inventory;
}
function walkGroups(units: readonly HostedInventoryUnit[], inventory: Pick<HostedInventoryV5, "supervisor">, cleanup = false): HostedInventoryCgroup[] {
  const groups: HostedInventoryCgroup[] = [];
  const walk = (path: string, parent: string | null): void => {
    remaining(inventory, cleanup); if (groups.length >= 4096) denied();
    const absolute = `/sys/fs/cgroup${path}`, before = lstatSync(absolute), fd = openSync(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); if (!opened.isDirectory() || opened.uid !== 0 || opened.dev !== before.dev || opened.ino !== before.ino) denied();
      const owner = units.find(u => u.controlGroup === path);
      const members = lines(collectCgroupProcesses(path)).map(pid => {
        const birth = collectProcessBirth(pid); if (collectProcessCgroup(pid) !== `0::${path}`) denied(); return { birth, controlGroup: path };
      }).sort((a, b) => Number(a.birth.split(":")[0]) - Number(b.birth.split(":")[0]));
      if (members.length && !owner) denied();
      groups.push({ path, parent, ownerUnit: owner?.name ?? null, dev: String(opened.dev), ino: String(opened.ino), members });
      for (const child of readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true })) if (child.isDirectory()) walk(`${path}/${child.name}`, path);
      const after = fstatSync(fd), current = lstatSync(absolute);
      if (opened.dev !== after.dev || opened.ino !== after.ino || current.dev !== opened.dev || current.ino !== opened.ino) denied();
    } finally { closeSync(fd); }
  };
  walk("", null); return groups;
}
/** Protected Store rows select exact owned groups. An attachment never creates
 * a reservation. Unbound rows are allowed only while physically not submitted.
 * Generation semantics are explicit (`hosted-ordinary-installation-history.ts`): an ACTIVE start belongs to the supervisor the
 * committed activation names; a TERMINAL start keeps the supervisor generation that admitted it (its start record, its attachment
 * windows) and is never relabelled to the inventory under census. With `successor` the inventory is a CANDIDATE not yet selected
 * and the committed activation is authenticated as the pinned predecessor view. */
function reservedGroups(fence: HostedActivationFence, inventory: HostedInventoryV5, successor?: HostedSuccessorRequest) {
  assertHostedActivationFence(fence);
  const history = resolveOrdinaryCensusHistory(inventory, successor);
  if (!history) return [];
  const { activation } = history;
  return (activation.ordinaryStarts as Record<string, unknown>[]).map((r: Record<string, unknown>) => {
    if (typeof r.startId !== "string" || !/^[a-f0-9-]{36}$/.test(r.startId) || typeof r.unit !== "string" ||
        ![`subscription-runtime-ordinary-${r.startId}.service`, `subscription-runtime-hosted-${r.startId}.service`].includes(r.unit)) denied();
    const startBytes = readHostedActivationBytes(`ordinary-starts/${r.startId}.json`);
    if (!startBytes) denied();
    const start = JSON.parse(startBytes.toString("utf8")) as Record<string, unknown>, attachmentBytes = readHostedActivationBytes(`ordinary-starts/${r.startId}.identity.json`);
    if (start.installationId !== activation.installationId || start.unit !== r.unit) denied();
    const born = admittingSupervisorGeneration({ generations: history.generations, subject: history.subject, candidateCensus: history.candidateCensus,
      bootId: inventory.bootId, activationGeneration: activation.generation as number, terminal: r.state === HostedCustodyReservationState.Terminal,
      rowGeneration: r.generation, start: { supervisorId: start.supervisorId, bootId: start.bootId, activationGeneration: start.activationGeneration } });
    const attachment = attachmentBytes ? parseHostedOrdinaryOwnedIdentity(JSON.parse(attachmentBytes.toString("utf8"))) : null;
    if (attachment && (attachmentBytes!.length > 4096 || attachment.installationId !== activation.installationId || attachment.startId !== r.startId || attachment.unit !== r.unit ||
        attachment.startSha256 !== hash(startBytes) || attachment.creatorBirth !== start.creatorPidBirth || attachment.bootId !== born.bootId || attachment.supervisorBirth !== born.birth || attachment.controlGroup !== start.controlGroup ||
        attachment.workEndEpochMs !== born.workEndEpochMs || attachment.cleanupEndEpochMs !== born.cleanupEndEpochMs)) denied();
    return { row: r, start, attachment };
  });
}
/** `successor`: verify `original` as the CANDIDATE census of the funded installation successor, under the held fence and BEFORE its selection. */
export function verifyOrdinaryInstallationInventory(original: HostedInventoryV5, fence: HostedActivationFence, cleanup = false, successor?: HostedSuccessorRequest): void {
  const inventory = original;
  assertHostedActivationFence(fence); remaining(inventory, cleanup);
  const owned = reservedGroups(fence, original, successor), before = managerSnapshot(inventory, cleanup);
  const expectedNames = new Set([...inventory.units.flatMap(u => [u.name, ...u.aliases]), ...inventory.activators.flatMap(a => [a.name, ...a.aliases]), ...owned.map(o => o.row.unit as string)]);
  for (const line of lines(before.units)) if (!expectedNames.has(line.trim().split(/\s+/)[0]!)) denied();
  for (const line of lines(before.enabled)) if (!expectedNames.has(line.trim().split(/\s+/)[0]!)) denied();
  if (before.jobs.trim()) denied();
  for (const row of [...inventory.units, ...inventory.activators]) {
    const current = show(row.name, inventory, cleanup), measured = config(current);
    if (JSON.stringify(measured) !== JSON.stringify({ fragmentPath: row.fragmentPath, fragmentSha256: row.fragmentSha256, dropIns: row.dropIns,
        loadState: row.loadState, activeState: row.activeState, unitFileState: row.unitFileState, invocationId: row.invocationId, job: row.job }) ||
        JSON.stringify(names(current.Names!).filter(n => n !== row.name)) !== JSON.stringify(row.aliases) ||
        "targets" in row && (JSON.stringify(names(current.Triggers!)) !== JSON.stringify(row.targets) ||
          (row.name.endsWith(".socket") ? current.ControlGroup !== row.controlGroup || !["no", "false"].includes(current.Delegate!) : row.controlGroup !== null || row.delegate !== null)) ||
        "mainPidBirth" in row && (!["no", "false"].includes(current.Delegate!) || current.ControlGroup !== row.controlGroup || (row.name.endsWith(".scope") || current.MainPID === "0" ? null : collectProcessBirth(current.MainPID!)) !== row.mainPidBirth)) denied();
  }
  const groups = walkGroups([...inventory.units, ...owned.filter(o => o.attachment).map(o => ({ name: o.row.unit as string, controlGroup: o.start.controlGroup as string } as HostedInventoryUnit))], inventory, cleanup);
  const supervisorGroup = inventory.units.find(u => u.name === inventory.supervisorUnit)!.controlGroup;
  const expectedSupervisorMembers = ordinaryInstallationSupervisorMembers(original);
  for (const group of groups) {
    const reservation = owned.find(o => o.start.controlGroup === group.path);
    if (reservation) {
      const attachment = reservation.attachment;
      if (!attachment || group.dev !== attachment.dev || group.ino !== attachment.ino) denied();
      const current = show(reservation.row.unit as string, inventory, cleanup);
      if (current.InvocationID !== attachment.invocationId || current.ControlGroup !== group.path || current.Delegate !== "no") denied();
      continue;
    }
    const old = inventory.cgroups.find(c => c.path === group.path);
    if (!old || old.dev !== group.dev || old.ino !== group.ino || old.ownerUnit !== group.ownerUnit || old.parent !== group.parent) denied();
    if (group.path === supervisorGroup) {
      const actual = group.members.map(m => m.birth).sort(), expected = [...expectedSupervisorMembers].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) denied();
    } else if (JSON.stringify(group.members) !== JSON.stringify(old.members)) denied();
  }
  for (const old of inventory.cgroups) if (!groups.some(g => g.path === old.path)) denied();
  for (const reservation of owned) if (!reservation.attachment && groups.some(g => g.path === reservation.start.controlGroup)) denied();
  if (JSON.stringify(before) !== JSON.stringify(managerSnapshot(inventory, cleanup))) denied();
}
