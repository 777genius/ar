import type { HostedFdUnitLifecycle } from "./hosted-fd-unit-lifecycle";

export enum HostedFdPolicySelectionKind { Explicit = "explicit", Absent = "absent" }
type Selection = Readonly<{ kind: HostedFdPolicySelectionKind.Explicit; value: string }> |
  Readonly<{ kind: HostedFdPolicySelectionKind.Absent }>;
/** Factual original argument projection. Only the physical constructor retains
 * this privately; this object cannot enroll a child or authorize release. */
export type HostedFdUnitPolicy = Readonly<Record<keyof HostedFdUnitLifecycle, Selection>>;
const fields = ["Type", "ExitType", "RemainAfterExit", "KillMode", "SendSIGKILL", "Restart", "Delegate",
  "ProtectControlGroups", "TimeoutStopUSec", "KillSignal", "FinalKillSignal"] as const;
function invalid(): never { throw new Error("hosted_fd_original_unit_policy_unresolved"); }
function seconds(text: string): string {
  const match = /^(0|[1-9][0-9]{0,19})(?:\.([0-9]{1,6}))?s?$/.exec(text);
  if (!match) invalid();
  const value = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (value < 1n || value >= 18_446_744_073_709_551_615n) invalid();
  return String(value);
}
/** Reads only the exact manager-option prefix. Missing selection is preserved,
 * including legacy manager defaults. Duplicate selections stay unresolved. */
export function readHostedFdUnitPolicy(args: readonly string[]): HostedFdUnitPolicy {
  const at = args.indexOf("--"); if (at < 0) invalid();
  const values = new Map<keyof HostedFdUnitLifecycle, string>();
  for (const arg of args.slice(0, at)) {
    const property = arg.startsWith("--service-type=") ? "Type=" + arg.slice(15) :
      arg.startsWith("--property=") ? arg.slice(11) : undefined;
    if (property === undefined) continue;
    const index = property.indexOf("="), name = property.slice(0, index), raw = property.slice(index + 1);
    const key = name === "TimeoutStopSec" ? "TimeoutStopUSec" : fields.find(field => field === name);
    if (key === undefined) continue;
    if (index < 1 || values.has(key) || key === "TimeoutStopUSec" && name !== "TimeoutStopSec") invalid();
    values.set(key, key === "TimeoutStopUSec" ? seconds(raw) : raw);
  }
  const selection = (key: keyof HostedFdUnitLifecycle): Selection => values.has(key) ?
    Object.freeze({ kind: HostedFdPolicySelectionKind.Explicit, value: values.get(key)! }) :
    Object.freeze({ kind: HostedFdPolicySelectionKind.Absent });
  return Object.freeze({ Type: selection("Type"), ExitType: selection("ExitType"), RemainAfterExit: selection("RemainAfterExit"),
    KillMode: selection("KillMode"), SendSIGKILL: selection("SendSIGKILL"), Restart: selection("Restart"), Delegate: selection("Delegate"),
    ProtectControlGroups: selection("ProtectControlGroups"), TimeoutStopUSec: selection("TimeoutStopUSec"),
    KillSignal: selection("KillSignal"), FinalKillSignal: selection("FinalKillSignal") });
}
export function assertHostedFdUnitPolicy(policy: HostedFdUnitPolicy, actual: HostedFdUnitLifecycle): void {
  for (const key of fields) {
    const selected = policy[key];
    if (selected.kind === HostedFdPolicySelectionKind.Explicit && selected.value !== actual[key]) invalid();
  }
}
export function sameHostedFdUnitLifecycle(a: HostedFdUnitLifecycle, b: HostedFdUnitLifecycle): boolean {
  return fields.every(key => a[key] === b[key]);
}
