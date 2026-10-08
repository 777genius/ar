/** Independent privacy contract: unsafe observations stay opaque, trap-free
 * and finite; the positive literals describe source failure text, never authority. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupNpmPublicSourcePart0 } from "./registration-npm-public-catalog-0.js";
import { lookupNpmPublicSourcePart1 } from "./registration-npm-public-catalog-1.js";
import { observePinnedTestNpmFrame, observePublicTestNpmFrame } from "./registration-npm-frame-observation.js";
import { AdministrativeRpcCapture, observeAdministrativeRpcReason, sanitizeAdministrativeRpcReason, sealAdministrativeRpcDiagnostic, validateAdministrativeRpcDiagnostic, observeRegistrationFailure, observeTestAdministrativeCommandResult, observeTestNpmLockResult } from "./registration-failure-observation.js";

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

test("fixed administrative result keeps bounded facts and drops private captured text", () => {
  const secret = "TEST-private-command-path-token", result = { status: 1, signal: null, stdout: secret,
    stderr: "Failed to start transient service unit: " + secret };
  const observed = observeTestAdministrativeCommandResult(result);
  assert.deepEqual(observed, { status: 1, signal: "none", spawnError: "none", stdout: "other",
    stderr: "present", transientStartSuffix: "unknown", stderrClasses: ["Failed to start transient service unit"] });
  assert(!JSON.stringify(observed).includes(secret)); assert(Object.isFrozen(observed)); assert(Object.isFrozen(observed.stderrClasses));
  assert.equal(observeTestAdministrativeCommandResult({ ...result, stdout: "DENIED_ACTUAL_NATIVE_ORIGIN\n" }).stdout, "exact_denied");
  assert.equal(observeTestAdministrativeCommandResult({ ...result, stdout: "", stderr: "" }).stdout, "empty");
  for (const [code, expected] of [["ETIMEDOUT", "timeout_code_literal"], ["ENOENT", "enoent_code_literal"],
    ["EACCES", "eacces_code_literal"], ["ENOBUFS", "maxbuffer_code_literal"], ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "maxbuffer_code_literal"],
    ["TEST_UNKNOWN", "other_native_code"]] as const) {
    const error = new Error(secret); Object.defineProperty(error, "code", { value: code });
    const actual = observeTestAdministrativeCommandResult({ ...result, status: null, signal: "SIGTERM", error });
    assert.equal(actual.spawnError, expected); assert.equal(actual.signal, "sigterm"); assert.equal(actual.status, null);
    assert(!JSON.stringify(actual).includes(secret));
  }
  assert.equal(observeTestAdministrativeCommandResult({ ...result, signal: "SIGKILL" }).signal, "sigkill");
  assert.equal(observeTestAdministrativeCommandResult({ ...result, signal: "SIGABRT" }).signal, "other");
  const unknown = observeTestAdministrativeCommandResult(null);
  for (const changed of [{ status: 256 }, { status: -1 }, { status: 0.5 }, { stdout: "x".repeat(16385) }, { stderr: "x".repeat(16385) }])
    assert.deepEqual(observeTestAdministrativeCommandResult({ ...result, ...changed }), unknown);
});

// This catches a privacy regression that exports raw RPC error text, or a
// diagnostic regression that confuses duplicates/foreign-target errors with this RPC.
test("transient RPC suffixes distinguish closed literals without releasing private loginfo", () => {
  const prefix = "Failed to start transient service unit: ", secret = "TEST-private-actor-path-token";
  const result = { status: 1, signal: null, stdout: "", stderr: "" };
  const cases = [
    ["The name org.freedesktop.systemd1 was not provided by any .service files", "systemd_name_unprovided_literal"],
    ["Access denied", "access_denied_literal"], ["Interactive authentication required.", "interactive_authorization_literal"],
    ["Cannot set property RuntimeMaxUSec, or unknown property.", "fixed_property_read_only_literal"],
    ["Cannot set property StandardOutputFileDescriptor, or unknown property.", "fixed_property_read_only_literal"],
    ["Unit TEST-administrative-forgery.service was already loaded or has a fragment file.", "fixed_unit_exists_literal"],
    ["Invalid unit name or type.", "invalid_unit_literal"],
  ] as const;
  for (const [suffix, expected] of cases) for (const newline of ["", "\n", "\r\n"])
    assert.equal(observeTestAdministrativeCommandResult({ ...result, stderr: prefix + suffix + newline }).transientStartSuffix, expected);
  const policy = 'Rejected send message, 0 matched rules; type="method_call", sender=":1.7" (uid=0 pid=9 comm="' + secret +
    '") interface="org.freedesktop.systemd1.Manager" member="StartTransientUnit" error name="(unset)" requested_reply="0" destination="org.freedesktop.systemd1" (uid=0 pid=1 comm="' + secret + '")';
  const observed = observeTestAdministrativeCommandResult({ ...result, stderr: prefix + policy + "\n" });
  assert.equal(observed.transientStartSuffix, "dbus_rejected_send_rpc_shape");
  assert(!JSON.stringify(observed).includes(secret)); assert(!JSON.stringify(observed).includes("pid="));
  assert.equal(observeTestAdministrativeCommandResult({ ...result, stderr: prefix + policy.replace("send message", "receive message") }).transientStartSuffix,
    "dbus_rejected_receive_rpc_shape");
  for (const stderr of [prefix + secret, "embedded " + prefix + "Access denied\n", prefix + "Access denied trailing\n",
    prefix + "Access denied\n" + prefix + "Access denied\n", prefix + "Access denied\n" + secret,
    prefix + "Cannot set property TEST_PRIVATE, or unknown property.",
    prefix + "The name org.TEST.private was not provided by any .service files",
    prefix + policy.replace('member="StartTransientUnit"', 'member="TEST_PRIVATE"'),
    prefix + policy.replace('destination="org.freedesktop.systemd1"', 'destination="org.TEST.private"'),
    prefix + policy + " trailing", prefix + policy.replace(secret, "x".repeat(1025)),
    prefix + "x".repeat(4097), "\u001b[31m" + prefix + "Access denied\u001b[0m"])
    assert.equal(observeTestAdministrativeCommandResult({ ...result, stderr }).transientStartSuffix, "unknown");
});

// Closest private artifact contract: raw text never passes the reader, and an
// envelope/duplicate/unsafe-shape regression must not release a partial reason.
test("first fixed auth-free RPC packet has an independently checked canonical private form", () => {
  const source = "1".repeat(40), machine = "2".repeat(32), prefix = "Failed to start transient service unit: ";
  const secret = "TEST_PRIVATE_PATH_TOKEN", native = { status: 1, signal: null, stdout: "", stderr: "" };
  const packet = (stderr: string) => sealAdministrativeRpcDiagnostic(observeAdministrativeRpcReason({ ...native, stderr }), source, machine);
  const actual = packet("\u001b[31m" + prefix + 'Unable to enqueue "' + secret + '": transaction dependency failed (uid=0 pid=9 comm="' + secret +
    '"). Invalid descriptor 29 at /TEST/' + secret + '; request=' + secret + '. org.freedesktop.systemd1.Manager NoNewPrivileges\u001b[0m\n');
  assert.equal(actual.capture, AdministrativeRpcCapture.Complete);
  assert(actual.reasonLines[0]?.includes("transaction dependency failed"));
  assert(actual.reasonLines[0]?.includes("org.freedesktop.systemd1.Manager NoNewPrivileges"));
  assert(actual.reasonLines[0]?.includes("[quoted]")); assert(actual.reasonLines[0]?.includes("[loginfo]"));
  assert(actual.reasonLines[0]?.includes("[path]")); assert(actual.reasonLines[0]?.includes("[number]"));
  assert(!JSON.stringify(actual).includes(secret)); assert(!JSON.stringify(actual).includes("uid="));
  assert(validateAdministrativeRpcDiagnostic(actual, source, machine));
  const parsed: unknown = JSON.parse(JSON.stringify(actual)); assert(validateAdministrativeRpcDiagnostic(parsed, source, machine));
  for (const line of actual.reasonLines) assert.equal(sanitizeAdministrativeRpcReason(line), line);
  assert.equal(packet("private non-RPC error").capture, AdministrativeRpcCapture.Absent);
  // A quoted/loginfo prefix is private field DATA, never an RPC candidate.
  for (const stderr of ['sender="' + prefix + 'secretword"', 'sender="private\n' + prefix + 'secretword"', 'error (comm="' + prefix + 'secretword")', 'error (private\n' + prefix + 'secretword)', '/TEST/' + prefix + 'secretword', 'request=' + prefix + 'secretword'])
    assert.equal(packet(stderr).capture, AdministrativeRpcCapture.Absent);
  const spoofedInside = packet(prefix + 'Access denied (comm="' + prefix + 'secretword")');
  assert.equal(spoofedInside.capture, AdministrativeRpcCapture.Complete);
  assert(!JSON.stringify(spoofedInside).includes("secretword"));
  const duplicate = packet(prefix + "Access denied\n" + prefix + "Invalid argument\n");
  assert.equal(duplicate.capture, AdministrativeRpcCapture.Ambiguous); assert.equal(duplicate.candidateCount, 2);
  assert(validateAdministrativeRpcDiagnostic(duplicate, source, machine));
  for (const stderr of [(prefix + "Access denied\n").repeat(5), prefix + "x".repeat(16385), prefix + "é".repeat(9000)]) {
    const overflow = packet(stderr); assert.equal(overflow.capture, AdministrativeRpcCapture.Overflow); assert.deepEqual(overflow.reasonLines, []);
    assert(validateAdministrativeRpcDiagnostic(overflow, source, machine));
  }
  const boundedReason = observeAdministrativeRpcReason({ ...native, stderr: prefix + "dependency ".repeat(350) });
  assert.equal(boundedReason.capture, AdministrativeRpcCapture.Complete); assert(boundedReason.reasonLines[0]!.length < 4096);
  const overflow = sealAdministrativeRpcDiagnostic(boundedReason, source, machine);
  assert.equal(overflow.capture, AdministrativeRpcCapture.Overflow); assert.deepEqual(overflow.reasonLines, []);
  assert(Buffer.byteLength(JSON.stringify(overflow) + "\n") <= 4096);
  const oversizeEnvelope = { ...actual, ...boundedReason };
  assert.equal(validateAdministrativeRpcDiagnostic(oversizeEnvelope, source, machine), false);
  for (const reason of ['/TEST/' + secret, '(comm="' + secret + '")', '"' + secret + '"', secret, "é", "\u001b[31maccess denied", "failed to start transient service unit : access denied"])
    assert.equal(validateAdministrativeRpcDiagnostic({ ...actual, reasonLines: [reason] }, source, machine), false);
  assert.equal(validateAdministrativeRpcDiagnostic(actual, "3".repeat(40), machine), false);
  assert.equal(validateAdministrativeRpcDiagnostic({ ...actual, capture: "private" }, source, machine), false);
  let calls = 0; const trap = (): never => { ++calls; throw new Error("TEST-caller-trap"); };
  const proxy = new Proxy(native, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  assert.equal(observeAdministrativeRpcReason(proxy).capture, AdministrativeRpcCapture.Unavailable);
  assert.equal(validateAdministrativeRpcDiagnostic(new Proxy(actual, { ownKeys: trap, getOwnPropertyDescriptor: trap }), source, machine), false);
  assert.equal(validateAdministrativeRpcDiagnostic({ ...actual, redactions: revoked.proxy }, source, machine), false);
  const accessor = { ...actual }; Object.defineProperty(accessor, "reasonLines", { get: trap });
  assert.equal(validateAdministrativeRpcDiagnostic(accessor, source, machine), false);
  const active = [...actual.reasonLines]; Object.defineProperty(active, "toJSON", { get: trap });
  assert.equal(validateAdministrativeRpcDiagnostic({ ...actual, reasonLines: active }, source, machine), false); assert.equal(calls, 0);
});

test("administrative result rejects accessor Proxy and counterfeit errno without caller calls", () => {
  let calls = 0; const trap = (): never => { ++calls; throw new Error("TEST-caller-trap"); };
  const result = { status: 0, signal: null, stdout: "", stderr: "" };
  const unknown = observeTestAdministrativeCommandResult(null);
  const proxy = new Proxy(result, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable(result, {}); revoked.revoke();
  const accessors = Object.create(null); for (const key of ["status", "signal", "stdout", "stderr", "error"])
    Object.defineProperty(accessors, key, { get: trap });
  for (const value of [proxy, revoked.proxy, accessors]) assert.deepEqual(observeTestAdministrativeCommandResult(value), unknown);
  const native = new Error(); Object.defineProperty(native, "code", { get: trap });
  for (const error of [native, { code: "ETIMEDOUT" }, new Proxy(new Error(), { getOwnPropertyDescriptor: trap, get: trap })])
    assert.equal(observeTestAdministrativeCommandResult({ ...result, error }).spawnError, "unknown");
  assert.equal(calls, 0);
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
  assert.deepEqual(observed, { status: 1, signal: "none", spawnClass: "none", npmCodeLiteral: "resolution_code_literal",
    codeLineShape: "single_known", stderrShape: "present", fixedTextLiteral: "unknown" });
  assert(!JSON.stringify(observed).includes(secret)); assert(Object.isFrozen(observed));
  for (const [code, literal] of [["ECONNRESET", "connection_code_literal"], ["CERT_HAS_EXPIRED", "certificate_code_literal"],
    ["E403", "registry_http_code_literal"], ["ERESOLVE", "selection_code_literal"], ["EJSONPARSE", "input_code_literal"],
    ["ENOENT", "filesystem_code_literal"]] as const)
    assert.equal(observeTestNpmLockResult({ ...result, stderr: "npm error code " + code + "\n" }).npmCodeLiteral, literal);
  const timeout = new Error(secret); Object.defineProperty(timeout, "code", { value: "ETIMEDOUT" });
  assert.deepEqual(observeTestNpmLockResult({ ...result, status: null, signal: "SIGTERM", stderr: "", error: timeout }),
    { status: null, signal: "sigterm", spawnClass: "timeout_code_literal", npmCodeLiteral: "unknown",
      codeLineShape: "missing", stderrShape: "empty", fixedTextLiteral: "unknown" });
  for (const absent of [null, undefined])
    assert.deepEqual(observeTestNpmLockResult({ ...result, status: null, signal: null, stdout: absent, stderr: absent, error: timeout }),
      { status: null, signal: "none", spawnClass: "timeout_code_literal", npmCodeLiteral: "unknown",
        codeLineShape: "unknown", stderrShape: "unavailable", fixedTextLiteral: "unknown" });
});

test("lock code lines are single, exact, bounded and never causal proof", () => {
  const result = { status: 1, signal: null, stdout: "", stderr: "" };
  for (const stderr of ["", "npm error code TEST_SECRET", "prefix npm error code EAI_AGAIN\n",
    "npm error code EAI_AGAIN trailing\n", "npm error code EAI_AGAIN\nnpm error code EAI_AGAIN\n",
    "npm error code EAI_AGAIN\nnpm error code UNKNOWN\n", "npm error code EAI_AGAIN\nnpm error code malformed value\n"])
    assert.equal(observeTestNpmLockResult({ ...result, stderr }).npmCodeLiteral, "unknown");
  const oversized = observeTestNpmLockResult({ ...result, stderr: "x".repeat(4 * 1024 * 1024 + 1) });
  assert.deepEqual(oversized, { status: null, signal: "unknown", spawnClass: "unknown", npmCodeLiteral: "unknown",
      codeLineShape: "unknown", stderrShape: "unknown", fixedTextLiteral: "unknown" });
  for (const status of [-1, 256, NaN, Infinity]) assert.equal(observeTestNpmLockResult({ ...result, status }).status, null);
});

test("lock-result accessors and Proxy values cause zero caller calls", () => {
  let calls = 0;
  const trap = (): never => { ++calls; throw new Error("TEST-caller-not-to-be-run"); };
  const result = { status: 1, signal: null, stdout: "", stderr: "npm error code EAI_AGAIN\n" };
  const proxy = new Proxy(result, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable(result, {}); revoked.revoke();
  for (const input of [proxy, revoked.proxy, null, {}, Object.create(result)])
    assert.deepEqual(observeTestNpmLockResult(input), { status: null, signal: "unknown", spawnClass: "unknown", npmCodeLiteral: "unknown",
      codeLineShape: "unknown", stderrShape: "unknown", fixedTextLiteral: "unknown" });
  for (const key of ["status", "signal", "stdout", "stderr", "error"]) {
    const accessor = { ...result }; Object.defineProperty(accessor, key, { get: trap });
    assert.deepEqual(observeTestNpmLockResult(accessor), { status: null, signal: "unknown", spawnClass: "unknown", npmCodeLiteral: "unknown",
      codeLineShape: "unknown", stderrShape: "unknown", fixedTextLiteral: "unknown" });
  }
  const error = new Error(); Object.defineProperty(error, "code", { get: trap });
  assert.equal(observeTestNpmLockResult({ ...result, error }).spawnClass, "native_error");
  assert.equal(observeTestNpmLockResult({ ...result, error: new Proxy(error, { get: trap, getOwnPropertyDescriptor: trap }) }).spawnClass, "unknown");
  assert.equal(calls, 0);
});

test("stderr distinguishes missing, unknown, malformed and duplicate code-line shapes", () => {
  const result = { status: 1, signal: null, stdout: "", stderr: "" };
  const cases = [["", "missing"], ["npm error code EAI_AGAIN\n", "single_known"],
    ["npm error code TEST_SECRET\n", "single_unknown"], ["npm error code EAI_AGAIN trailing\n", "malformed"],
    ["npm error code EAI_AGAIN\nnpm error code EAI_AGAIN\n", "duplicate"],
    ["npm error code EAI_AGAIN\nnpm error code malformed value\n", "duplicate"]] as const;
  for (const [stderr, codeLineShape] of cases) {
    const observed = observeTestNpmLockResult({ ...result, stderr });
    assert.equal(observed.codeLineShape, codeLineShape);
    assert(!JSON.stringify(observed).includes("TEST_SECRET"));
  }
  assert.equal(observeTestNpmLockResult(result).stderrShape, "empty");
  assert.equal(observeTestNpmLockResult({ ...result, stderr: "TEST-private" }).stderrShape, "present");
});

test("only one exact pinned exit-handler line has a fixed-text observation", () => {
  const literal = "npm error Exit handler never called!\n", secret = "TEST-private-registry-path";
  const result = { status: 1, signal: null, stdout: secret, stderr: literal + "npm error " + secret + "\n" };
  const observed = observeTestNpmLockResult(result);
  assert.equal(observed.fixedTextLiteral, "exit_handler_not_called_literal");
  assert.equal(observed.codeLineShape, "missing");
  assert(!JSON.stringify(observed).includes(secret)); assert(Object.isFrozen(observed));
  for (const stderr of ["", "prefix " + literal, literal.trimEnd() + " trailing\n", literal + literal,
    "npm error 'Exit handler never called!'\n"])
    assert.equal(observeTestNpmLockResult({ ...result, stderr }).fixedTextLiteral, "unknown");
  assert.equal(observeTestNpmLockResult({ ...result, stdout: literal, stderr: "" }).fixedTextLiteral, "unknown");
});


test("one first pinned vendor frame narrows source without disclosing its message or function", () => {
  const secret = "TEST-private-token-path", root = "/opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/npm/";
  const stderr = "npm verbose stack TypeError: " + secret + "\n" +
    "npm verbose stack     at secretFunction (" + root + "node_modules/@npmcli/arborist/lib/arborist/build-ideal-tree.js:731:12)\n";
  const observed = observePinnedTestNpmFrame(stderr);
  assert.deepEqual(observed, { channel: "npm_verbose_stack", errorClass: "type_error_header", module: "arborist_ideal_tree", line: 731 });
  const serialized = JSON.stringify(observed);
  for (const text of [secret, "secretFunction", root, "build-ideal-tree.js"])
    assert(!serialized.includes(text));
  assert(Object.isFrozen(observed));
  assert.equal(observePinnedTestNpmFrame("TypeError: " + secret + "\n    at " + root + "lib/npm.js:301:4\n").channel, "unprefixed_stack");
});

test("unknown first frames are never skipped and ambiguous or unsafe stacks remain opaque", () => {
  const root = "/opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/npm/";
  const header = "npm verbose stack Error: TEST-secret\n", known = "npm verbose stack     at " + root + "lib/npm.js:301:4\n";
  const unknown = observePinnedTestNpmFrame(header + "npm verbose stack     at /TEST-private.js:1:1\n" + known);
  assert.equal(unknown.module, "unknown"); assert.equal(unknown.line, null);
  for (const stderr of [header + known + header + known, header + "not a frame\n" + known,
    "npm verbose stack CustomError: TEST-secret\n" + known,
    "npm verbose stack CustomError: TEST-secret\n" + known + header + known,
    "npm verbose stack " + "X".repeat(65) + ": TEST-secret\n" + known + header + known,
    "npm verbose stack Odd Class!: TEST-secret\n" + known + header + known,
    "npm verbose stackCustomError: TEST-secret\n" + known + header + known,
    "X".repeat(65) + ": TEST-secret\n    at /TEST-private.js:1:1\n" + header + known, "x".repeat(4 * 1024 * 1024 + 1)])
    assert.deepEqual(observePinnedTestNpmFrame(stderr), { channel: "unknown", errorClass: "unknown", module: "unknown", line: null });
  for (const frame of ["/TEST-private/lib/npm.js:301:4", root + "lib/npm.js:9999:4",
    root + "lib/npm.js:301:9999", root + "lib/npm.js:0301:4", root + "lib/npm.js:301:4 trailing"])
    assert.equal(observePinnedTestNpmFrame(header + "npm verbose stack     at " + frame + "\n").module, "unknown");
  let calls = 0;
  const proxy = new Proxy({}, { get() { ++calls; throw new Error("TEST-trap"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const input of [proxy, revoked.proxy, null, 3, { toString() { ++calls; throw new Error("TEST-trap"); } }])
    assert.equal(observePinnedTestNpmFrame(input).module, "unknown");
  assert.equal(calls, 0);
});


test("complete public catalog covers nested vendor source but refuses paths before IO", () => {
  const source = lookupNpmPublicSourcePart0("node_modules/@npmcli/arborist/lib/arborist/build-ideal-tree.js") ??
    lookupNpmPublicSourcePart1("node_modules/@npmcli/arborist/lib/arborist/build-ideal-tree.js");
  assert(source && Object.isFrozen(source));
  assert.equal(source.gitBlob, "54f86dea0f65c02b49acc2fc4f7bb596f3b3cd76");
  // Independent official-tree anchors are executable regular JS, not symlinks.
  // The previous100644-only inventory wrongly excluded BOTH actual entrypoints.
  for (const [path, gitBlob, bytes] of [["bin/npm-cli.js", "577abe03e7b8e9099840c1f17ba8875804f1e74b", 54],
    ["node_modules/wrap-ansi/index.js", "d80c74c19ca3fb3288b18ab199e842f9b71b9d23", 5778]] as const) {
    const entry = lookupNpmPublicSourcePart0(path) ?? lookupNpmPublicSourcePart1(path);
    assert(entry && Object.isFrozen(entry)); assert.equal(entry.gitBlob, gitBlob); assert.equal(entry.bytes, bytes);
  }
  const unknown = { sourceKind: "unknown", catalogId: null, sourceSha256: null, line: null, channel: "unknown", errorClass: "unknown" };
  const root = "/opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/npm/";
  for (const path of ["../auth.json", "auth.json", "package.json", "/root/.npmrc", "lib/../npm.js", "lib/TEST-secret.js"])
    assert.equal(lookupNpmPublicSourcePart0(path) ?? lookupNpmPublicSourcePart1(path), undefined);
  for (const path of ["node:internal/TEST-secret", "/root/.npmrc", root + "../auth.json", root + "lib/TEST-secret.js"])
    assert.deepEqual(observePublicTestNpmFrame("npm verbose stack TypeError: TEST-secret\n" +
      "npm verbose stack     at " + path + ":1:1\n"), unknown);
  const later = "npm verbose stack Error: TEST-secret\nnpm verbose stack     at " + root + "lib/npm.js:301:4\n";
  assert.deepEqual(observePublicTestNpmFrame("npm verbose stack " + "X".repeat(65) + ": TEST-secret\n" + later), unknown);
  let calls = 0;
  const proxy = new Proxy({}, { get() { ++calls; throw new Error("TEST-trap"); } });
  assert.deepEqual(observePublicTestNpmFrame(proxy), unknown); assert.equal(calls, 0);
});


test("private-method and symbol labels never block or escape a known exact frame", () => {
  const path = "/opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/npm/lib/npm.js";
  for (const label of ["#TEST_private", "Arborist.#TEST_private", "[Symbol(TEST_private)]", "async Object.TEST_private"]) {
    const observed = observePinnedTestNpmFrame("npm verbose stack TypeError: TEST_secret\n" +
      "npm verbose stack     at " + label + " (" + path + ":301:4)\n");
    // Parentheses inside a function label are deliberately refused as ambiguous.
    if (label.includes("(")) assert.equal(observed.module, "unknown");
    else assert.deepEqual(observed, { channel: "npm_verbose_stack", errorClass: "type_error_header", module: "npm_dispatch", line: 301 });
    assert(!JSON.stringify(observed).includes("TEST_private"));
    assert(!JSON.stringify(observed).includes("TEST_secret"));
  }
});
