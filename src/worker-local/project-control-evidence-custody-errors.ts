/** Error-code helpers shared by the local evidence custody modules. */
export function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}
export function deepCode(error: unknown): string | undefined {
  const direct = code(error);
  if (direct) return direct;
  return error instanceof Error && error.cause !== undefined
    ? deepCode(error.cause)
    : undefined;
}
export function custodyError(message: string, cause: unknown): Error & { code?: string } {
  const error: Error & { code?: string } = new Error(message, { cause });
  const causeCode = deepCode(cause);
  if (causeCode !== undefined) error.code = causeCode;
  return error;
}
