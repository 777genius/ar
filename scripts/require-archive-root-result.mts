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
assert(Array.isArray(report.testResults) && report.testResults.length === 1);
const file: unknown = report.testResults[0];
assert(object(file));
assert.equal(file.name, resolve('src/worker-codex/tests/codex-goal-mcp-project-reviewed-archive.test.ts'));
assert(Array.isArray(file.assertionResults) && file.assertionResults.length === report.numTotalTests);
assert(file.assertionResults.every((test: unknown) => object(test) && test.status === 'passed'));
console.log(JSON.stringify({ scope: 'native-root-archive-TEST', completedTests: report.numTotalTests }));
