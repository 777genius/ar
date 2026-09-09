import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostJobs } from './manager.mjs';
import { hostTransport, sshOutput } from '../../scripts/ops/host-job-transport.mjs';
import { hostJobCli } from '../../scripts/ops/host-job-cli.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostLock } from '../../scripts/ops/host-job-lock.mjs';

const request = { operation: 'start', jobId: 'test:1', machineId: 'a'.repeat(32), argv: ['/bin/test', '$(touch nope)'], cwd: '/sandbox', runtimeSeconds: 60, stopSeconds: 5, memoryMiB: 128, tasksMax: 16, cpuPercent: 50 };
async function fixture(options = {}) {
  const calls = [];
  let state = 'LoadState=not-found';
  const manager = new HostJobs({ stateDir: await mkdtemp(join(tmpdir(), 'host-jobs-test-')), machineId: async () => request.machineId, freeBytes: async () => 5 * 1024 ** 3,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd.endsWith('systemd-run')) {
        state = `LoadState=loaded\nActiveState=active\nDescription=${args.find(x => x.startsWith('--description=')).slice(14)}`;
        if (options.uncertain) throw new Error('connection lost');
      }
      return state;
    }, ...options });
  return { manager, calls };
}
test('bounded service preserves argv, concurrent and uncertain starts execute once', async () => {
  const { manager, calls } = await fixture({ uncertain: true });
  const first = await manager.start(request);
  assert.equal(first.phase, 'uncertain');
  await Promise.all([manager.start(request), manager.start(request)]);
  const launches = calls.filter(x => x.cmd.endsWith('systemd-run'));
  assert.equal(launches.length, 1);
  assert.ok(launches[0].args.includes('--property=KillMode=control-group'));
  assert.equal(launches[0].args.at(-1), '$(touch nope)');
  await assert.rejects(manager.start({ ...request, argv: ['/bin/other'] }), /already bound/);
  const reconciled = await manager.status(request.jobId, request.machineId);
  assert.equal(reconciled.live, true);
  assert.equal(reconciled.unresolved, false);
  assert.equal(reconciled.abandoned, false);
  await manager.stop(request.jobId, request.machineId);
  assert.ok(calls.some(x => x.args.includes('stop')));
});
test('admission and unknown ownership fail closed', async () => {
  const { manager, calls } = await fixture({ freeBytes: async () => 5 * 1024 ** 3 - 1 });
  await assert.rejects(manager.start(request), /5 GiB/);
  await assert.rejects(manager.stop('unknown', request.machineId), /unknown job/);
  await assert.rejects(manager.stop('unknown', 'b'.repeat(32)), /machine identity/);
  await assert.rejects(manager.status('unknown'), /machine identity/);
  assert.equal(calls.length, 0);
  const other = await fixture({ run: async () => 'LoadState=loaded\nDescription=other' });
  await assert.rejects(other.manager.start(request), /unowned/);
});
test('transport serializes host calls and sends payload only on stdin', async () => {
  const pending = [];
  const calls = [];
  const transport = hostTransport({ host: 'fake-test', machineId: request.machineId, socketDir: await mkdtemp(join(tmpdir(), 'host-ssh-test-')),
    run: async (args, stdin) => { calls.push({ args, stdin }); if (!stdin) return ''; return new Promise(resolve => pending.push(() => resolve('{"ok":true,"result":{}}'))); } });
  const starts = Array.from({ length: 4 }, () => transport.request(request));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pending.length, 1);
  const status = transport.request({ operation: 'status', jobId: request.jobId, machineId: request.machineId });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pending.length, 1);
  for (let i = 0; i < 5; i++) {
    while (!pending.length) await new Promise(resolve => setTimeout(resolve, 10));
    pending.shift()();
  }
  await Promise.all([...starts, status]);
  const remote = calls.filter(x => x.stdin);
  assert.ok(remote.every(x => x.args.includes('-oProxyCommand=false')));
  assert.ok(remote.every(x => !x.args.includes(request.jobId)));
});
test('transport reconnects a lost master once and does not retry endpoint errors', async () => {
  let checks = 0;
  let masters = 0;
  let requests = 0;
  const transport = hostTransport({ host: 'fake-reconnect', machineId: request.machineId, socketDir: await mkdtemp(join(tmpdir(), 'host-ssh-reconnect-')),
    run: async (args, stdin) => {
      if (args.includes('check')) { checks++; if (checks === 2) throw new Error('expired'); return ''; }
      if (args.includes('-M')) { masters++; return ''; }
      requests++;
      if (requests === 1) throw new Error('lost socket');
      return sshOutput(1, '{"ok":false,"error":"admission denied"}');
    } });
  await assert.rejects(transport.request(request), /admission denied/);
  assert.equal(checks, 2);
  assert.equal(masters, 1);
  assert.equal(requests, 2);
  await assert.rejects(transport.request(request), /admission denied/);
  assert.equal(requests, 3);
  await assert.rejects(transport.request({ operation: 'stop', jobId: request.jobId, machineId: 'b'.repeat(32) }), /machine identity/);
  assert.equal(requests, 3);
});
test('uncertain missing service is unresolved, not automatically abandoned', async () => {
  const { manager } = await fixture({ run: async (cmd) => {
    if (cmd.endsWith('systemd-run')) throw new Error('unknown outcome');
    return 'LoadState=not-found';
  } });
  await manager.start(request);
  const status = await manager.status(request.jobId, request.machineId);
  assert.equal(status.live, false);
  assert.equal(status.unresolved, true);
  assert.equal(status.abandoned, false);
});
test('concurrent first starts reconcile a unit launched after the initial record read', async () => {
  const { manager, calls } = await fixture();
  const read = manager.read.bind(manager);
  let initialReads = 0;
  let releaseSecond;
  let bothRead;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const readGate = new Promise(resolve => { bothRead = resolve; });
  manager.read = async id => {
    const result = await read(id);
    if (initialReads < 2) {
      initialReads++;
      if (initialReads === 1) await readGate;
      else { bothRead(); await secondGate; }
    }
    return result;
  };
  const first = manager.start(request);
  const second = manager.start(request);
  await first;
  releaseSecond();
  const result = await second;
  assert.equal(result.retry, true);
  assert.equal(calls.filter(call => call.cmd.endsWith('systemd-run')).length, 1);
});
test('CLI forwards JSON stdin and configured identity without a real transport', async () => {
  let received;
  let output = '';
  const factory = config => ({ request: async payload => { received = { config, payload }; return { live: true }; } });
  await hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], [JSON.stringify({ operation: 'status', jobId: 'test:1' })], { write: value => { output += value; } }, factory);
  assert.equal(received.payload.machineId, request.machineId);
  assert.equal(received.payload.jobId, 'test:1');
  assert.deepEqual(JSON.parse(output), { live: true });
  await assert.rejects(hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], [JSON.stringify({ machineId: 'b'.repeat(32) })], { write() {} }, factory), /machine identity/);
});
test('CLI preserves UTF-8 characters split across byte chunks', async () => {
  const bytes = Buffer.from(JSON.stringify({ operation: 'start', argv: ['/test', 'Привіт 🧪'] }));
  let received;
  await hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], Array.from(bytes, byte => Buffer.from([byte])), { write() {} }, () => ({ request: async value => { received = value; return {}; } }));
  assert.equal(received.argv[1], 'Привіт 🧪');
});
test('independent processes cannot enter one host critical section concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-lock-processes-'));
  const module = new URL('../../scripts/ops/host-job-lock.mjs', import.meta.url).href;
  const script = `import {hostLock} from ${JSON.stringify(module)};
    import {mkdir,rmdir} from 'node:fs/promises';
    const directory=process.argv[1];
    const release=await hostLock(directory,'fake-host');
    await mkdir(directory+'/exclusive');
    await new Promise(resolve=>setTimeout(resolve,30));
    await rmdir(directory+'/exclusive');
    await release();`;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, directory])));
});
test('lock waiter tolerates unpublished owner and never parses partial temporary JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-lock-publication-'));
  const lock = join(directory, 'fake-host.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'owner.pending'), '{"pid":');
  await assert.rejects(hostLock(directory, 'fake-host', { timeoutMs: 40 }), /queue timeout/);
  await unlink(join(lock, 'owner.pending'));
  await rmdir(lock);
  const release = await hostLock(directory, 'fake-host');
  await release();
});
