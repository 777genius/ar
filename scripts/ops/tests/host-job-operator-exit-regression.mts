import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'TEST-operator-exit-r3436-'));
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function run(path: string, label: string) {
  const began = performance.now();
  const child = spawn(process.execPath, ['--experimental-test-module-mocks',
    fileURLToPath(new URL('./host-job-operator-child.mts',import.meta.url)),
    resolve(path), join(root, label)], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', exited = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value: string) => {stdout += value;});
  child.stderr.on('data', (value: string) => {stderr += value;});
  const closed = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', () => {exited = true;});
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) reject(new Error(`TEST operator failed: ${code}/${signal}: ${stderr}`));
      else accept();
    });
  });
  while (!stdout.includes('operatorSettled') && performance.now() - began < 950) await delay(20);
  assert(stdout.includes('operatorSettled'), 'operator must report deadline rejection');
  const atSettlement = {exited, elapsedMs: performance.now() - began};
  await delay(150);
  const finiteExit = exited;
  await closed;
  return {atSettlement, finiteExit, totalMs: performance.now() - began, result: JSON.parse(stdout.trim()) as unknown};
}
try {
  const after = await run(process.argv[2] ?? fileURLToPath(new URL('../host-job-transport.mjs',import.meta.url)), 'TEST');
  assert.equal(after.finiteExit, true, '3436 must naturally exit despite inherited stdout');
  assert.deepEqual(after.result, {operatorSettled: true, outcome: 'UNKNOWN_DEADLINE', stdoutAccepted: false});
  console.log(JSON.stringify({passed: true, newMs: after.totalMs}));
} finally { await rm(root, {recursive: true, force: true}); }
