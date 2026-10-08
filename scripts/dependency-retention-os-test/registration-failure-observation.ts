/** Bounded TEST observation only. Literal membership never establishes a
 * cause, permission, retry decision, successful registration or runtime proof. */
import { types } from "node:util";
const isProxy = types.isProxy, isNativeError = types.isNativeError;
const descriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn;
const freeze = Object.freeze;
export enum RegistrationInputStep {
  None = "none", Prepare = "prepare_current_local_inputs",
  Sentinel = "publish_source_sentinel", GitIgnore = "publish_git_ignore",
  Config = "publish_default_test_config", Digest = "capture_runtime_manifest",
  RuntimePins = "capture_runtime_package_pins",
}
enum FailureClass { Unknown = "unknown", NativeError = "native_error" }
enum FailureLiteral {
  Unknown = "unknown", Assertion = "assertion_code_literal",
  NpmVersion = "fixed_npm_version_failure_literal", Pack = "fixed_pack_failure_literal",
  Lock = "fixed_lock_selection_failure_literal", Model = "fixed_model_expectation_failure_literal",
}
export type RegistrationFailureObservation = Readonly<{
  errorClass: FailureClass; fixedLiteral: FailureLiteral;
}>;
function ownString(error: object, key: "message" | "code"): string | undefined {
  const own = descriptor(error, key);
  return own && hasOwn(own, "value") && typeof own.value === "string" && own.value.length <= 96
    ? own.value : undefined;
}
/** Reject Proxy before reflection. Only two own data descriptors are examined;
 * no name, stack, cause, prototype, iterator, stringify or arbitrary text escapes. */
export function observeRegistrationFailure(error: unknown): RegistrationFailureObservation {
  if (error === null || typeof error !== "object" || isProxy(error) || !isNativeError(error))
    return freeze({ errorClass: FailureClass.Unknown, fixedLiteral: FailureLiteral.Unknown });
  let fixedLiteral = FailureLiteral.Unknown;
  switch (ownString(error, "message")) {
    case "TEST_current_input_npm_version_failed": fixedLiteral = FailureLiteral.NpmVersion; break;
    case "TEST_current_input_pack_failed": fixedLiteral = FailureLiteral.Pack; break;
    case "TEST_current_input_lock_selection_failed": fixedLiteral = FailureLiteral.Lock; break;
    case "TEST_default_model_expectation_missing_or_invalid": fixedLiteral = FailureLiteral.Model; break;
  }
  if (fixedLiteral === FailureLiteral.Unknown && ownString(error, "code") === "ERR_ASSERTION")
    fixedLiteral = FailureLiteral.Assertion;
  return freeze({ errorClass: FailureClass.NativeError, fixedLiteral });
}

enum LockSignal { Unknown = "unknown", None = "none", Term = "sigterm", Kill = "sigkill", Abort = "sigabrt" }
enum LockSpawnClass { Unknown = "unknown", None = "none", NativeError = "native_error", TimeoutLiteral = "timeout_code_literal" }
enum LockCodeLiteral {
  Unknown = "unknown", Resolution = "resolution_code_literal", Connection = "connection_code_literal",
  Certificate = "certificate_code_literal", RegistryHttp = "registry_http_code_literal",
  Selection = "selection_code_literal", Input = "input_code_literal", Filesystem = "filesystem_code_literal",
}
enum LockCodeLineShape { Unknown = "unknown", Missing = "missing", SingleKnown = "single_known",
  SingleUnknown = "single_unknown", Malformed = "malformed", Duplicate = "duplicate" }
enum LockStderrShape { Unknown = "unknown", Unavailable = "unavailable", Empty = "empty", Present = "present" }
enum LockFixedText { Unknown = "unknown", ExitHandlerNotCalled = "exit_handler_not_called_literal" }
export type TestNpmLockObservation = Readonly<{
  status: number | null; signal: LockSignal; spawnClass: LockSpawnClass; npmCodeLiteral: LockCodeLiteral;
  codeLineShape: LockCodeLineShape; stderrShape: LockStderrShape; fixedTextLiteral: LockFixedText;
}>;
const unknownLock: TestNpmLockObservation = freeze({ status: null, signal: LockSignal.Unknown,
  spawnClass: LockSpawnClass.Unknown, npmCodeLiteral: LockCodeLiteral.Unknown,
  codeLineShape: LockCodeLineShape.Unknown, stderrShape: LockStderrShape.Unknown, fixedTextLiteral: LockFixedText.Unknown });
/** At most 4MiB scanned, at most two candidate lines examined. Unknown,
 * malformed or duplicate code lines remain Unknown, including identical ones. */
function lockCodeLiteral(code: string | undefined): LockCodeLiteral {
  switch (code) {
    case "EAI_AGAIN": case "ENOTFOUND": return LockCodeLiteral.Resolution;
    case "ECONNREFUSED": case "ECONNRESET": case "ETIMEDOUT": return LockCodeLiteral.Connection;
    case "CERT_HAS_EXPIRED": case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY": case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT": return LockCodeLiteral.Certificate;
    case "E401": case "E403": case "E404": case "E429": case "E500": case "E502": case "E503":
      return LockCodeLiteral.RegistryHttp;
    case "ETARGET": case "ERESOLVE": case "EBADENGINE": return LockCodeLiteral.Selection;
    case "EJSONPARSE": case "EINVALIDPACKAGENAME": case "EINVALIDTAGNAME": case "EUNSUPPORTEDPROTOCOL":
      return LockCodeLiteral.Input;
    case "ENOENT": case "EACCES": case "EPERM": case "ENOSPC": return LockCodeLiteral.Filesystem;
    default: return LockCodeLiteral.Unknown;
  }
}
function observeLockCodeLine(stderr: string): Readonly<{ npmCodeLiteral: LockCodeLiteral; codeLineShape: LockCodeLineShape }> {
  const lines = /^npm (?:error|ERR!) code[^\r\n]*\r?$/gm, first = lines.exec(stderr);
  if (!first) return { npmCodeLiteral: LockCodeLiteral.Unknown, codeLineShape: LockCodeLineShape.Missing };
  if (lines.exec(stderr)) return { npmCodeLiteral: LockCodeLiteral.Unknown, codeLineShape: LockCodeLineShape.Duplicate };
  const code = /^npm (?:error|ERR!) code ([A-Z0-9_]{1,40})\r?$/.exec(first[0])?.[1];
  if (code === undefined) return { npmCodeLiteral: LockCodeLiteral.Unknown, codeLineShape: LockCodeLineShape.Malformed };
  const npmCodeLiteral = lockCodeLiteral(code);
  return { npmCodeLiteral, codeLineShape: npmCodeLiteral === LockCodeLiteral.Unknown ?
    LockCodeLineShape.SingleUnknown : LockCodeLineShape.SingleKnown };
}
/** Exact npm10.9.9 exit-handler source literal, not its cause. Duplicate or
 * embedded/trailing/quoted text is not accepted; arbitrary stderr stays private. */
function lockFixedText(stderr: string): LockFixedText {
  const lines = /^npm (?:error|ERR!) Exit handler never called!\r?$/gm;
  return lines.exec(stderr) && !lines.exec(stderr) ? LockFixedText.ExitHandlerNotCalled : LockFixedText.Unknown;
}
/** Closed child-result DATA only. No raw output, pathname, errno object, env,
 * source authority, cause or retry permission is returned. */
export function observeTestNpmLockResult(result: unknown): TestNpmLockObservation {
  if (result === null || typeof result !== "object" || isProxy(result)) return unknownLock;
  const fields: unknown[] = [];
  for (const key of ["status", "signal", "stdout", "stderr", "error"] as const) {
    const own = descriptor(result, key);
    if (!own && key === "error") { fields.push(undefined); continue; }
    if (!own || !hasOwn(own, "value")) return unknownLock;
    fields.push(own.value);
  }
  const [status, signal, stdout, stderr, error] = fields;
  if (!(status === null || typeof status === "number" && Number.isSafeInteger(status) && status >= 0 && status <= 255) ||
      !(signal === null || typeof signal === "string" && signal.length <= 16) ||
      !(stdout === null || stdout === undefined || typeof stdout === "string") ||
      !(stderr === null || stderr === undefined || typeof stderr === "string") ||
      typeof stdout === "string" && stdout.length > 4 * 1024 * 1024 ||
      typeof stderr === "string" && stderr.length > 4 * 1024 * 1024) return unknownLock;
  let spawnClass: LockSpawnClass = error === undefined ? LockSpawnClass.None : LockSpawnClass.Unknown;
  if (error !== null && typeof error === "object" && !isProxy(error) && isNativeError(error))
    spawnClass = ownString(error, "code") === "ETIMEDOUT" ? LockSpawnClass.TimeoutLiteral : LockSpawnClass.NativeError;
  const signalClass = signal === null ? LockSignal.None : signal === "SIGTERM" ? LockSignal.Term :
    signal === "SIGKILL" ? LockSignal.Kill : signal === "SIGABRT" ? LockSignal.Abort : LockSignal.Unknown;
  const codeFacts = typeof stderr === "string" ? observeLockCodeLine(stderr) :
    { npmCodeLiteral: LockCodeLiteral.Unknown, codeLineShape: LockCodeLineShape.Unknown };
  const stderrShape = typeof stderr === "string" ? (stderr.length === 0 ? LockStderrShape.Empty : LockStderrShape.Present) : LockStderrShape.Unavailable;
  return freeze({ status, signal: signalClass, spawnClass, ...codeFacts, stderrShape,
    fixedTextLiteral: typeof stderr === "string" ? lockFixedText(stderr) : LockFixedText.Unknown });
}

enum AdministrativeSignal { Unknown = "unknown", None = "none", Term = "sigterm", Kill = "sigkill", Other = "other" }
enum AdministrativeSpawnError {
  Unknown = "unknown", None = "none", Timeout = "timeout_code_literal", Missing = "enoent_code_literal",
  Access = "eacces_code_literal", Buffer = "maxbuffer_code_literal", Other = "other_native_code",
}
enum AdministrativeStdout { Unknown = "unknown", ExactDenied = "exact_denied", Empty = "empty", Other = "other" }
enum AdministrativeStderr { Unknown = "unknown", Empty = "empty", Present = "present" }
enum AdministrativeTransientSuffix {
  Unknown = "unknown", NameUnprovided = "systemd_name_unprovided_literal", AccessDenied = "access_denied_literal",
  Interactive = "interactive_authorization_literal", FixedProperty = "fixed_property_read_only_literal",
  FixedUnitExists = "fixed_unit_exists_literal", InvalidUnit = "invalid_unit_literal",
  PolicySend = "dbus_rejected_send_rpc_shape", PolicyReceive = "dbus_rejected_receive_rpc_shape",
}
// Only properties actually emitted by this fixed systemd-run invocation.
const administrativeTransientProperties = ["Description", "CollectMode", "AddRef", "User", "Group",
  "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities", "ProtectSystem", "RuntimeMaxUSec",
  "WorkingDirectory", "Type", "StandardInputFileDescriptor", "StandardOutputFileDescriptor",
  "StandardErrorFileDescriptor", "ExecStart"] as const;
/** One complete RPC-error line only. Exact upstream suffixes and the fixed
 * StartTransientUnit rejection formatter are observations, never proven causes.
 * Unknown, duplicate, embedded, trailing or multiline text stays private. */
function administrativeTransientSuffix(stderr: string): AdministrativeTransientSuffix {
  const line = stderr.endsWith("\r\n") ? stderr.slice(0, -2) : stderr.endsWith("\n") ? stderr.slice(0, -1) : stderr;
  const prefix = "Failed to start transient service unit: ";
  if (line.length > 4096 || !line.startsWith(prefix) || /[\r\n]/.test(line)) return AdministrativeTransientSuffix.Unknown;
  const suffix = line.slice(prefix.length);
  switch (suffix) {
    case "The name org.freedesktop.systemd1 was not provided by any .service files": return AdministrativeTransientSuffix.NameUnprovided;
    case "Access denied": return AdministrativeTransientSuffix.AccessDenied;
    case "Interactive authentication required.": return AdministrativeTransientSuffix.Interactive;
    case "Unit TEST-administrative-forgery.service was already loaded or has a fragment file.": return AdministrativeTransientSuffix.FixedUnitExists;
    case "Invalid unit name or type.": return AdministrativeTransientSuffix.InvalidUnit;
  }
  if (administrativeTransientProperties.some(property => suffix === `Cannot set property ${property}, or unknown property.`))
    return AdministrativeTransientSuffix.FixedProperty;
  // DBus1.14.10 complain_about_message formatter. Private connection/loginfo
  // fields are bounded and discarded; the interface/member/destination are fixed.
  const policy = /^Rejected (send|receive) message, [0-9]{1,4} matched rules; type="method_call", sender=":[0-9]{1,10}\.[0-9]{1,10}" \([^\r\n]{1,1024}\) interface="org\.freedesktop\.systemd1\.Manager" member="StartTransientUnit" error name="\(unset\)" requested_reply="[01]" destination="org\.freedesktop\.systemd1" \([^\r\n]{1,1024}\)$/.exec(suffix);
  return policy?.[1] === "send" ? AdministrativeTransientSuffix.PolicySend :
    policy?.[1] === "receive" ? AdministrativeTransientSuffix.PolicyReceive : AdministrativeTransientSuffix.Unknown;
}
// Subset of existing common.setupDiagnostic/runtimeDiagnostic classes. Literal
// membership describes private captured text, never a cause or bus readiness.
const administrativeSetupClasses = ["error while loading shared libraries", "cannot open shared object file",
  "Failed to start transient service unit", "Failed to create bus connection", "Failed to connect to bus",
  "Failed to execute", "Failed at step", "ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "AssertionError"] as const;
export type TestAdministrativeCommandObservation = Readonly<{
  status: number | null; signal: AdministrativeSignal; spawnError: AdministrativeSpawnError;
  stdout: AdministrativeStdout; stderr: AdministrativeStderr; transientStartSuffix: AdministrativeTransientSuffix; stderrClasses: readonly (typeof administrativeSetupClasses)[number][];
}>;
const unknownAdministrativeCommand: TestAdministrativeCommandObservation = freeze({ status: null,
  signal: AdministrativeSignal.Unknown, spawnError: AdministrativeSpawnError.Unknown,
  stdout: AdministrativeStdout.Unknown, stderr: AdministrativeStderr.Unknown, transientStartSuffix: AdministrativeTransientSuffix.Unknown, stderrClasses: freeze([]) });
/** One bounded native command-result projection. Reject Proxy/accessor data
 * before reading it; no raw streams, error text, paths, stack or callbacks. */
export function observeTestAdministrativeCommandResult(result: unknown): TestAdministrativeCommandObservation {
  if (result === null || typeof result !== "object" || isProxy(result)) return unknownAdministrativeCommand;
  const fields: unknown[] = [];
  for (const key of ["status", "signal", "stdout", "stderr", "error"] as const) {
    const own = descriptor(result, key);
    if (!own && key === "error") { fields.push(undefined); continue; }
    if (!own || !hasOwn(own, "value")) return unknownAdministrativeCommand;
    fields.push(own.value);
  }
  const [status, signal, stdout, stderr, error] = fields;
  if (!(status === null || typeof status === "number" && Number.isSafeInteger(status) && status >= 0 && status <= 255) ||
      !(signal === null || typeof signal === "string" && signal.length <= 16) ||
      !(stdout === null || typeof stdout === "string" && stdout.length <= 16384) ||
      !(stderr === null || typeof stderr === "string" && stderr.length <= 16384)) return unknownAdministrativeCommand;
  let spawnError = error === undefined ? AdministrativeSpawnError.None : AdministrativeSpawnError.Unknown;
  if (error !== null && typeof error === "object" && !isProxy(error) && isNativeError(error)) {
    const code = descriptor(error, "code");
    if (code && hasOwn(code, "value") && typeof code.value === "string" && code.value.length <= 64) {
      switch (code.value) {
        case "ETIMEDOUT": spawnError = AdministrativeSpawnError.Timeout; break;
        case "ENOENT": spawnError = AdministrativeSpawnError.Missing; break;
        case "EACCES": spawnError = AdministrativeSpawnError.Access; break;
        case "ENOBUFS": case "ERR_CHILD_PROCESS_STDIO_MAXBUFFER": spawnError = AdministrativeSpawnError.Buffer; break;
        default: spawnError = AdministrativeSpawnError.Other;
      }
    }
  }
  return freeze({ status, signal: signal === null ? AdministrativeSignal.None : signal === "SIGTERM" ?
    AdministrativeSignal.Term : signal === "SIGKILL" ? AdministrativeSignal.Kill : AdministrativeSignal.Other,
    spawnError, stdout: stdout === null ? AdministrativeStdout.Unknown : stdout === "DENIED_ACTUAL_NATIVE_ORIGIN\n" ?
      AdministrativeStdout.ExactDenied : stdout === "" ? AdministrativeStdout.Empty : AdministrativeStdout.Other,
    stderr: stderr === null ? AdministrativeStderr.Unknown : stderr === "" ? AdministrativeStderr.Empty : AdministrativeStderr.Present,
    transientStartSuffix: typeof stderr === "string" ? administrativeTransientSuffix(stderr) : AdministrativeTransientSuffix.Unknown,
    stderrClasses: freeze(typeof stderr === "string" ? administrativeSetupClasses.filter(value => stderr.includes(value)) : []) });
}

/** Private DATA only for the reviewed auth-free first fixed TEST call. Short
 * words are not generically secret-safe; this must never serve authenticated FULL. */
export enum AdministrativeRpcCapture { Complete = "complete", Absent = "absent", Ambiguous = "ambiguous",
  Overflow = "overflow", Unavailable = "unavailable" }
enum RpcRedaction { Quoted = "quoted", LogInfo = "loginfo", Path = "path", Identifier = "identifier", Number = "number", Control = "control" }
enum RpcFormat { Sgr = "sgr", Embedded = "embedded_prefix", Multiline = "multiline" }
const rpcPrefix = "Failed to start transient service unit: ";
const rpcPlaceholders = Object.values(RpcRedaction).map(value => `[${value}]`);
const rpcPublic = [...administrativeTransientProperties, "org.freedesktop.systemd1", "org.freedesktop.systemd1.Manager",
  "org.freedesktop.DBus", "StartTransientUnit"] as readonly string[];
type RpcObservation = Readonly<{ capture: AdministrativeRpcCapture; status: number | null; signal: AdministrativeSignal;
  spawnError: AdministrativeSpawnError; candidateCount: number; reasonLines: readonly string[];
  redactions: readonly RpcRedaction[]; formats: readonly RpcFormat[] }>;
export type AdministrativeRpcDiagnostic = RpcObservation & Readonly<{ schemaVersion: 1;
  purpose: "TEST_first_fixed_auth_free_rpc_reason"; phase: "forged_application_launch"; sourceSha: string; machineId: string }>;
function rpcSpanEnd(text: string, start: number): number {
  const quote = text[start]; let end = start + 1;
  if (quote === '"' || quote === "'") {
    while (end < text.length) { if (text[end] === "\\") end += 2; else if (text[end++] === quote) break; } return end;
  }
  let depth = 1;
  while (end < text.length && depth) { if (text[end] === '"' || text[end] === "'") end = rpcSpanEnd(text, end);
    else { if (text[end] === "(") ++depth; if (text[end] === ")") --depth; ++end; } }
  return end;
}
/** Canonical grammar: single-space separated lowercase letter words1..24,
 * exact public literals, punctuation . , : ; ! ?, or the six placeholders. */
export function sanitizeAdministrativeRpcReason(text: string): string {
  if (Buffer.byteLength(text) > 16384) return "[identifier]";
  const tokens: string[] = []; let i = 0;
  while (i < text.length) {
    if (text[i] === " ") { ++i; continue; }
    const placeholder = rpcPlaceholders.find(value => text.startsWith(value, i));
    if (placeholder) { tokens.push(placeholder); i += placeholder.length; continue; }
    if (text[i] === '"' || text[i] === "'") { i = rpcSpanEnd(text, i); tokens.push("[quoted]"); continue; }
    if (text[i] === "(") { i = rpcSpanEnd(text, i); tokens.push("[loginfo]"); continue; }
    if (!/[\x20-\x7e]/.test(text[i]!)) { ++i; tokens.push("[control]"); continue; }
    const start = i; while (i < text.length && !/[\s"'()]/.test(text[i]!)) ++i;
    if (i === start) { ++i; tokens.push("[identifier]"); continue; }
    let token = text.slice(start, i); const punctuation: string[] = [];
    while (/[.,:;!?]$/.test(token)) { punctuation.unshift(token.slice(-1)); token = token.slice(0, -1); }
    if (token) tokens.push(/[\\/~@]/.test(token) ? "[path]" : token.includes("=") ? "[identifier]" :
      rpcPublic.includes(token) ? token : /^[0-9]+$/.test(token) ? "[number]" :
        /^[A-Za-z]{1,24}$/.test(token) ? token.toLowerCase() : "[identifier]");
    tokens.push(...punctuation);
  }
  return tokens.join(" ");
}
function rpcRedactions(lines: readonly string[]): readonly RpcRedaction[] {
  return freeze(Object.values(RpcRedaction).filter(value => lines.some(line => line.includes(`[${value}]`))));
}
/** Same actual first-result custody as finite metadata; no raw buffers leave. */
export function observeAdministrativeRpcReason(result: unknown): RpcObservation {
  const facts = observeTestAdministrativeCommandResult(result);
  const base = { status: facts.status, signal: facts.signal, spawnError: facts.spawnError };
  const empty = (capture: AdministrativeRpcCapture, count = 0): RpcObservation => freeze({ ...base, capture,
    candidateCount: count, reasonLines: freeze([]), redactions: freeze([]), formats: freeze([]) });
  if (!result || typeof result !== "object" || isProxy(result)) return empty(AdministrativeRpcCapture.Unavailable);
  const own = descriptor(result, "stderr");
  if (!own || !hasOwn(own, "value") || typeof own.value !== "string") return empty(AdministrativeRpcCapture.Unavailable);
  if (Buffer.byteLength(own.value) > 16384) return empty(AdministrativeRpcCapture.Overflow);
  if (!facts.status || facts.signal !== AdministrativeSignal.None || facts.spawnError !== AdministrativeSpawnError.None ||
      facts.stdout !== AdministrativeStdout.Empty) return empty(AdministrativeRpcCapture.Unavailable);
  const sgr = /\x1b\[[0-9;]{0,32}m/g, decorated = sgr.test(own.value), text = own.value.replace(sgr, "");
  const candidates: string[] = []; let embedded = false;
  const starts: number[] = [];
  for (let at = 0; at < text.length;) {
    if (text[at] === '"' || text[at] === "'" || text[at] === "(") { at = rpcSpanEnd(text, at); continue; }
    if ((at === 0 || /[ \t\r\n]/.test(text[at - 1]!)) && text.startsWith(rpcPrefix, at)) {
      starts.push(at); if (starts.length > 4) return empty(AdministrativeRpcCapture.Overflow, 5); at += rpcPrefix.length;
    } else ++at;
  }
  for (let index = 0; index < starts.length; ++index) { const at = starts[index]!, nextLine = text.indexOf("\n", at);
    embedded ||= at > 0 && text[at - 1] !== "\n";
    let end = Math.min(nextLine < 0 ? text.length : nextLine, starts[index + 1] ?? text.length);
    if (text[end - 1] === "\r") --end;
    candidates.push(sanitizeAdministrativeRpcReason(text.slice(at + rpcPrefix.length, end)));
  }
  if (!candidates.length) return empty(AdministrativeRpcCapture.Absent);
  const formats = freeze(Object.values(RpcFormat).filter(value => value === RpcFormat.Sgr ? decorated :
    value === RpcFormat.Embedded ? embedded : text.includes("\n") && text.trimEnd().includes("\n")));
  return freeze({ ...base, capture: candidates.length === 1 ? AdministrativeRpcCapture.Complete : AdministrativeRpcCapture.Ambiguous,
    candidateCount: candidates.length, reasonLines: freeze(candidates), redactions: rpcRedactions(candidates), formats });
}
export function sealAdministrativeRpcDiagnostic(observation: RpcObservation, sourceSha: string, machineId: string): AdministrativeRpcDiagnostic {
  const packet: AdministrativeRpcDiagnostic = freeze({ schemaVersion: 1, purpose: "TEST_first_fixed_auth_free_rpc_reason",
    phase: "forged_application_launch", sourceSha, machineId, ...observation });
  if (Buffer.byteLength(JSON.stringify(packet) + "\n") <= 4096) return packet;
  return freeze({ ...packet, capture: AdministrativeRpcCapture.Overflow, candidateCount: 0,
    reasonLines: freeze([]), redactions: freeze([]), formats: freeze([]) });
}
/** Independent private-reader normal-form validation; never trust a guest flag. */
export function validateAdministrativeRpcDiagnostic(value: unknown, sourceSha: string, machineId: string): value is AdministrativeRpcDiagnostic {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || typeof sourceSha !== "string" || typeof machineId !== "string") return false;
  const keys = ["schemaVersion", "purpose", "phase", "sourceSha", "machineId", "capture", "status", "signal", "spawnError",
    "candidateCount", "reasonLines", "redactions", "formats"];
  if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).sort().join(",") !== [...keys].sort().join(",")) return false;
  const row: Record<string, unknown> = {};
  for (const key of keys) { const own = descriptor(value, key); if (!own || !hasOwn(own, "value")) return false; row[key] = own.value; }
  const canonicalArray = (input: unknown, allowed: readonly string[]): input is readonly string[] => {
    if (isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length || input.length > allowed.length) return false;
    for (let i = 0; i < input.length; ++i) { const own = descriptor(input, String(i)); if (!own || !hasOwn(own, "value") ||
      typeof own.value !== "string" || !allowed.includes(own.value) || (i > 0 && allowed.indexOf(input[i - 1]) >= allowed.indexOf(own.value))) return false; }
    return Object.getOwnPropertyNames(input).sort().join(",") === [...Array.from({ length: input.length }, (_, i) => String(i)), "length"].sort().join(",");
  };
  if (row.schemaVersion !== 1 || row.purpose !== "TEST_first_fixed_auth_free_rpc_reason" || row.phase !== "forged_application_launch" ||
      !/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{32}$/.test(machineId) || row.sourceSha !== sourceSha || row.machineId !== machineId ||
      !Object.values(AdministrativeRpcCapture).includes(row.capture as AdministrativeRpcCapture) ||
      !(row.status === null || typeof row.status === "number" && Number.isSafeInteger(row.status) && row.status >= 0 && row.status <= 255) ||
      !Object.values(AdministrativeSignal).includes(row.signal as AdministrativeSignal) ||
      !Object.values(AdministrativeSpawnError).includes(row.spawnError as AdministrativeSpawnError) ||
      typeof row.candidateCount !== "number" || !Number.isSafeInteger(row.candidateCount) || row.candidateCount < 0 || row.candidateCount > 5 ||
      !canonicalArray(row.redactions, Object.values(RpcRedaction)) || !canonicalArray(row.formats, Object.values(RpcFormat)) ||
      isProxy(row.reasonLines) || !Array.isArray(row.reasonLines) || Object.getPrototypeOf(row.reasonLines) !== Array.prototype || Object.getOwnPropertySymbols(row.reasonLines).length || row.reasonLines.length > 4) return false;
  const lines: string[] = [];
  for (let i = 0; i < row.reasonLines.length; ++i) { const own = descriptor(row.reasonLines, String(i));
    if (!own || !hasOwn(own, "value") || typeof own.value !== "string" || Buffer.byteLength(own.value) > 4096 ||
        /[^\x20-\x7e]/.test(own.value) || own.value.includes("failed to start transient service unit") ||
        sanitizeAdministrativeRpcReason(own.value) !== own.value) return false; lines.push(own.value); }
  if (Object.getOwnPropertyNames(row.reasonLines).sort().join(",") !== [...lines.map((_, i) => String(i)), "length"].sort().join(",") ||
      JSON.stringify(row.redactions) !== JSON.stringify(rpcRedactions(lines))) return false;
  const count = row.candidateCount;
  if (!lines.length && row.formats.length !== 0) return false;
  if (row.capture === AdministrativeRpcCapture.Complete ? count !== 1 || lines.length !== 1 :
      row.capture === AdministrativeRpcCapture.Ambiguous ? count < 2 || count > 4 || lines.length !== count :
        lines.length !== 0 || (row.capture !== AdministrativeRpcCapture.Overflow && count !== 0)) return false;
  if (row.capture === AdministrativeRpcCapture.Complete || row.capture === AdministrativeRpcCapture.Ambiguous || row.capture === AdministrativeRpcCapture.Absent)
    if (!row.status || row.signal !== AdministrativeSignal.None || row.spawnError !== AdministrativeSpawnError.None) return false;
  return Buffer.byteLength(JSON.stringify(row) + "\n") <= 4096;
}
