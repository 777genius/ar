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
