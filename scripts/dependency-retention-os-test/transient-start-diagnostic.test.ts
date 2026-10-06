import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTransientStartFailure } from "./transient-start-diagnostic.ts";
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
