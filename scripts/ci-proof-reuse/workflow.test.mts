import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CAPTURE_STEP, HELPER_STEP } from './protocol.mts';
// Execute the real aggregate shell. An accidental acceptance of skipped or
// failed matrices, missing proof, or failed ancillary phases makes this red.
const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
function jobBlock(job: string): string {
  const block = workflow.split(`  ${job}:\n`)[1]?.split(/^  [a-z][a-z-]*:\n/m)[0];
  assert.ok(block, `Job ${job} exists`);
  return block;
}
function aggregate(job: string): string {
  const block = jobBlock(job);
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

// Node 26 rejects --experimental-transform-types, and the protocol uses strict
// enums that type stripping cannot run. Every default-CI entry must therefore
// execute the compiled helper that was built from the locked project compiler.
test('default CI runs the compiled proof helper, prepared before any capture or full install', () => {
  const entry = 'node "$RUNNER_TEMP/ci-proof-helper/cli.mjs"';
  const build = 'npm run build:ci-proof-reuse -- --outDir "$RUNNER_TEMP/ci-proof-helper"';
  const packageScripts = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  assert.ok(!workflow.includes('--experimental-transform-types'), 'Removed Node flag in default CI');
  assert.ok(!packageScripts['test:ci-tools']!.includes('--experimental-transform-types'), 'Removed Node flag in test:ci-tools');
  assert.equal(workflow.match(/scripts\/ci-proof-reuse\/cli\.mts/g), null, 'Direct TypeScript entry in default CI');
  assert.equal(workflow.match(/ci-proof-helper\/cli\.mjs/g)?.length, 3, 'Detector plus unit and crash capture only');
  for (const [job, action, before] of [['ci-proof-reuse', 'detect', 'Verify reusable PR lane proofs'],
    ['unit-test-shards', 'capture', CAPTURE_STEP], ['crash-boundary-shards', 'capture', CAPTURE_STEP]] as const) {
    const block = jobBlock(job);
    const prepare = block.indexOf(`- name: ${HELPER_STEP}\n`);
    assert.ok(prepare >= 0, `${job} prepares the helper`);
    assert.ok(block.indexOf('npm ci --ignore-scripts', prepare) > prepare, `${job} installs without lifecycle scripts`);
    assert.ok(block.indexOf(build, prepare) > prepare, `${job} compiles with the project compiler`);
    const use = block.indexOf(`${entry} ${action}`);
    assert.ok(use > prepare && use > block.indexOf(`- name: ${before}\n`), `${job} executes the compiled helper after preparation`);
    // The helper install must stay separate from the one counted full install.
    const fullInstall = block.indexOf('npm ci && break');
    if (fullInstall >= 0) assert.ok(prepare < use && use < fullInstall, `${job} captures before the full install`);
  }
});

// The official Linux Node.js binary cannot load without libatomic.so.1, which
// fails setup-node itself before any source command. The prerequisite must come
// first in every job that selects Node, on Linux only, and fail visibly.
test('every Node 26 job installs the Linux libatomic prerequisite before setup-node', () => {
  const prerequisite = 'name: Install Node.js Linux runtime prerequisite';
  const first = (...positions: number[]): number => positions.filter(position => position >= 0).sort((a, b) => a - b)[0] ?? -1;
  // The public source mirror deliberately has no package-publishing workflows.
  for (const file of ['publish.yml', 'publish-registry-contract.yml']) {
    assert.equal(existsSync(resolve('.github/workflows', file)), false, `${file} is excluded from the public mirror`);
  }
  for (const [file, jobsWithNode] of [['ci.yml', 7]] as const) {
    const text = readFileSync(resolve('.github/workflows', file), 'utf8');
    let checked = 0;
    for (const block of text.split(/^(?=  [a-z][a-z0-9-]*:\n)/m)) {
      const node = first(block.indexOf('actions/setup-node@'), block.indexOf('*unit_test_node\n'));
      if (node < 0) continue;
      checked += 1;
      const install = first(block.indexOf(prerequisite), block.indexOf('*unit_test_node_prerequisite\n'));
      assert.ok(install >= 0 && install < node, `${file} ${block.split('\n')[0]!.trim()} installs the prerequisite before setup-node`);
    }
    assert.equal(checked, jobsWithNode, `${file} Node jobs`);
    // Definitions only: an alias reuses the anchored step, including its condition.
    assert.equal(text.match(/^ +if: runner\.os == 'Linux'$/gm)?.length ?? 0,
      text.match(new RegExp(`^ +- (?:${prerequisite}|&unit_test_node_prerequisite)$`, 'gm'))?.length ?? 0, `${file} limits every prerequisite step to Linux`);
    assert.ok(text.includes('sudo apt-get install -y --no-install-recommends libatomic1'), `${file} installs libatomic1 with apt`);
    assert.ok(text.includes('::error::libatomic.so.1 is missing and this Linux runner has no apt-get'), `${file} fails visibly without apt`);
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
