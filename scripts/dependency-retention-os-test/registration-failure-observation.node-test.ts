/** Independent privacy contract: unsafe observations stay opaque, trap-free
 * and finite; the positive literals describe source failure text, never authority. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { observeRegistrationFailure, observeTestNpmLockResult } from "./registration-failure-observation.js";

test("closed observations drop arbitrary text and non-native counterfeits", () => {
  const secret = "TEST-secret-path-token-not-for-evidence";
  const actual = observeRegistrationFailure(new Error(secret, { cause: { secret } }));
  assert.deepEqual(actual, { errorClass: "native_error", fixedLiteral: "unknown" });
  assert(!JSON.stringify(actual).includes(secret));
  assert(Object.isFrozen(actual));
  for (const input of [null, undefined, secret, 42, { message: "TEST_current_input_pack_failed" }])
    assert.deepEqual(observeRegistrationFailure(input), { errorClass: "unknown", fixedLiteral: "unknown" });
  assert.deepEqual(observeRegistrationFailure(new Error("x".repeat(97))),
    { errorClass: "native_error", fixedLiteral: "unknown" });
});

test("own data literals and assertion-code observations remain distinct", () => {
  const cases = [
    ["TEST_current_input_npm_version_failed", "fixed_npm_version_failure_literal"],
    ["TEST_current_input_pack_failed", "fixed_pack_failure_literal"],
    ["TEST_current_input_lock_selection_failed", "fixed_lock_selection_failure_literal"],
    ["TEST_default_model_expectation_missing_or_invalid", "fixed_model_expectation_failure_literal"],
  ] as const;
  for (const [message, fixedLiteral] of cases)
    assert.deepEqual(observeRegistrationFailure(new Error(message)), { errorClass: "native_error", fixedLiteral });
  const failure = new assert.AssertionError({ actual: "TEST-secret", expected: "different", operator: "strictEqual" });
  assert.deepEqual(observeRegistrationFailure(failure), { errorClass: "native_error", fixedLiteral: "assertion_code_literal" });
});

test("Proxy, revoked Proxy, accessor and inherited literals make zero caller calls", () => {
  let calls = 0;
  const trap = (): never => { ++calls; throw new Error("TEST-unexpected-caller-call"); };
  const proxy = new Proxy(new Error("TEST_current_input_pack_failed"),
    { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable(new Error("TEST_current_input_pack_failed"), {}); revoked.revoke();
  for (const input of [proxy, revoked.proxy])
    assert.deepEqual(observeRegistrationFailure(input), { errorClass: "unknown", fixedLiteral: "unknown" });
  const accessors = new Error();
  Object.defineProperty(accessors, "stack", { value: undefined, configurable: true });
  for (const key of ["message", "code", "name", "stack", "cause", "toJSON"])
    Object.defineProperty(accessors, key, { get: trap, configurable: true });
  assert.deepEqual(observeRegistrationFailure(accessors), { errorClass: "native_error", fixedLiteral: "unknown" });
  const inherited = new Error();
  Object.setPrototypeOf(inherited, Object.create(null, {
    message: { get: trap }, code: { get: trap }, toJSON: { get: trap },
  }));
  assert.deepEqual(observeRegistrationFailure(inherited), { errorClass: "native_error", fixedLiteral: "unknown" });
  const counterfeit = Object.create(null, { message: { get: trap }, code: { get: trap } });
  assert.deepEqual(observeRegistrationFailure(counterfeit), { errorClass: "unknown", fixedLiteral: "unknown" });
  assert.equal(calls, 0);
});

test("lock observation distinguishes finite child facts without copying output", () => {
  const secret = "TEST-credential-path-not-for-lock-evidence";
  const result = { status: 1, signal: null, stdout: secret,
    stderr: "npm error code EAI_AGAIN\nnpm error request " + secret + " failed\n" };
  const observed = observeTestNpmLockResult(result);
  assert.deepEqual(observed, { status: 1, signal: "none", spawnClass: "none", npmCodeLiteral: "resolution_code_literal" });
  assert(!JSON.stringify(observed).includes(secret)); assert(Object.isFrozen(observed));
  for (const [code, literal] of [["ECONNRESET", "connection_code_literal"], ["CERT_HAS_EXPIRED", "certificate_code_literal"],
    ["E403", "registry_http_code_literal"], ["ERESOLVE", "selection_code_literal"], ["EJSONPARSE", "input_code_literal"],
    ["ENOENT", "filesystem_code_literal"]] as const)
    assert.equal(observeTestNpmLockResult({ ...result, stderr: "npm error code " + code + "\n" }).npmCodeLiteral, literal);
  const timeout = new Error(secret); Object.defineProperty(timeout, "code", { value: "ETIMEDOUT" });
  assert.deepEqual(observeTestNpmLockResult({ ...result, status: null, signal: "SIGTERM", stderr: "", error: timeout }),
    { status: null, signal: "sigterm", spawnClass: "timeout_code_literal", npmCodeLiteral: "unknown" });
  for (const absent of [null, undefined])
    assert.deepEqual(observeTestNpmLockResult({ ...result, status: null, signal: null, stdout: absent, stderr: absent, error: timeout }),
      { status: null, signal: "none", spawnClass: "timeout_code_literal", npmCodeLiteral: "unknown" });
});

test("lock code lines are single, exact, bounded and never causal proof", () => {
  const result = { status: 1, signal: null, stdout: "", stderr: "" };
  for (const stderr of ["", "npm error code TEST_SECRET", "prefix npm error code EAI_AGAIN\n",
    "npm error code EAI_AGAIN trailing\n", "npm error code EAI_AGAIN\nnpm error code EAI_AGAIN\n",
    "npm error code EAI_AGAIN\nnpm error code UNKNOWN\n", "npm error code EAI_AGAIN\nnpm error code malformed value\n"])
    assert.equal(observeTestNpmLockResult({ ...result, stderr }).npmCodeLiteral, "unknown");
  const oversized = observeTestNpmLockResult({ ...result, stderr: "x".repeat(4 * 1024 * 1024 + 1) });
  assert.deepEqual(oversized, { status: null, signal: "unknown", spawnClass: "unknown", npmCodeLiteral: "unknown" });
  for (const status of [-1, 256, NaN, Infinity]) assert.equal(observeTestNpmLockResult({ ...result, status }).status, null);
});

test("lock-result accessors and Proxy values cause zero caller calls", () => {
  let calls = 0;
  const trap = (): never => { ++calls; throw new Error("TEST-caller-not-to-be-run"); };
  const result = { status: 1, signal: null, stdout: "", stderr: "npm error code EAI_AGAIN\n" };
  const proxy = new Proxy(result, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable(result, {}); revoked.revoke();
  for (const input of [proxy, revoked.proxy, null, {}, Object.create(result)])
    assert.deepEqual(observeTestNpmLockResult(input), { status: null, signal: "unknown", spawnClass: "unknown", npmCodeLiteral: "unknown" });
  for (const key of ["status", "signal", "stdout", "stderr", "error"]) {
    const accessor = { ...result }; Object.defineProperty(accessor, key, { get: trap });
    assert.deepEqual(observeTestNpmLockResult(accessor), { status: null, signal: "unknown", spawnClass: "unknown", npmCodeLiteral: "unknown" });
  }
  const error = new Error(); Object.defineProperty(error, "code", { get: trap });
  assert.equal(observeTestNpmLockResult({ ...result, error }).spawnClass, "native_error");
  assert.equal(observeTestNpmLockResult({ ...result, error: new Proxy(error, { get: trap, getOwnPropertyDescriptor: trap }) }).spawnClass, "unknown");
  assert.equal(calls, 0);
});
