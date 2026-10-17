import { parseHostedConfiguredAuthAttachment, type HostedConfiguredAuthAttachment } from "./configured-auth-attachment";
import { readSystemBusInfrastructureField, type SystemBusInfrastructure } from "./system-bus-infrastructure";
import { readFdCollectorProfileField, type FdCollectorProfilePin } from "./fd-collector-profile";

export type HostedReadonlyHostInventory = {
  readonly schemaVersion: 1 | 2 | 3 | 4;
  readonly hostId: string;
  readonly supervisorUnit: string;
  readonly units: readonly { readonly name: string; readonly controlGroup: string; readonly fragmentSha256: string }[];
  readonly ordinaryCreators: readonly HostedOrdinaryCreator[];
  readonly disabledCreators: readonly string[];
  readonly runtimeLaunch: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
  readonly systemBusInfrastructure?: SystemBusInfrastructure;
  readonly collectorProfile?: FdCollectorProfilePin;
};
export type HostedOrdinaryCreator = {
  readonly creatorId: string; readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string;
  readonly childSlotSha256?: string;
  readonly authAttachment?: HostedConfiguredAuthAttachment;
  readonly launch: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
};
const unitPattern = /^[A-Za-z0-9_@.-]+\.(service|scope)$/;
const pathPattern = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;

/** Closed installed wire data only. No file, kernel, service or permission IO.
 * Original v1-v4 grammar/errors remain exact; actual adapters authenticate facts. */
export function parseHostedReadonlyHostInventory(decoded: unknown): HostedReadonlyHostInventory {
  const revision = !!decoded && typeof decoded === "object" && "schemaVersion" in decoded ? decoded.schemaVersion : undefined;
  const modern = revision === 2 || revision === 3 || revision === 4;
  const value = object(decoded, revision === 4 ? "collectorProfile,disabledCreators,hostId,ordinaryCreators,runtimeLaunch,schemaVersion,supervisorUnit,systemBusInfrastructure,units" :
    revision === 3 ? "disabledCreators,hostId,ordinaryCreators,runtimeLaunch,schemaVersion,supervisorUnit,systemBusInfrastructure,units" :
    modern ? "disabledCreators,hostId,ordinaryCreators,runtimeLaunch,schemaVersion,supervisorUnit,units" :
    "hostId,runtimeLaunch,schemaVersion,supervisorUnit,units");
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) || typeof value.hostId !== "string" || !/^[a-f0-9]{32}$/.test(value.hostId) ||
      !unit(value.supervisorUnit) || !Array.isArray(value.units) || value.units.length < 1 || value.units.length > 128) invalid();
  const units = value.units.map(entry => {
    const row = object(entry, "controlGroup,fragmentSha256,name");
    if (!unit(row.name) || !path(row.controlGroup) || row.name.startsWith("subscription-runtime-hosted-") ||
        typeof row.fragmentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.fragmentSha256)) invalid();
    return Object.freeze({ name: row.name, controlGroup: row.controlGroup, fragmentSha256: row.fragmentSha256 });
  });
  if (new Set(units.map(row => row.name)).size !== units.length ||
      new Set(units.map(row => row.controlGroup)).size !== units.length ||
      !units.some(row => row.name === value.supervisorUnit)) invalid();
  const systemBusInfrastructure = readSystemBusInfrastructureField(value);
  const collectorProfile = readFdCollectorProfileField(value);
  if (systemBusInfrastructure && (value.supervisorUnit === "dbus.service" ||
      !units.some(row => row.name === "dbus.service" && row.controlGroup === systemBusInfrastructure.service.controlGroup &&
        row.fragmentSha256 === systemBusInfrastructure.service.fragmentSha256))) invalid();
  const launch = parseLaunch(value.runtimeLaunch);
  let ordinaryCreators: HostedOrdinaryCreator[] = [], disabledCreators: string[] = [];
  if (modern) {
    if (!Array.isArray(value.ordinaryCreators) || value.ordinaryCreators.length > 128 ||
        !Array.isArray(value.disabledCreators) || value.disabledCreators.length > 128) invalid();
    ordinaryCreators = value.ordinaryCreators.map(entry => {
      const hasSlot = !!entry && typeof entry === "object" && "childSlotSha256" in entry;
      const hasAuth = !!entry && typeof entry === "object" && "authAttachment" in entry;
      if (hasAuth && (revision !== 4 || hasSlot)) invalid();
      const row = object(entry, hasAuth ? "authAttachment,creatorId,jobId,jobRootDir,launch,workspacePath" : hasSlot ? "childSlotSha256,creatorId,jobId,jobRootDir,launch,workspacePath" : "creatorId,jobId,jobRootDir,launch,workspacePath");
      if (hasSlot && (typeof row.childSlotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.childSlotSha256))) invalid();
      if (!identity(row.creatorId) || !identity(row.jobId) || !path(row.jobRootDir) || !path(row.workspacePath)) invalid();
      const parsedLaunch = parseLaunch(row.launch);
      const authAttachment = hasAuth ? parseHostedConfiguredAuthAttachment(row.authAttachment,row.jobRootDir,parsedLaunch.args) : undefined;
      if (authAttachment && authAttachment.issuerGroup !== `0::${units.find(u=>u.name===value.supervisorUnit)!.controlGroup}`) invalid();
      return Object.freeze({ creatorId: row.creatorId, jobId: row.jobId, jobRootDir: row.jobRootDir,
        workspacePath: row.workspacePath, ...(hasSlot ? { childSlotSha256: row.childSlotSha256 as string } : {}), launch: parsedLaunch, ...(authAttachment ? {authAttachment} : {}) });
    });
    disabledCreators = value.disabledCreators.map(name => {
      if (typeof name !== "string" || name.length > 200 || !/^[A-Za-z0-9_@.-]+\.(service|socket|timer)$/.test(name) ||
          units.some(row => row.name === name) || (systemBusInfrastructure && name === "dbus.socket")) invalid();
      return name;
    });
    if (new Set(ordinaryCreators.map(row => row.creatorId)).size !== ordinaryCreators.length ||
        new Set(disabledCreators).size !== disabledCreators.length) invalid();
    // Multiple finite launch tuples may describe one job, but never conflicting
    // root/workspace provenance or two identities sharing a mutable job scope.
    for (const left of ordinaryCreators) for (const right of ordinaryCreators) {
      if (left !== right && left.jobId === right.jobId && (left.childSlotSha256 || right.childSlotSha256)) invalid();
      if (left.jobId === right.jobId ? left.jobRootDir !== right.jobRootDir || left.workspacePath !== right.workspacePath :
          left.jobRootDir === right.jobRootDir || left.workspacePath === right.workspacePath) invalid();
    }
  }
  return Object.freeze({ schemaVersion: value.schemaVersion, hostId: value.hostId, supervisorUnit: value.supervisorUnit,
    units: Object.freeze(units), runtimeLaunch: launch,
    ordinaryCreators: Object.freeze(ordinaryCreators), disabledCreators: Object.freeze(disabledCreators),
    ...(systemBusInfrastructure ? { systemBusInfrastructure } : {}), ...(collectorProfile ? { collectorProfile } : {}) });
}

function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) invalid();
  return value as Record<string, unknown>;
}
function unit(value: unknown): value is string { return typeof value === "string" && value.length <= 200 && unitPattern.test(value); }
function path(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && pathPattern.test(value) && !value.split("/").some(part => part === "." || part === ".."); }
function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }

function identity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(value);
}
function parseLaunch(value: unknown): HostedOrdinaryCreator["launch"] {
  const launch = object(value, "args,command,cwd");
  if (!path(launch.command) || !path(launch.cwd) || !Array.isArray(launch.args) || launch.args.length > 128 ||
      !launch.args.every(arg => typeof arg === "string" && arg.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(arg))) invalid();
  return Object.freeze({ command: launch.command, cwd: launch.cwd, args: Object.freeze([...launch.args]) as readonly string[] });
}
