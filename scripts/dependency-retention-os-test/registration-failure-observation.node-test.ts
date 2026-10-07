/** Independent privacy contract: unsafe observations stay opaque, trap-free
 * and finite; the positive literals describe source failure text, never authority. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { observeRegistrationFailure } from "./registration-failure-observation.js";

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
