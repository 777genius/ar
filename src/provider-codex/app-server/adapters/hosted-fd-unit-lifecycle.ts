const fixedLifecycle = Object.freeze({ Type: "exec", ExitType: "main", RemainAfterExit: "no", KillMode: "control-group",
  SendSIGKILL: "yes", Restart: "no", Delegate: "no", KillSignal: "15", FinalKillSignal: "9" } as const);
/** Copied manager facts, not a grant. Variable facts still need the original
 * recipe's private policy join; decoding cannot reconstruct launch custody. */
export type HostedFdUnitLifecycle = Readonly<typeof fixedLifecycle & {
  ProtectControlGroups: "yes" | "no"; TimeoutStopUSec: string;
}>;
function invalid():never { throw new Error("hosted_fd_boundary_unresolved"); }
// systemctl renders uint64 *USec properties using FORMAT_TIMESPAN, including
// fractional seconds/milliseconds. Decode exactly, without floating rounding,
// permissive parseSec aliases, an inferred default or an unbounded timeout.
function finiteStopUsec(text: string | undefined): string {
  if (!text || text.length > 256) invalid();
  const units = [["y", 31_557_600_000_000n], ["month", 2_629_800_000_000n], ["w", 604_800_000_000n],
    ["d", 86_400_000_000n], ["h", 3_600_000_000n], ["min", 60_000_000n], ["s", 1_000_000n],
    ["ms", 1_000n], ["us", 1n]] as const;
  const parts = text.split(" ");
  if (parts.length > units.length) invalid();
  let total = 0n, previous = -1;
  for (const [position, part] of parts.entries()) {
    const match = /^(0|[1-9][0-9]{0,19})(?:\.([0-9]{1,6}))?(y|month|w|d|h|min|s|ms|us)$/.exec(part);
    if (!match) invalid();
    const index = units.findIndex(([suffix]) => suffix === match[3]);
    if (index <= previous) invalid();
    const factor = units[index]![1], fraction = match[2];
    let value = BigInt(match[1]!) * factor;
    if (fraction !== undefined) {
      if (position !== parts.length - 1 || !(match[3] === "s" || match[3] === "ms")) invalid();
      const scale = 10n ** BigInt(fraction.length), numerator = BigInt(fraction) * factor;
      if (numerator % scale !== 0n) invalid();
      value += numerator / scale;
    }
    if (value === 0n) invalid();
    total += value;
    if (total >= 18_446_744_073_709_551_615n) invalid();
    previous = index;
  }
  return String(total);
}

/** Factual decoder only. ProtectControlGroups and the stop budget differ across
 * original recipes; neither is selected by a public caller-supplied policy. */
export function decodeHostedFdUnitLifecycle(rows: ReadonlyMap<string, string>): HostedFdUnitLifecycle {
  for (const [key, expected] of Object.entries(fixedLifecycle)) if (rows.get(key) !== expected) invalid();
  const protection = rows.get("ProtectControlGroups");
  if (protection !== "yes" && protection !== "no") invalid();
  return Object.freeze({ ...fixedLifecycle, ProtectControlGroups: protection,
    TimeoutStopUSec: finiteStopUsec(rows.get("TimeoutStopUSec")) });
}
