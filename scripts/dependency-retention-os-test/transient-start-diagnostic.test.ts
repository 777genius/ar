import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOwnedProxyStderr, classifyTransientStartFailure, ownedProxyOptionNames, ownedProxyPropertyNames } from "./transient-start-diagnostic.ts";
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
  assert.deepEqual(Object.keys(facts).sort(), ["state", "prefix", "templateId", "optionPresenceBits", "propertyPresenceBits"].sort());
  assert(!JSON.stringify(facts).includes("PRIVATE_CANARY"));
  for (const input of ["Unknown assignmentSecret\n", "Failed to parser PRIVATE_CANARY\n", "private/--collect-extra UnsetEnvironmentSuffix\n"]) {
    const value = Buffer.from(input);
    assert.deepEqual(classifyOwnedProxyStderr(value, { fullBytes: value.length, offset: 0, initialBytes: value.length, currentBytes: value.length }),
      { state: "complete", prefix: "unknown", templateId: "unknown", optionPresenceBits: 0, propertyPresenceBits: 0 });
  }
  for (const input of [text.slice(0, -1), text + "PRIVATE_CANARY\n", text.replace("PRIVATE_CANARY", "\u0000PRIVATE_CANARY"),
    text.replace("PRIVATE_CANARY", "ÁPRIVATE_CANARY"), "x".repeat(4097)]) {
    const value = Buffer.from(input);
    const rejected = classifyOwnedProxyStderr(value, { fullBytes: value.length, offset: 0, initialBytes: value.length, currentBytes: value.length });
    assert.equal(rejected.prefix, "unknown"); assert.equal(rejected.templateId, "unknown");
    assert.equal(rejected.optionPresenceBits, 0); assert.equal(rejected.propertyPresenceBits, 0);
    assert.notEqual(rejected.state, "complete");
  }
  const changing = classifyOwnedProxyStderr(bytes, { ...context, currentBytes: bytes.length + 1 });
  assert.deepEqual(changing, { state: "partial", prefix: "unknown", templateId: "unknown", optionPresenceBits: 0, propertyPresenceBits: 0 });
});

test("upstream templates identify previously unknown 104-byte lines and option conflicts with no raw captures", { timeout: 1000 }, () => {
  const prefix = "Can't determine if bus connection is direct or to broker: ";
  const text = prefix + "PRIVATE_CANARY".padEnd(104 - prefix.length - 1, "x") + "\n";
  assert.equal(Buffer.byteLength(text), 104);
  const observe = (line: string) => {
    const bytes = Buffer.from(line);
    return classifyOwnedProxyStderr(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length });
  };
  const facts = observe(text);
  assert.deepEqual(facts, { state: "complete", prefix: "unknown", templateId: "run_bus_connection_kind", optionPresenceBits: 0, propertyPresenceBits: 0 });
  assert.equal(observe("--wait may not be combined with --scope.\n").templateId, "run_wait_scope");
  assert.equal(observe("If --shell is used, no command line is expected.\n").templateId, "run_shell_command_conflict");
  assert.equal(observe("Failed to query unit state: Unit PRIVATE_CANARY not loaded.\n").templateId, "run_query_unit_state");
  assert.equal(observe("Failed to find executable /PRIVATE_CANARY: hidden detail\n").templateId, "run_find_executable");
  assert.equal(observe("Invalid syntax: PRIVATE_CANARY\n").templateId, "property_invalid_syntax");
  assert.equal(observe("Not an assignment: PRIVATE_CANARY\n").templateId, "property_not_assignment");
  assert.equal(observe("Invalid UUID size, 16 != 17.\n").templateId, "run_uuid_size");
  for (const line of [text.slice(0, -1), text + "private\n", text.replace("PRIVATE", "\u001bPRIVATE"),
    "x" + text, "--wait may not be combined with --scope. extra\n", "Invalid UUID size, PRIVATE_CANARY != 17.\n",
    "Unique name " + " has unexpected format.".repeat(150) + "PRIVATE_CANARY\n"]) {
    assert.equal(observe(line).templateId, "unknown");
  }
  for (const forbidden of ["PRIVATE_CANARY", "broker:", "unit:", "/PRIVATE", "hidden detail"]) assert(!JSON.stringify(facts).includes(forbidden));
});
