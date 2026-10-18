import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyOwnedProxyStderr, classifyTransientStartFailure, ownedProxyOptionNames, ownedProxyPropertyNames } from "./transient-start-diagnostic.ts";
import { sameSyntheticDiagnosticFile, syntheticCliStderrDiagnostic, syntheticProviderSha256, verifiedSyntheticCliInputs } from "./synthetic-cli-diagnostic.ts";
import { cleanEnv } from "./common.ts";
const sample = (text: string) => {
  const bytes = Buffer.from(text);
  return classifyTransientStartFailure(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length });
};
test("complete fixed messages produce closed factual classes only", () => {
  const cases = [
    ["Client not member of any unit.", "client_outside_unit"], ["Invalid unit name or type.", "invalid_unit"],
    ["Invalid UnsetEnvironment= list.", "invalid_unset_environment"], ["Invalid environment assignments", "invalid_environment"],
    ["Invalid environment variable names or assignments", "invalid_environment_names"], ["Access denied", "access_denied"],
    ["Invalid argument", "invalid_argument"], ["Operation not permitted", "operation_not_permitted"],
    ["Permission denied", "permission_denied"], ["Timed out", "timed_out"], ["Not supported", "not_supported"],
    ["Connection refused", "connection_refused"], ["No such file or directory", "missing_file"],
  ];
  for (const [body, expected] of cases) {
    const facts = sample(`Failed to start transient service unit: ${body}\n`);
    assert.equal(facts.message, expected); assert.equal(facts.state, "complete");
    assert.equal(facts.ascii, true); assert.equal(facts.lineCount, 1);
  }
});
test("equal length secret body cannot identify the 71-byte cause or leak text", () => {
  const secret = "SECRET/auth/token/path/1234567";
  const text = `Failed to start transient service unit: ${secret}\n`;
  assert.equal(Buffer.byteLength(text), 71);
  const facts = sample(text); assert.equal(facts.message, "unknown");
  assert.equal(facts.state, "complete"); assert.equal(facts.suffixBytes, 30);
  assert.deepEqual(Object.keys(facts).sort(), ["ascii", "control", "fullBytes", "lineCount", "message", "nonAscii", "numericTokenCount", "offset", "sampleBytes", "state", "suffixBytes", "tokenCount"].sort());
  const serialized = JSON.stringify(facts);
  for (const forbidden of [secret, "SECRET", "/auth", "/token", "123456"]) assert(!serialized.includes(forbidden));
});
test("malformed, expanded and incomplete input never becomes a known message", () => {
  const line = "Failed to start transient service unit: Access denied\n";
  for (const text of [line.slice(0, -1), line + "extra\n", line.replace("Access", "\u001bAccess"),
    line.replace("Access", "\u0000Access"), line.replace("Access", "Áccess"), line.replace("\n", "\r\n"),
    line.replace("Access denied", "prefix Access denied"), line + line]) assert.equal(sample(text).message, "unknown");
  const bytes = Buffer.from(line);
  for (const context of [{ fullBytes: bytes.length + 1, offset: 1, initialBytes: bytes.length + 1, currentBytes: bytes.length + 1 },
    { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length + 1 },
    { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length + 1, currentBytes: bytes.length },
    { fullBytes: Infinity, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length },
    { fullBytes: bytes.length - 1, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length - 1 },
    { fullBytes: NaN, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length }, { fullBytes: bytes.length, offset: -1, initialBytes: bytes.length, currentBytes: bytes.length }]) {
    assert.equal(classifyTransientStartFailure(bytes, context).message, "unknown");
  }
  assert.equal(sample("x".repeat(4097)).state, "oversize");
  assert.equal(sample("Failed to start transient service unit: Access denied 123\n").numericTokenCount, 1);
});

test("exact socket-operation text yields a category without errno or raw body", () => {
  const text = "Failed to start transient service unit: Socket operation on non-socket\n";
  assert.equal(Buffer.byteLength(text), 71);
  const facts = sample(text); assert.equal(facts.message, "socket_operation_on_non_socket");
  assert.equal(facts.state, "complete"); assert.equal(facts.suffixBytes, 30);
  for (const key of ["errno", "errnoName", "errorName", "code", "cause", "property", "syscall", "fd"]) assert(!(key in facts));
  assert(!JSON.stringify(facts).includes("Socket operation on non-socket"));
  for (const near of [text.replace("non-socket", "non-socket."), text.replace("Socket", "socket"),
    text.replace("non-socket", "non-socket 88"), text.slice(0, -1)]) assert.equal(sample(near).message, "unknown");
});

test("owned proxy diagnostics distinguish argv and connection prefixes without publishing values", () => {
  const cases = [
    ["Failed to parse service property: PRIVATE_CANARY", "failed_to_parse"],
    ["Unknown assignment: PRIVATE_CANARY", "unknown_assignment"],
    ["Failed to set unit properties: PRIVATE_CANARY", "failed_to_set_unit_properties"],
    ["Failed to create bus connection: PRIVATE_CANARY", "failed_to_create_bus_connection"],
    ["Failed to connect to system scope bus via local transport: PRIVATE_CANARY", "failed_to_connect"],
    ["Failed to find executable /PRIVATE_CANARY", "failed_to_find_executable"],
    ["Failed to execute /PRIVATE_CANARY", "failed_to_execute"],
    ["Failed to start transient service unit: PRIVATE_CANARY", "failed_to_start_transient_service_unit"],
    ["/usr/bin/systemd-run: unrecognized option '--PRIVATE_CANARY'", "unrecognized_option"],
    ["systemd-run: invalid option -- PRIVATE_CANARY", "invalid_option"],
  ];
  for (const [text, prefix] of cases) {
    const bytes = Buffer.from(text + "\n");
    const facts = classifyOwnedProxyStderr(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length });
    assert.equal(facts.state, "complete"); assert.equal(facts.prefix, prefix);
    assert.equal(facts.optionPresenceBits, 0); assert.equal(facts.propertyPresenceBits, 0);
    assert(!JSON.stringify(facts).includes("PRIVATE_CANARY"));
  }
});

test("owned proxy exports only exact fixed recipe option and property bits", () => {
  const text = "Failed to parse --property=UnsetEnvironment=PRIVATE_CANARY --collect --collect-extra PrivateUnsetEnvironment=PRIVATE_CANARY\n";
  const bytes = Buffer.from(text), context = { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length };
  const facts = classifyOwnedProxyStderr(bytes, context);
  assert.equal(facts.optionPresenceBits, 2 ** ownedProxyOptionNames.indexOf("--property") + 2 ** ownedProxyOptionNames.indexOf("--collect"));
  assert.equal(facts.propertyPresenceBits, 2 ** ownedProxyPropertyNames.indexOf("UnsetEnvironment"));
  assert.deepEqual(Object.keys(facts).sort(), ["state", "prefix", "optionPresenceBits", "propertyPresenceBits"].sort());
  assert(!JSON.stringify(facts).includes("PRIVATE_CANARY"));
  for (const input of ["Unknown assignmentSecret\n", "Failed to parser PRIVATE_CANARY\n", "private/--collect-extra UnsetEnvironmentSuffix\n"]) {
    const value = Buffer.from(input);
    assert.deepEqual(classifyOwnedProxyStderr(value, { fullBytes: value.length, offset: 0, initialBytes: value.length, currentBytes: value.length }),
      { state: "complete", prefix: "unknown", optionPresenceBits: 0, propertyPresenceBits: 0 });
  }
  for (const input of [text.slice(0, -1), text + "PRIVATE_CANARY\n", text.replace("PRIVATE_CANARY", "\u0000PRIVATE_CANARY"),
    text.replace("PRIVATE_CANARY", "ÁPRIVATE_CANARY"), "x".repeat(4097)]) {
    const value = Buffer.from(input);
    const rejected = classifyOwnedProxyStderr(value, { fullBytes: value.length, offset: 0, initialBytes: value.length, currentBytes: value.length });
    assert.equal(rejected.prefix, "unknown");
    assert.equal(rejected.optionPresenceBits, 0); assert.equal(rejected.propertyPresenceBits, 0);
    assert.notEqual(rejected.state, "complete");
  }
  const changing = classifyOwnedProxyStderr(bytes, { ...context, currentBytes: bytes.length + 1 });
  assert.deepEqual(changing, { state: "partial", prefix: "unknown", optionPresenceBits: 0, propertyPresenceBits: 0 });
});

test("synthetic text requires exact fixture inputs and refuses live or changed provenance", () => {
  const runtime = "/opt/subscription-runtime-dependency-os-TEST", jobId = "TEST-os-11111111-2222-3333-4444-555555555555";
  const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + jobId, workspace = root + "/workspace";
  const args = [runtime + "/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", jobId, "--job-id", jobId,
    "--job-root", root, "--workspace", workspace, "--prompt", root + "/prompt", "--accounts", "TEST-account", "--auth-root", root + "/auth",
    "--codex-binary", runtime + "/codex/bin/provider.ts", "--model", "TEST-synthetic-model", "--effort", "low", "--timeout", "5m",
    "--max-goal-turns", "1", "--max-attempts", "1", "--continuation-mode", "disabled", "--registry-root", root + "/state/registry",
    "--output", root + "/state/TEST-result.json", "--worker-report-mode", "structured-output"];
  const valid = { scenario: "dependency", phase: "fresh_real_cli", entry: runtime + "/scripts/dependency-retention-os-test/guest.ts",
    command: runtime + "/toolchain/bin/node", jobId, root, workspace, args,
    env: { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    providerSha256: createHash("sha256").update(readFileSync(new URL("./provider.ts", import.meta.url))).digest("hex"),
    prompt: Buffer.from("Execute the fixed dependency-reading TEST probe. This is a synthetic provider protocol fixture.\n"),
    auth: Buffer.from(JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "TEST-NOT-A-CREDENTIAL" }, last_refresh: "2026-10-18T00:00:00.000Z" }) + "\n") };
  assert(verifiedSyntheticCliInputs(valid));
  assert.equal(valid.providerSha256, syntheticProviderSha256);
  const sample = Buffer.from("Unclassified fixture failure\n"), context = { fullBytes: sample.length, offset: 0, initialBytes: sample.length, currentBytes: sample.length };
  assert.equal(syntheticCliStderrDiagnostic(sample, context, verifiedSyntheticCliInputs(valid), "a".repeat(40)).state, "captured");
  for (const patch of [{ scenario: "current-dependency" }, { phase: "hot_real_cli" }, { entry: "/private/other.ts" },
    { providerSha256: "0".repeat(64) }, { root: "/real/job" }, { command: "/usr/bin/node" }, { prompt: Buffer.from("user data") },
    { env: { ...valid.env, OPENAI_API_KEY: "PRIVATE_CANARY" } }, { args: args.map(value => value === "TEST-account" ? "real-account" : value) },
    { args: args.map(value => value === "TEST-synthetic-model" ? "gpt-6.1-sol" : value) },
    { auth: Buffer.from(valid.auth.toString().replace("TEST-NOT-A-CREDENTIAL", "PRIVATE_CANARY")) },
    { auth: Buffer.from(valid.auth.toString().replace('"auth_mode":', '"private":"PRIVATE_CANARY","auth_mode":')) },
    { auth: Buffer.from(valid.auth.toString().replace('"auth_mode":', '"auth_mode":"PRIVATE_CANARY","auth_mode":')) }]) {
    const verified = verifiedSyntheticCliInputs({ ...valid, ...patch }); assert.equal(verified, false);
    assert.equal(syntheticCliStderrDiagnostic(sample, context, verified, "a".repeat(40)).state, "unavailable");
  }
});

test("bounded synthetic text redacts identities, rejects unsafe samples and retains no secret canary", () => {
  const sha = "a".repeat(40), uuid = "11111111-2222-3333-4444-555555555555";
  const observe = (text: string, trusted = true, change = {}) => {
    const bytes = Buffer.from(text);
    return syntheticCliStderrDiagnostic(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length, ...change }, trusted, sha);
  };
  const result = observe(`Unclassified /var/lib/TEST-${uuid}/PRIVATE_CANARY failed for unit TEST-${uuid} at ${sha} TEST-NOT-A-CREDENTIAL\n`);
  assert.equal(result.state, "captured");
  assert('redactedText' in result && result.redactedText.includes("Unclassified <path> failed"));
  for (const value of [uuid, sha, "PRIVATE_CANARY", "TEST-NOT-A-CREDENTIAL", "/var/lib"]) assert(!JSON.stringify(result).includes(value));
  for (const text of ["Authorization: Bearer PRIVATE_CANARY\n", "refresh_token=PRIVATE_CANARY\n", "token=PRIVATE_CANARY\n",
    "password=PRIVATE_CANARY\n", "api_key=PRIVATE_CANARY\n", "sk-PRIVATE_CANARY\n", "ghs_PRIVATE_CANARY\n",
    "-----BEGIN PRIVATE KEY-----\n", "b".repeat(64) + "\n", "aB9_".repeat(16) + "\n", "eyJPRIVATE_CANARY.payload.signature\n",
    "text without newline", "one\ntwo\n", "nonascii Á\n", "control\u0000\n", "x".repeat(4096) + "\n"]) {
    const refused = observe(text); assert.equal(refused.state, "unavailable"); assert(!('redactedText' in refused));
    assert(!JSON.stringify(refused).includes("PRIVATE_CANARY"));
  }
  assert.equal(observe("plain error\n", false).state, "unavailable");
  assert.equal(observe("plain error\n", true, { currentBytes: 999 }).state, "unavailable");
  assert.equal(observe("plain error\n", true, { offset: 1 }).state, "unavailable");
  const before = { dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o100600, nlink: 1, size: 104, mtimeMs: 10, ctimeMs: 20 };
  assert(sameSyntheticDiagnosticFile(before, { ...before }));
  for (const change of [{ ino: 3 }, { mode: 0o100644 }, { nlink: 2 }, { size: 105 }, { mtimeMs: 11 }, { ctimeMs: 21 }, { uid: 1 }])
    assert.equal(sameSyntheticDiagnosticFile(before, { ...before, ...change }), false);
});
