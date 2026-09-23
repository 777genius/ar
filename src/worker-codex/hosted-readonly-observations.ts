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
  // Other cgroup.events keys are permitted, but populated must occur exactly
  // once with the kernel's numeric zero. Duplicates and malformed rows fail.
  const rows = lines(raw).filter(line => line.startsWith("populated"));
  if (rows.length !== 1 || rows[0] !== "populated 0") {
    throw new Error("hosted_custody_descendants_not_terminal");
  }
}
