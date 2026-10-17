// TEST-only message facts. These classes never establish an observed D-Bus errno
// or authorize a retry, reservation release, property change or launch.
export const TransientStartMessage = {
  Unknown: "unknown", ClientOutsideUnit: "client_outside_unit", InvalidUnit: "invalid_unit",
  InvalidUnsetEnvironment: "invalid_unset_environment", InvalidEnvironment: "invalid_environment",
  InvalidEnvironmentNames: "invalid_environment_names", AccessDenied: "access_denied",
  InvalidArgument: "invalid_argument", OperationNotPermitted: "operation_not_permitted",
  PermissionDenied: "permission_denied", TimedOut: "timed_out", NotSupported: "not_supported",
  ConnectionRefused: "connection_refused", MissingFile: "missing_file",
  SocketOperationOnNonSocket: "socket_operation_on_non_socket",
} as const;
export type TransientStartMessage = typeof TransientStartMessage[keyof typeof TransientStartMessage];
const prefix = "Failed to start transient service unit: ";
const known = new Map<string, TransientStartMessage>([
  ["Client not member of any unit.", TransientStartMessage.ClientOutsideUnit],
  ["Invalid unit name or type.", TransientStartMessage.InvalidUnit],
  ["Invalid UnsetEnvironment= list.", TransientStartMessage.InvalidUnsetEnvironment],
  ["Invalid environment assignments", TransientStartMessage.InvalidEnvironment],
  ["Invalid environment variable names or assignments", TransientStartMessage.InvalidEnvironmentNames],
  ["Access denied", TransientStartMessage.AccessDenied],
  ["Invalid argument", TransientStartMessage.InvalidArgument],
  ["Operation not permitted", TransientStartMessage.OperationNotPermitted],
  ["Permission denied", TransientStartMessage.PermissionDenied],
  ["Timed out", TransientStartMessage.TimedOut], ["Not supported", TransientStartMessage.NotSupported],
  ["Connection refused", TransientStartMessage.ConnectionRefused], ["No such file or directory", TransientStartMessage.MissingFile],
  ["Socket operation on non-socket", TransientStartMessage.SocketOperationOnNonSocket],
]);
export interface TransientStartSample { fullBytes: number; offset: number; initialBytes: number; currentBytes: number }
export interface TransientStartFacts {
  message: TransientStartMessage; state: "complete" | "partial" | "malformed" | "oversize";
  sampleBytes: number; fullBytes: number | null; offset: number | null;
  ascii: boolean | null; control: boolean | null; nonAscii: boolean | null;
  lineCount: number | null; suffixBytes: number | null; tokenCount: number | null; numericTokenCount: number | null;
}
const safeCount = (value: number): number | null => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function classifyTransientStartFailure(bytes: Uint8Array, sample: TransientStartSample): TransientStartFacts {
  const fullBytes = safeCount(sample.fullBytes), offset = safeCount(sample.offset), currentBytes = safeCount(sample.currentBytes), initialBytes = safeCount(sample.initialBytes);
  const facts: TransientStartFacts = { message: TransientStartMessage.Unknown, state: "malformed",
    sampleBytes: bytes.length, fullBytes, offset, ascii: null, control: null, nonAscii: null,
    lineCount: null, suffixBytes: null, tokenCount: null, numericTokenCount: null };
  if (bytes.length > 4096) return { ...facts, state: "oversize" };
  facts.nonAscii = bytes.some(byte => byte > 127);
  facts.control = bytes.some(byte => byte < 32 && byte !== 10 || byte === 127);
  facts.ascii = !facts.nonAscii && !facts.control;
  facts.lineCount = bytes.reduce((count, byte) => count + Number(byte === 10), 0);
  if (fullBytes === null || offset === null || currentBytes === null || initialBytes === null || offset > fullBytes || bytes.length > fullBytes - offset) return facts;
  if (offset !== 0 || bytes.length !== fullBytes || currentBytes !== fullBytes || initialBytes !== fullBytes) return { ...facts, state: "partial" };
  if (!facts.ascii || facts.lineCount !== 1 || bytes[bytes.length - 1] !== 10) return facts;
  const line = Buffer.from(bytes).toString("ascii");
  if (!line.startsWith(prefix)) return facts;
  const body = line.slice(prefix.length, -1);
  // Only numbers and fixed identifiers leave this function. No arbitrary text,
  // hashes, token strings, paths or inferred error names are returned.
  const tokens = body.match(/[^ ]+/g) ?? [];
  facts.suffixBytes = body.length; facts.tokenCount = tokens.length;
  facts.numericTokenCount = tokens.filter(token => /^[0-9]+$/.test(token)).length;
  return { ...facts, state: "complete", message: known.get(body) ?? TransientStartMessage.Unknown };
}
