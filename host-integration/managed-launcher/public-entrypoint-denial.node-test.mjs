import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicEntrypoints, provePublicEntrypointDenial } from './fixtures/public-entrypoint-denial.mjs';

async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-public-entrypoint-denial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'synthetic.mjs');
  await writeFile(executable, body);
  const sentinel = join(root, 'sentinel');
  await mkdir(sentinel);
  return { executable, sentinel };
}

test('derives all four installed public executable paths', () => {
  assert.deepEqual(publicEntrypoints('/trusted/dist/worker-codex/codex-goal-cli.js'), {
    goal: '/trusted/dist/worker-codex/codex-goal-cli.js', mcp: '/trusted/dist/worker-codex/codex-goal-mcp.js',
    task: '/trusted/dist/worker-local/agent-task-runner-cli.js', runtime: '/trusted/dist/worker-local/agent-runtime-task-runner-cli.js',
  });
});

const denial = "process.stderr.write('Managed host requires root-owned launcher; submit through Host Jobs API'); process.exitCode = 2;";
test('runs literal subprocesses for every plain and forged-env entrypoint', async t => {
  const { executable, sentinel } = await fixture(t, denial);
  const result = await provePublicEntrypointDenial(Object.fromEntries(['goal', 'mcp', 'task', 'runtime'].map(key => [key, executable])), sentinel);
  assert.equal(result.denied, 8);
  assert.equal(result.rootWrites, 0);
  assert.deepEqual(result.entrypoints.map(row => row.forgedEnvironment), [false, true, false, true, false, true, false, true]);
});

test('rejects a refusal occurring after a synthetic sentinel write', async t => {
  const { executable, sentinel } = await fixture(t, "import { writeFileSync } from 'node:fs'; writeFileSync('must-not-exist', 'bad'); " + denial);
  await assert.rejects(provePublicEntrypointDenial({ goal: executable }, sentinel), /denial failed before sentinel write/);
});

test('does not confuse argument errors or successful exits with admission denial', async t => {
  for (const [name, body] of [['parse', "process.stderr.write('invalid argument'); process.exitCode = 2;"], ['success', denial + 'process.exitCode = 0;']]) {
    const { executable, sentinel } = await fixture(t, body);
    await assert.rejects(provePublicEntrypointDenial({ [name]: executable }, sentinel), /denial failed/);
  }
});
