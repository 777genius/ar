/** Private parsers for OS facts. These facts never authenticate a creator,
 * reservation, completion receipt, or authority record. */
const unitName = /^[A-Za-z0-9_@.-]+\.(service|scope)$/;
const custodyUnit = /^subscription-runtime-(?:hosted|outer|ordinary)-[a-f0-9-]{36}\.service$/;
const showKeys = ["Id", "FragmentPath", "DropInPaths", "ControlGroup", "MainPID"] as const;

function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }
function lines(value: string): string[] { return value.split("\n").filter(line => line.trim()); }

export function observedBootId(value: string): string {
  const boot = value.trim();
  if (!/^[a-f0-9-]{36}$/.test(boot)) invalid();
  return boot;
}

export function observedProcessBirth(pid: string, stat: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(pid) || !stat.startsWith(pid + " (") || stat.lastIndexOf(") ") < 0) invalid();
  const birth = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  if (!birth || !/^[1-9][0-9]{0,19}$/.test(birth)) invalid();
  return `${pid}:${birth}`;
}

export { observedProcessCgroup } from "../core/host-infrastructure/process-cgroup";

export function parseUnitShow(name: string, raw: string): Record<string, string> {
  if (name.length > 200 || !unitName.test(name)) invalid();
  const result: Record<string, string> = {};
  for (const line of lines(raw)) {
    const split = line.indexOf("=");
    const key = line.slice(0, split);
    if (split < 1 || !showKeys.some(value => value === key) || key in result) invalid();
    result[key] = line.slice(split + 1);
  }
  if (Object.keys(result).length !== showKeys.length || result.Id !== name) invalid();
  return result;
}

export function custodyControlGroup(name: string): string {
  if (!custodyUnit.test(name)) invalid();
  return `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${name}`;
}

export function assertExactUnitGroup(name: string, observed: Readonly<Record<string, string>>, expectedGroup: string): void {
  if (observed.Id !== name || observed.ControlGroup !== expectedGroup) invalid();
}

export function assertNoQueuedStart(raw: string, unit: string): void {
  custodyControlGroup(unit);
  if (observedJobUnits(raw).includes(unit)) throw new Error("hosted_custody_start_still_queued");
}

export function observedJobUnits(raw: string): readonly string[] {
  const names: string[] = [];
  for (const line of lines(raw)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^\d+$/.test(fields[0] ?? "")) invalid();
    names.push(fields[1]!);
  }
  return names;
}

export function assertTerminalUnit(unit: string, observed: Readonly<Record<string, string>>): void {
  if (observed.MainPID !== "0" || (observed.ControlGroup && observed.ControlGroup !== custodyControlGroup(unit))) invalid();
}

export function assertPopulatedZero(raw: string): void {
  // Parse every record. Whitespace cannot hide a second populated row.
  let populated = 0;
  const rows = raw.split("\n");
  for (const [index, row] of rows.entries()) {
    if (row === "" && index === rows.length - 1) continue;
    if (!/^[a-z_]+ [0-9]+$/.test(row)) throw new Error("hosted_custody_descendants_not_terminal");
    const [key, value] = row.split(" ");
    if (key === "populated") {
      if (++populated !== 1 || value !== "0") throw new Error("hosted_custody_descendants_not_terminal");
    }
  }
  if (populated !== 1) throw new Error("hosted_custody_descendants_not_terminal");
}

export enum ScopedManagerJobType { Start = "start", Stop = "stop", Restart = "restart", Reload = "reload", ReloadOrStart = "reload-or-start", TryRestart = "try-restart", VerifyActive = "verify-active", Nop = "nop" }
export enum ScopedManagerJobState { Waiting = "waiting", Running = "running" }
export interface ScopedManagerJob { readonly id: string; readonly unit: string; readonly type: ScopedManagerJobType; readonly state: ScopedManagerJobState }
/** Complete strict list, then select exact units. Unknown/malformed rows cannot
 * disappear through prefix filtering and become a false empty queue. */
export function parseScopedManagerJobs(raw: string): readonly ScopedManagerJob[] {
  const ids = new Set<string>();
  return lines(raw).map(line => {
    const row = line.trim().split(/\s+/), [id, unit, type, state] = row;
    if (row.length !== 4 || !id || !/^[1-9][0-9]*$/.test(id) || ids.has(id) || !unit || unit.length > 255 || !/^(?:[A-Za-z0-9_@.:-]|\\x[0-9a-fA-F]{2})+\.(?:service|scope|socket|timer|target|mount|automount|device|swap|path|slice)$/.test(unit) ||
        !type || !Object.values(ScopedManagerJobType).includes(type as ScopedManagerJobType) ||
        !state || !Object.values(ScopedManagerJobState).includes(state as ScopedManagerJobState)) invalid();
    ids.add(id); return Object.freeze({ id, unit, type: type as ScopedManagerJobType, state: state as ScopedManagerJobState });
  });
}
export function scopedCgroupPopulated(raw: string): boolean {
  const fields = new Map<string, string>();
  for (const line of raw.trimEnd().split("\n")) {
    const row = line.split(" ");
    if (row.length !== 2 || !["populated", "frozen"].includes(row[0]!) || !/^[01]$/.test(row[1]!) || fields.has(row[0]!)) invalid();
    fields.set(row[0]!, row[1]!);
  }
  if (!fields.has("populated")) invalid(); return fields.get("populated") === "1";
}
