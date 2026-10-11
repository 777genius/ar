import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const report: unknown = JSON.parse(readFileSync('delivery/a0-native-probe/archive-root-result.json', 'utf8'));
assert(object(report));
assert.equal(report.success, true);
assert(typeof report.numTotalTests === 'number' && Number.isSafeInteger(report.numTotalTests) && report.numTotalTests > 0);
assert.equal(report.numPassedTests, report.numTotalTests);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
const expectedFiles = new Set([
  resolve('src/worker-codex/tests/codex-goal-mcp-project-reviewed-archive.test.ts'),
  resolve('src/worker-codex/tests/codex-goal-mcp-project-retained-nonqualified.test.ts'),
  resolve('src/worker-codex/tests/hosted-readonly-custody-record-once.test.ts'),
]);
assert(Array.isArray(report.testResults) && report.testResults.length === expectedFiles.size);
let completedTests = 0;
for (const file of report.testResults as unknown[]) {
  assert(object(file));
  assert(typeof file.name === 'string' && expectedFiles.delete(file.name));
  assert(Array.isArray(file.assertionResults) && file.assertionResults.length > 0);
  assert(file.assertionResults.every((test: unknown) => object(test) && test.status === 'passed'));
  completedTests += file.assertionResults.length;
}
assert.equal(expectedFiles.size, 0);
assert.equal(completedTests, report.numTotalTests);
console.log(JSON.stringify({ scope: 'native-root-archive-TEST', completedTests: report.numTotalTests }));
