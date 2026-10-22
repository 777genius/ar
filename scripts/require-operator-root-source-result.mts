import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

assert.equal(process.platform, "linux");
for (const id of [process.getuid?.(), process.geteuid?.(), process.getgid?.(), process.getegid?.()]) assert.equal(id, 0);
const report: unknown = JSON.parse(readFileSync("delivery/a0-native-probe/operator-root-source-result.json", "utf8"));
assert(object(report));
assert.equal(report.success, true);
assert.equal(report.numTotalTests, 6);
assert.equal(report.numPassedTests, 6);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert(Array.isArray(report.testResults) && report.testResults.length === 1);
const file: unknown = report.testResults[0];
assert(object(file));
assert.equal(file.name, resolve("src/worker-codex/tests/hosted-original-usable-placement-installation.test.ts"));
assert(Array.isArray(file.assertionResults) && file.assertionResults.length === 6);
const expected = new Set([
  "installs CLOSED through actual Store/schema5 census, preserves raw SDK and opens the same placed blobs",
  "refuses a different published installation nonce after actual fresh placement",
  ...["stage", "inventory", "ready", "broker"].map(mode => "refuses changed " + mode + " before installation publication"),
]);
for (const test of file.assertionResults as unknown[]) {
  assert(object(test));
  assert.equal(test.status, "passed");
  assert(typeof test.title === "string" && expected.delete(test.title));
  assert.equal(test.fullName, "original Usable Store schema5 placement " + test.title);
}
assert.equal(expected.size, 0);
console.log(JSON.stringify({ scope: "operator-root-source-TEST", SourceOnly: true, Native: false, completedTests: 6 }));
