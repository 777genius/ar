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
const installationFile = resolve('src/worker-codex/tests/hosted-original-usable-placement-installation.test.ts');
const installationCases = new Set([
  'original Usable Store schema5 placement installs CLOSED through actual Store/schema5 census, preserves raw SDK and opens the same placed blobs',
  'original Usable Store schema5 placement refuses a different published installation nonce after actual fresh placement',
  'original Usable Store schema5 placement refuses changed stage before installation publication',
  'original Usable Store schema5 placement refuses changed inventory before installation publication',
  'original Usable Store schema5 placement refuses changed ready before installation publication',
  'original Usable Store schema5 placement refuses changed broker before installation publication',
]);
const expectedFiles = new Set([
  resolve('src/worker-codex/tests/codex-goal-mcp-project-reviewed-archive.test.ts'),
  resolve('src/worker-codex/tests/hosted-readonly-custody-record-once.test.ts'),
  resolve('src/worker-codex/tests/codex-goal-sdk-standalone-workspace.test.ts'),
  installationFile,
]);
assert(Array.isArray(report.testResults) && report.testResults.length === expectedFiles.size);
let completedTests = 0;
for (const file of report.testResults as unknown[]) {
  assert(object(file));
  assert(typeof file.name === 'string' && expectedFiles.delete(file.name));
  assert(Array.isArray(file.assertionResults) && file.assertionResults.length > 0);
  assert(file.assertionResults.every((test: unknown) => object(test) && test.status === 'passed'));
  if (file.name === installationFile) {
    assert.equal(file.assertionResults.length, 6);
    for (const test of file.assertionResults as unknown[]) {
      assert(object(test) && typeof test.fullName === 'string' && installationCases.delete(test.fullName));
    }
  }
  completedTests += file.assertionResults.length;
}
assert.equal(expectedFiles.size, 0);
assert.equal(installationCases.size, 0);
assert.equal(completedTests, report.numTotalTests);
console.log(JSON.stringify({ scope: 'native-root-archive-TEST', completedTests: report.numTotalTests }));
