/** Compact lexical observations only; none authenticates an executable or ancestry. */
export enum AppServerNamespaceReason { Prefix = "p", Main = "m", Stage = "s", Duplicate = "d", Parent = "a", Order = "o" }
export enum AppServerNamespaceRole { Unknown = "?", Unshare = "u", Setpriv = "s", Tini = "t", UnshareBasename = "U", SetprivBasename = "S", TiniBasename = "T", Other = "x" }
export enum AppServerNamespaceArgKind { None = "n", Exact = "e", KnownLiteral = "l", Basename = "b", Other = "x", Missing = "m" }
export interface AppServerNamespaceShape {
  readonly role: AppServerNamespaceRole; readonly matches: number; readonly argcCapped: number;
  readonly expected: number; readonly mismatchIndexCapped: number; readonly argKind: AppServerNamespaceArgKind;
}
export interface AppServerNamespaceFailure {
  readonly reason: AppServerNamespaceReason; readonly actor: AppServerNamespaceShape; readonly main: AppServerNamespaceShape;
  readonly parentMatches: number;
}
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function shape(value: unknown): AppServerNamespaceShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  const role = fields.role?.value, matches = fields.matches?.value, argcCapped = fields.argcCapped?.value;
  const expected = fields.expected?.value, mismatchIndexCapped = fields.mismatchIndexCapped?.value, argKind = fields.argKind?.value;
  if (!Object.values(AppServerNamespaceRole).includes(role) || !Object.values(AppServerNamespaceArgKind).includes(argKind) ||
      !bounded(matches, 0, 15) || !bounded(argcCapped, 0, 255) || !bounded(expected, 0, 4) || !bounded(mismatchIndexCapped, -1, 255)) return undefined;
  return Object.freeze({ role, matches, argcCapped, expected, mismatchIndexCapped, argKind });
}
export function validatedNamespaceFailure(value: unknown): AppServerNamespaceFailure | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value), reason = fields.reason?.value, parentMatches = fields.parentMatches?.value;
    const actor = shape(fields.actor?.value), main = shape(fields.main?.value);
    if (!Object.values(AppServerNamespaceReason).includes(reason) || !bounded(parentMatches, 0, 15) || !actor || !main) return undefined;
    return Object.freeze({ reason, actor, main, parentMatches });
  } catch { return undefined; }
}
/** Shapes: role, exact suffix mask (stages 0/7/13/18), capped argc, nearest stage
 * ordinal (0 absent; 1..4), capped first mismatch (-1 exact), observed arg kind. */
export function formatNamespaceFailure(value: AppServerNamespaceFailure): string {
  const row = (item: AppServerNamespaceShape) => `${item.role},${item.matches},${item.argcCapped},${item.expected},${item.mismatchIndexCapped},${item.argKind}`;
  return `${value.reason}:${row(value.actor)}:${row(value.main)}:${value.parentMatches}`;
}
