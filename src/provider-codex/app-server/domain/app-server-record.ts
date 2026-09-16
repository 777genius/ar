/**
 * Reads a JSON object, and only a JSON object.
 *
 * Arrays are `typeof value === "object"` but are not records. Accepting one
 * would let a malformed payload such as `tokenUsage.last = [1, 2, 3]` present
 * itself as a field-less object — "the provider reported nothing" — when the
 * honest classification is "the provider reported something we cannot read".
 * Every caller reads named fields, which an array never carries, so rejecting
 * arrays removes a false negative without narrowing any real payload.
 */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
