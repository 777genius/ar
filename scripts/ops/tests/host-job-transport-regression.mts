import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { mock } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {pathToFileURL} from 'node:url';

// The production default command() is exercised through its public transport.
// Only the executable boundary is redirected to owned synthetic Node children.
const realSpawn = cp.spawn;
type Mode = 'stderr' | 'stdout' | 'denial' | 'denial-held' | 'input-error' | 'overflow';
let mode: Mode = 'stderr', requests = 0, checks = 0, masters = 0;
const children: cp.ChildProcess[] = [];
const root = await mkdtemp(join(tmpdir(), 'TEST-host-transport-r3534-'));
const writerReceipt = join(root, 'writer.json');
function spawnSynthetic(exe: string, args: readonly string[] = []): cp.ChildProcess {
  assert.equal(exe, '/usr/bin/ssh');
  let body: string;
  if (args.includes('-O')) { checks++; body = 'process.stdin.resume();'; }
  else if (args.includes('-M')) { masters++; body = 'process.stdin.resume();'; }
  else {
    requests++;
    assert(args.includes('-oProxyCommand=false') && args.includes('-oControlMaster=no'));
    const result = JSON.stringify({ ok: true, result: { synthetic: true } });
    if (mode === 'input-error') body = `require('node:fs').closeSync(0);setTimeout(()=>process.stdout.write(${JSON.stringify(result)},()=>process.exit(0)),60);`;
    else if (mode === 'overflow') body = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(1048577)));`;
    else if (mode === 'denial-held') body = `process.stdin.resume();process.stdin.on('end',()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.stderr.write("TEST_LATE_DENIAL"),100);setTimeout(()=>{},650);'],{stdio:['ignore','ignore',2]});c.unref();process.stdout.write('{"ok":false,"error":"TEST delayed admission denied"}',()=>process.exit(1));});`;
    else if (mode === 'denial') body = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('TEST_DENIAL');process.stdout.write('{"ok":false,"error":"TEST admission denied"}',()=>process.exit(1));});`;
    else {
      const stdio = mode === 'stderr' ? ['ignore', 'ignore', 2] : ['ignore', 1, 'ignore'];
      const grand = `setTimeout(()=>process.stderr.write('LATE_TEST_DIAGNOSTIC',error=>require('node:fs').writeFileSync(${JSON.stringify(writerReceipt)},JSON.stringify({code:error?.code??null}))),100);setTimeout(()=>{},650);`;
      body = `process.stdin.resume();process.stdin.on('end',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:${JSON.stringify(stdio)}});c.unref();process.stdout.write(${JSON.stringify(result)},()=>process.exit(0));});`;
    }
  }
  const child = realSpawn(process.execPath, ['-e', body], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
const mocked = mock.module('node:child_process', { namedExports: { ...cp, spawn: spawnSynthetic } });
interface TransportModule {
  hostTransport(options: {host: string; machineId: string; socketDir: string}): {
    request(request: {operation: string; machineId: string; payload?: string}): Promise<unknown>;
  };
}
const target = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL('../host-job-transport.mjs', import.meta.url).href;
const fixed: TransportModule = await import(target);
let serial = 0;
const machineId = '1'.repeat(32);
function request(module: TransportModule, payload?: string): Promise<unknown> {
  const transport = module.hostTransport({host: `TEST-r3534-${++serial}`, machineId, socketDir: join(root, `socket-${serial}`)});
  return transport.request({operation: 'status', machineId, ...(payload === undefined ? {} : {payload})});
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const outcomes: object[] = [];
const selected = process.argv[3];
try {
  if (selected === undefined || selected === 'stderr') {
  mode = 'stderr';
  const began = performance.now();
  assert.deepEqual(await request(fixed), {synthetic: true});
  assert(performance.now() - began < 400, 'fixed command must complete before inherited stderr EOF');
  assert.equal(children.at(-1)?.stderr?.destroyed, false);
  // Wait for the owned writer's receipt rather than assuming child startup speed.
  const receiptDeadline = performance.now() + 2000;
  let receipt: string | undefined;
  while (receipt === undefined && performance.now() < receiptDeadline) {
    try { receipt = await readFile(writerReceipt, 'utf8'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await delay(20);
    }
  }
  assert(receipt !== undefined, 'owned late stderr writer must publish a receipt');
  assert.deepEqual(JSON.parse(receipt), {code: null});
  outcomes.push({case: 'fixed-is-green-and-late-stderr-writer-has-no-EPIPE', passed: true});
  }

  if (selected === undefined || selected === 'stdout') {
  mode = 'stdout';
  let completed = false;
  const heldOutput = request(fixed).then(value => {completed = true; return value;});
  await delay(180); assert.equal(completed, false, 'exit alone cannot qualify retained stdout');
  assert.deepEqual(await heldOutput, {synthetic: true});
  outcomes.push({case: 'held-stdout-never-accepted-on-exit-alone', passed: true});
  }

  if (selected === undefined || selected === 'denial') {
  mode = 'denial';
  const before = {requests, checks, masters};
  await assert.rejects(request(fixed), /TEST admission denied/);
  assert.equal(requests - before.requests, 1);
  assert.equal(checks - before.checks, 1);
  assert.equal(masters, before.masters);
  outcomes.push({case: 'non255-structured-endpoint-denial-never-reconnects-or-retries', passed: true});
  }

  if (selected === undefined || selected === 'denial-held') {
  mode = 'denial-held';
  const heldBefore = {requests, checks, masters};
  let denied = false;
  const heldDenial = request(fixed).catch(error => { denied = true; throw error; });
  const heldAssertion = assert.rejects(heldDenial, /TEST delayed admission denied/);
  await delay(180); assert.equal(denied, false, 'nonzero endpoint response requires stderr closure');
  await heldAssertion;
  assert.equal(requests - heldBefore.requests, 1); assert.equal(checks - heldBefore.checks, 1); assert.equal(masters, heldBefore.masters);
  outcomes.push({case: 'nonzero-held-stderr-waits-for-complete-diagnostics-without-retry', passed: true});
  }

  if (selected === undefined || selected === 'input-error') {
  mode = 'input-error';
  await assert.rejects(request(fixed, 'x'.repeat(2 * 1024 * 1024)), error => error instanceof Error && error.message === 'ssh request outcome unknown' && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'EPIPE');
  outcomes.push({case: 'real-stdin-EPIPE-refuses-successful-output', passed: true});
  }
  if (selected === undefined || selected === 'overflow') {
  mode = 'overflow';
  await assert.rejects(request(fixed), error => error instanceof Error && error.message === 'ssh request outcome unknown' && error.cause instanceof Error && /stdout limit exceeded/.test(error.cause.message));
  outcomes.push({case: 'stdout-overflow-cannot-accept-truncated-response', passed: true});
  }
  // Owned synthetic grandchildren terminate naturally; overflow kills only our synthetic foreground.
  await delay(800);
  console.log(JSON.stringify({passed: outcomes.length, outcomes}));
} finally {
  mocked.restore();
  await rm(root, {recursive: true, force: true});
}
