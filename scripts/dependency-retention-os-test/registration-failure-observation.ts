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
