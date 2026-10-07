import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const implementation = process.argv[2], socketDir = process.argv[3];
assert(implementation && socketDir);
const realSpawn = cp.spawn, realTimer = globalThis.setTimeout;
const realNow = performance.now.bind(performance);
// Scale only this disposable operator's timers/monotonic clock. Production has
// no test hook and retains its original 25-second absolute deadline.
const scale = 25000 / 180;
mock.method(performance, 'now', () => realNow() * scale);
mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
  realTimer(callback, ms === undefined ? undefined : ms / scale, ...args));
mock.module('node:child_process', {namedExports: {...cp, spawn: (exe: string, args: readonly string[] = []) => {
  assert.equal(exe, '/usr/bin/ssh');
  const body = args.includes('-O') || args.includes('-M') ? 'process.stdin.resume();' :
    `process.stdin.resume();process.stdin.on('end',()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1100)'],{stdio:['ignore',1,'ignore']});c.unref();process.stdout.write('{"ok":true,"result":"TEST"}',()=>process.exit(0));});`;
  return realSpawn(process.execPath, ['-e', body], {stdio: ['pipe', 'pipe', 'pipe']});
}}});
interface Module {
  hostTransport(options: {host: string; machineId: string; socketDir: string}): {
    request(request: {operation: string; machineId: string}): Promise<unknown>;
  };
}
const module: Module = await import(pathToFileURL(implementation).href);
const machineId = '2'.repeat(32);
try {
  await module.hostTransport({host: 'TEST-operator-r3436', machineId, socketDir}).request({operation: 'status', machineId});
  throw new Error('held stdout cannot qualify success');
} catch (error) {
  assert(error instanceof Error && error.message === 'ssh request outcome unknown' && error.cause instanceof Error && /deadline exceeded/.test(error.cause.message));
  console.log(JSON.stringify({operatorSettled: true, outcome: 'UNKNOWN_DEADLINE', stdoutAccepted: false}));
}
// No process.exit(): natural process termination is the tested contract.
