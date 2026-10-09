import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
// Execute the real aggregate shell. An accidental acceptance of skipped or
// failed matrices, missing proof, or failed ancillary phases makes this red.
const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
function aggregate(job: string): string {
  const block = workflow.split(`  ${job}:\n`)[1]?.split(/^  [a-z][a-z-]*:\n/m)[0];
  assert.ok(block, 'Aggregate job exists');
  const body = block.split('        run: |\n')[1];
  assert.ok(body, 'Executable aggregate shell exists');
  return body.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
}
function succeeds(shell: string, env: Record<string, string>): boolean {
  return spawnSync('bash', ['-c', shell], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 3000 }).status === 0;
}
test('actual CI aggregates require executed successful matrices or explicit validated proofs', () => {
  const unit = aggregate('unit-tests');
  const crash = aggregate('crash-boundary-shards-complete');
  for (const matrix of ['success', 'skipped', 'failure', 'cancelled']) {
    for (const detector of ['success', 'skipped', 'failure', 'cancelled']) {
      for (const proof of ['true', 'false', '']) {
        const certified = matrix === 'success' || (matrix === 'skipped' && detector === 'success' && proof === 'true');
        assert.equal(succeeds(crash, { CRASH_BOUNDARY_SHARDS_RESULT: matrix,
          CI_PROOF_RESULT: detector, REUSE_CRASH: proof }), certified, `crash ${matrix}/${detector}/${proof}`);
        for (const ancillary of ['success', 'failure']) {
          assert.equal(succeeds(unit, { UNIT_TEST_SHARDS_RESULT: matrix, UNIT_TEST_ANCILLARY_RESULT: ancillary,
            CI_PROOF_RESULT: detector, REUSE_UNIT: proof }), certified && ancillary === 'success',
          `unit ${matrix}/${ancillary}/${detector}/${proof}`);
        }
      }
    }
  }
});
test('real matrix guards run every lane when detector is skipped, fails or returns unknown proof', () => {
  for (const [job, output] of [['unit-test-shards', 'reuse_unit'], ['crash-boundary-shards', 'reuse_crash']]) {
    const guard = workflow.split(`  ${job}:\n`)[1]?.split('\n')[0]?.trim();
    assert.ok(guard);
    assert.ok(guard.startsWith('if: ${{ ') && guard.endsWith(' }}'));
    const expression = guard.slice('if: ${{ '.length, -' }}'.length)
      .replace('always()', 'true').replace('!cancelled()', '!cancelled')
      .replaceAll('needs.ci-proof-reuse.result', 'result')
      .replaceAll(`needs.ci-proof-reuse.outputs.${output}`, 'proof');
    const evaluate = new Function('result', 'proof', 'cancelled', `return (${expression});`) as
      (result: string, proof: string, cancelled: boolean) => boolean;
    for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
      for (const proof of ['true', 'false', '']) {
        assert.equal(evaluate(result, proof, false), !(result === 'success' && proof === 'true'));
        assert.equal(evaluate(result, proof, true), false);
      }
    }
  }
});

// Missing PR read prevents authoritative PR/commit association reads; a wider
// token would unnecessarily grant the trusted metadata job write capabilities.
test('detector token grants exactly the three required read-only API scopes', () => {
  const detector = workflow.split('  ci-proof-reuse:\n')[1]?.split(/^  [a-z][a-z-]*:\n/m)[0];
  assert.ok(detector, 'Detector job exists');
  assert.ok(detector.includes("    if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}\n"), 'PR-read permission remains tied to trusted main pushes');
  assert.equal(workflow.match(/^permissions:\n((?:  [a-z-]+: [a-z]+\n)+)/m)?.[1], '  contents: read\n', 'Default and producer permissions stay read-only contents');
  const permissions = detector.match(/^    permissions:\n((?:      [a-z-]+: [a-z]+\n)+)/m)?.[1];
  assert.ok(permissions, 'Detector has explicit job-scoped permissions');
  const grants = Object.fromEntries(permissions.trim().split('\n').map(line => {
    const [scope, grant] = line.trim().split(': ');
    return [scope, grant];
  }));
  assert.deepEqual(grants, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
});
