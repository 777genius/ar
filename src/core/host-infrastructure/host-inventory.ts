/** Pure fixed-inventory wire contract. Parsing supplies DATA, never process ownership. */
export const hostedInventoryMaximumBytes = 4 * 1024 * 1024;
export const hostedLegacyInventoryMaximumBytes = 64 * 1024;
export enum HostedInventoryCategory { Borrowed = "borrowed", Supervisor = "supervisor" }
export type HostedInventoryFile = Readonly<{ path: string; sha256: string }>;
export type HostedInventoryLaunch = Readonly<{ command: string; args: readonly string[]; cwd: string }>;
export type HostedInventoryMember = Readonly<{ birth: string; controlGroup: string }>;
export type HostedInventoryUnit = Readonly<{
  category: HostedInventoryCategory; name: string; aliases: readonly string[]; controlGroup: string;
  fragmentPath: string | null; fragmentSha256: string | null; dropIns: readonly HostedInventoryFile[];
  loadState: string; activeState: string; unitFileState: string; invocationId: string;
  mainPidBirth: string | null; job: string; delegate: false;
}>;
export type HostedInventoryCgroup = Readonly<{
  path: string; dev: string; ino: string; ownerUnit: string | null; parent: string | null;
  members: readonly HostedInventoryMember[];
}>;
export type HostedInventoryActivator = Readonly<{
  name: string; aliases: readonly string[]; targets: readonly string[]; controlGroup: string | null; delegate: false | null; loadState: string;
  activeState: string; unitFileState: string; invocationId: string; job: string;
  fragmentPath: string; fragmentSha256: string; dropIns: readonly HostedInventoryFile[];
}>;
export type HostedInventoryCreator = Readonly<{ creatorId: string; jobId: string; jobRootDir: string;
  workspacePath: string; childSlotSha256?: string; launch: HostedInventoryLaunch }>;
export type HostedInventorySupervisor = Readonly<{ birth: string; executable: HostedInventoryFile;
  bootstrap: HostedInventoryFile; operationId: string; workEndEpochMs: number; cleanupEndEpochMs: number }>;
export type HostedInventoryV5 = Readonly<{
  schemaVersion: 5; hostId: string; bootId: string; supervisorUnit: string;
  units: readonly HostedInventoryUnit[]; cgroups: readonly HostedInventoryCgroup[];
  activators: readonly HostedInventoryActivator[]; supervisor: HostedInventorySupervisor;
  ordinaryCreators: readonly HostedInventoryCreator[]; disabledCreators: readonly string[];
  runtimeLaunch: HostedInventoryLaunch; systemBusInfrastructure: Readonly<Record<string, unknown>>;
  collectorProfile: HostedInventoryFile;
}>;
function fail(): never { throw new Error("hosted_inventory_invalid"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || pattern && !pattern.test(value)) fail();
  return value;
}
function path(value: unknown, root = false): string {
  const result = text(value, root ? /^(?:\/[A-Za-z0-9_.@+-]+)*$/ : /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if (result.split("/").some(p => p === "." || p === "..")) fail(); return result;
}
function unit(value: unknown): string { return text(value, /^[A-Za-z0-9_@.-]{1,190}\.(service|scope|socket|timer|target)$/); }
function birth(value: unknown): string { return text(value, /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/); }
function digest(value: unknown): string { return text(value, /^[a-f0-9]{64}$/); }
function list<T>(value: unknown, max: number, parse: (v: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > max) fail(); return Object.freeze(value.map(parse));
}
function distinct(values: readonly string[]): void { if (new Set(values).size !== values.length) fail(); }
function names(value: unknown, max = 1024): readonly string[] { const result = list(value, max, unit); distinct(result); return result; }
function file(value: unknown): HostedInventoryFile {
  const row = object(value, "path,sha256"); return Object.freeze({ path: path(row.path), sha256: digest(row.sha256) });
}
function dropIns(value: unknown): readonly HostedInventoryFile[] {
  const result = list(value, 16, file); distinct(result.map(r => r.path)); return result;
}
function launch(value: unknown): HostedInventoryLaunch {
  const row = object(value, "command,args,cwd");
  return Object.freeze({ command: path(row.command), cwd: path(row.cwd), args: list(row.args, 128, v => text(v)) });
}
function state(value: unknown, allowed: readonly string[]): string { const result = text(value); if (!allowed.includes(result)) fail(); return result; }
function configuration(row: Record<string, unknown>, scope = false) {
  const absent = scope && row.fragmentPath === null && row.fragmentSha256 === null;
  const fragmentPath = absent ? null : path(row.fragmentPath), fragmentSha256 = absent ? null : digest(row.fragmentSha256);
  const loadState = state(row.loadState, ["loaded", "masked"]);
  const activeState = state(row.activeState, ["active", "inactive", "failed", "activating", "deactivating", "reloading"]);
  const unitFileState = state(row.unitFileState, ["", "enabled", "enabled-runtime", "disabled", "static", "indirect", "alias", "linked", "linked-runtime", "masked", "masked-runtime", "generated", "transient"]);
  const invocationId = text(row.invocationId, /^(?:[a-f0-9]{32})?$/), job = text(row.job);
  if (job !== "") fail();
  return { fragmentPath, fragmentSha256, dropIns: dropIns(row.dropIns), loadState, activeState, unitFileState, invocationId, job };
}
function freezeData(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeData));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freezeData(v)])));
  return value;
}
export function parseHostedInventoryV5(value: unknown): HostedInventoryV5 {
  const row = object(value, "schemaVersion,hostId,bootId,supervisorUnit,units,cgroups,activators,supervisor,ordinaryCreators,disabledCreators,runtimeLaunch,systemBusInfrastructure,collectorProfile");
  if (row.schemaVersion !== 5) fail();
  const hostId = text(row.hostId, /^[a-f0-9]{32}$/), bootId = text(row.bootId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/), supervisorUnit = unit(row.supervisorUnit);
  const units = list(row.units, 1024, value => {
    const u = object(value, "category,name,aliases,controlGroup,fragmentPath,fragmentSha256,dropIns,loadState,activeState,unitFileState,invocationId,mainPidBirth,job,delegate");
    if (u.category !== HostedInventoryCategory.Borrowed && u.category !== HostedInventoryCategory.Supervisor || u.delegate !== false) fail();
    const name = unit(u.name); if (!/\.(service|scope)$/.test(name) || u.category === HostedInventoryCategory.Borrowed && /^subscription-runtime-(?:ordinary|hosted|outer)-/.test(name)) fail();
    const config = configuration(u, name.endsWith(".scope") && u.category === HostedInventoryCategory.Borrowed), mainPidBirth = u.mainPidBirth === null ? null : birth(u.mainPidBirth);
    if (["inactive", "failed"].includes(config.activeState) && mainPidBirth !== null || mainPidBirth !== null && config.invocationId === "") fail();
    return Object.freeze({ category: u.category as HostedInventoryCategory, name, aliases: names(u.aliases), controlGroup: path(u.controlGroup), ...config, mainPidBirth, delegate: false as const });
  });
  if (!units.length || units.filter(u => u.category === HostedInventoryCategory.Supervisor).length !== 1 ||
      !units.some(u => u.name === supervisorUnit && u.category === HostedInventoryCategory.Supervisor && u.mainPidBirth)) fail();
  distinct(units.map(u => u.name)); distinct(units.map(u => u.controlGroup));
  const activators = list(row.activators, 512, value => {
    const a = object(value, "name,aliases,targets,controlGroup,delegate,loadState,activeState,unitFileState,invocationId,job,fragmentPath,fragmentSha256,dropIns");
    const name = unit(a.name); if (!/\.(socket|timer|target)$/.test(name)) fail();
    const socket = name.endsWith(".socket");
    if (socket ? a.delegate !== false : a.delegate !== null || a.controlGroup !== null) fail();
    const config = configuration(a);
    return Object.freeze({ name, aliases: names(a.aliases), targets: names(a.targets), controlGroup: socket ? path(a.controlGroup, true) : null,
      delegate: socket ? false as const : null, ...config, fragmentPath: config.fragmentPath!, fragmentSha256: config.fragmentSha256! });
  });
  distinct(activators.map(a => a.name));
  const all = [...units, ...activators], canonicalNames = all.map(u => u.name), aliases = all.flatMap(u => [...u.aliases]);
  distinct([...canonicalNames, ...aliases]);
  for (const a of activators) if (a.targets.some(t => !canonicalNames.includes(t))) fail();
  const cgroups = list(row.cgroups, 4096, value => {
    const c = object(value, "path,dev,ino,ownerUnit,parent,members"), group = path(c.path, true);
    const members = list(c.members, 65536, value => {
      const m = object(value, "birth,controlGroup"); if (path(m.controlGroup, true) !== group) fail();
      return Object.freeze({ birth: birth(m.birth), controlGroup: group });
    });
    const ownerUnit = c.ownerUnit === null ? null : unit(c.ownerUnit), parent = c.parent === null ? null : path(c.parent, true);
    if (group === "" ? parent !== null : parent !== group.slice(0, group.lastIndexOf("/"))) fail();
    if (ownerUnit !== null && !units.some(u => u.name === ownerUnit && u.controlGroup === group) || members.length && ownerUnit === null) fail();
    const owner = units.find(u => u.name === ownerUnit);
    if (owner && owner.mainPidBirth === null && members.length && (owner.name.endsWith(".service") || ["inactive", "failed"].includes(owner.activeState))) fail();
    return Object.freeze({ path: group, dev: text(c.dev, /^[0-9]{1,20}$/), ino: text(c.ino, /^[1-9][0-9]{0,19}$/), ownerUnit, parent, members });
  });
  distinct(cgroups.map(c => c.path)); distinct(cgroups.map(c => `${c.dev}:${c.ino}`)); distinct(cgroups.flatMap(c => c.members.map(m => m.birth.split(":")[0]!)));
  if (!cgroups.some(c => c.path === "")) fail();
  for (const c of cgroups) if (c.parent !== null && !cgroups.some(p => p.path === c.parent)) fail();
  for (const u of units) if (!cgroups.some(c => c.path === u.controlGroup && c.ownerUnit === u.name &&
      (u.mainPidBirth === null || c.members.some(m => m.birth === u.mainPidBirth)))) fail();
  const supervisorRow = object(row.supervisor, "birth,executable,bootstrap,operationId,workEndEpochMs,cleanupEndEpochMs");
  const workEndEpochMs = supervisorRow.workEndEpochMs, cleanupEndEpochMs = supervisorRow.cleanupEndEpochMs;
  if (!Number.isSafeInteger(workEndEpochMs) || !Number.isSafeInteger(cleanupEndEpochMs) || (workEndEpochMs as number) < 1 || (cleanupEndEpochMs as number) <= (workEndEpochMs as number)) fail();
  const supervisor = Object.freeze({ birth: birth(supervisorRow.birth), executable: file(supervisorRow.executable), bootstrap: file(supervisorRow.bootstrap),
    operationId: text(supervisorRow.operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/), workEndEpochMs: workEndEpochMs as number, cleanupEndEpochMs: cleanupEndEpochMs as number });
  if (units.find(u => u.name === supervisorUnit)!.mainPidBirth !== supervisor.birth) fail();
  const ordinaryCreators = list(row.ordinaryCreators, 1, value => {
    const v = object(value, value && typeof value === "object" && "childSlotSha256" in value ? "creatorId,jobId,jobRootDir,workspacePath,launch,childSlotSha256" : "creatorId,jobId,jobRootDir,workspacePath,launch");
    const jobId = text(v.jobId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), jobRootDir = path(v.jobRootDir), workspacePath = path(v.workspacePath), recipe = launch(v.launch);
    if (!jobRootDir.endsWith(`/jobs/${jobId}`) || workspacePath !== `${jobRootDir}/workspace` || recipe.cwd !== workspacePath) fail();
    return Object.freeze({ creatorId: text(v.creatorId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), jobId, jobRootDir, workspacePath, launch: recipe,
      ...(v.childSlotSha256 === undefined ? {} : { childSlotSha256: digest(v.childSlotSha256) }) });
  });
  if (ordinaryCreators.length !== 1) fail();
  const runtimeLaunch = launch(row.runtimeLaunch);
  if (JSON.stringify(runtimeLaunch) !== JSON.stringify(ordinaryCreators[0]!.launch)) fail();
  const disabledCreators = names(row.disabledCreators, 512);
  if (disabledCreators.some(n => [...canonicalNames, ...aliases].includes(n))) fail();
  if (!row.systemBusInfrastructure || typeof row.systemBusInfrastructure !== "object" || Array.isArray(row.systemBusInfrastructure)) fail();
  const collectorProfile = file(row.collectorProfile);
  if (collectorProfile.path !== "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json") fail();
  return Object.freeze({ schemaVersion: 5, hostId, bootId, supervisorUnit, units, cgroups, activators, supervisor, ordinaryCreators, disabledCreators, runtimeLaunch,
    collectorProfile, systemBusInfrastructure: freezeData(row.systemBusInfrastructure) as Readonly<Record<string, unknown>> });
}
/** The widened read ceiling applies only to this fixed record. Old shapes retain 64 KiB. */
export function decodeHostedInventoryBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength > hostedInventoryMaximumBytes) fail();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(); }
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 5) return parseHostedInventoryV5(value);
  if (bytes.byteLength > hostedLegacyInventoryMaximumBytes) fail(); return value;
}

/** Protected Store-selected attachment DATA, not a constructor of ownership. */
export type HostedOrdinaryOwnedIdentity = Readonly<{ schemaVersion: 1; installationId: string; startId: string; startSha256: string;
  parentStartId: string | null; unit: string; bootId: string; supervisorBirth: string; creatorBirth: string;
  invocationId: string; controlGroup: string; dev: string; ino: string; mainPidBirth: string;
  workEndEpochMs: number; cleanupEndEpochMs: number }>;
export function parseHostedOrdinaryOwnedIdentity(value: unknown): HostedOrdinaryOwnedIdentity {
  const row = object(value, "schemaVersion,installationId,startId,startSha256,parentStartId,unit,bootId,supervisorBirth,creatorBirth,invocationId,controlGroup,dev,ino,mainPidBirth,workEndEpochMs,cleanupEndEpochMs");
  const uuid = (value: unknown) => text(value, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.workEndEpochMs) || !Number.isSafeInteger(row.cleanupEndEpochMs) ||
      (row.workEndEpochMs as number) < 1 || (row.cleanupEndEpochMs as number) <= (row.workEndEpochMs as number)) fail();
  const startId = uuid(row.startId), name = unit(row.unit), controlGroup = path(row.controlGroup), parentStartId = row.parentStartId === null ? null : uuid(row.parentStartId);
  if (name !== `subscription-runtime-${parentStartId === null ? "ordinary" : "hosted"}-${startId}.service` ||
      controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${name}` || parentStartId === startId) fail();
  return Object.freeze({ schemaVersion: 1, installationId: uuid(row.installationId), startId, startSha256: digest(row.startSha256), parentStartId, unit: name,
    bootId: uuid(row.bootId), supervisorBirth: birth(row.supervisorBirth), creatorBirth: birth(row.creatorBirth), invocationId: text(row.invocationId, /^[a-f0-9]{32}$/),
    controlGroup, dev: text(row.dev, /^[0-9]{1,20}$/), ino: text(row.ino, /^[1-9][0-9]{0,19}$/), mainPidBirth: birth(row.mainPidBirth),
    workEndEpochMs: row.workEndEpochMs as number, cleanupEndEpochMs: row.cleanupEndEpochMs as number });
}
