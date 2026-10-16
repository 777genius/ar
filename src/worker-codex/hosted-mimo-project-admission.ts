/** A check command that embeds a commit SHA (40 hex, any case, so also the start of a longer digest) or a 64-hex digest.
 * A reusable line cannot be moved with such a check, so preparation and advance share this one definition.
 * A command that merely contains an unrelated 40-hex literal is also refused; the plan then carries a reviewed template. */
export function hasPinnedRequiredCheck(checks: readonly { readonly command: string }[]): boolean {
  return checks.some(check => /[a-f0-9]{40}/i.test(check.command));
}
