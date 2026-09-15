import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemdInvocation, managedLauncherInvocation } from './launch.mjs';
import { runGuardedPayload, PAYLOAD_GUARD_PATH, openJobLogs } from './payload-guard.mjs';
import { socketFence, bootstrapCaps } from './profiles.mjs';
import { deriveManagedJobLayout } from '../host-jobs/storage-policy.mjs';
const job = { operation: 'job', unit: `subscription-job-${'a'.repeat(64)}.service`, payload: ['/usr/bin/true'],
  jobId: 'test-1.foo-bar_', fingerprint: 'a'.repeat(64), limits: { runtimeSeconds: 90, stopSeconds: 30, memoryMiB: 256, tasksMax: 64, cpuPercent: 100 } };
const admit = async () => deriveManagedJobLayout('/TEST', job.jobId);
const finalAdmission = async () => ({ layout: deriveManagedJobLayout('/TEST', job.jobId), device: 2n });
const build = (request, options = {}, admission = admit) => buildSystemdInvocation(request, admission, {
  nodePath: '/TRUSTED/node', trust: async () => {}, executable: async () => {},
  logs: async (root, unit) => [`${root}/logs/${unit}.stdout.log`, `${root}/logs/${unit}.stderr.log`], ...options,
});
const provider = { operation: 'provider', unit: `subscription-runtime-hosted-${'a'.repeat(36)}.service`, jobId: job.jobId,
  payload: ['/usr/bin/node', '/opt/runtime/hosted-app-server-launcher.js'] };
test('job and provider mask journal IPC without replacing provider pipes', async () => {
  for (const request of [job, provider]) {
    const { args } = await build(request);
    const paths = args.find(arg => arg.startsWith('--property=InaccessiblePaths=')).slice('--property=InaccessiblePaths='.length).split(' ');
    assert.ok(paths.includes('-/run/systemd/journal'), 'mask native, syslog and stdout journal endpoints');
    assert.ok(paths.includes('-/dev/log'), 'mask alternate syslog alias');
    assert.equal(args.includes('--pipe'), request.operation === 'provider');
    assert.equal(args.includes('--property=StandardOutput=null'), request.operation === 'job');
  }
});
test('explicit job builds fixed confinement and preserves bounded limits and ownership', async () => {
  const invocation = await build(job);
  assert.equal(invocation.args.includes('--user'), false);
  for (const property of ['ProtectSystem=strict', 'RequiresMountsFor=/TEST', 'NoNewPrivileges=yes', 'MemorySwapMax=0', 'LimitCORE=0',
    `CapabilityBoundingSet=${bootstrapCaps}`, 'AmbientCapabilities=', 'PrivateDevices=yes', `InaccessiblePaths=${socketFence}`, 'MemoryMax=256M', 'RuntimeMaxSec=90']) {
    assert.ok(invocation.args.includes(`--property=${property}`), property);
  }
  assert.equal(invocation.args.some(arg => /ProtectKernel(?:Tunables|Logs)=/.test(arg)), false,
    'locked /proc submounts would prevent the private procfs bootstrap');
  assert.ok(invocation.args.some(x => x.includes('size=256M') && x.includes('size=64M')));
  assert.ok(invocation.args.includes(`--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID=${job.jobId}`));
  assert.ok(invocation.args.includes(`--setenv=SUBSCRIPTION_RUNTIME_JOB_ID=${job.jobId}`));
  assert.ok(invocation.args.includes('--property=StandardOutput=null'));
  assert.deepEqual(invocation.args.filter(arg => arg.startsWith('--property=ReadWritePaths=')), [`--property=ReadWritePaths=/TEST/jobs/${job.jobId}`]);
  assert.ok(invocation.args.includes('--setenv=SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH=1'));
  assert.ok(invocation.args.includes(`--setenv=SUBSCRIPTION_RUNTIME_JOB_ROOT=/TEST/jobs/${job.jobId}`));
  assert.equal(invocation.args.some(arg => arg.includes('SUBSCRIPTION_RUNTIME_MANAGED_LAYOUT')), false);
  const command = invocation.args.slice(invocation.args.indexOf('--') + 1);
  assert.deepEqual(command.slice(-8), ['/TRUSTED/node', PAYLOAD_GUARD_PATH, '--job-id', job.jobId, '--job-unit', job.unit, '--', ...job.payload]);
  assert.ok(command.includes('--pid') && command.includes('--mount-proc'));
  assert.ok(command.indexOf('--bounding-set=-all') < command.indexOf(PAYLOAD_GUARD_PATH));
  assert.ok(command.indexOf(PAYLOAD_GUARD_PATH) < command.indexOf(job.payload[0]));
  assert.deepEqual(JSON.parse(managedLauncherInvocation(job).args[2]), job);
});
test('request denies old argv bridge, unknown operations and arbitrary policy fields', async () => {
  for (const value of [[], ['--property=ProtectSystem=no'], null, { ...job, operation: 'shell' },
    ...['cwd', 'mounts', 'workspacePath', 'jobRoot', 'properties', 'args', 'capabilities', 'sockets', 'storageRoot', 'pipe', 'env'].map(key => ({ ...job, [key]: [] }))]) {
    await assert.rejects(build(value), /unsupported/);
  }
});
test('job limits are bounded positive integers without extra fields', async () => {
  for (const limits of [null, {}, { ...job.limits, memoryMiB: 0 }, { ...job.limits, runtimeSeconds: 86401 },
    { ...job.limits, cpuPercent: '100' }, { ...job.limits, tasksMax: 1.5 }, { ...job.limits, extra: 1 }]) {
    await assert.rejects(build({ ...job, limits }), /unsupported/);
  }
});
test('provider bootstrap is constructed internally and trusted before admission', async () => {
  const trusted = [];
  const invocation = await build(provider, { trust: async path => trusted.push(path) });
  assert.equal(invocation.args.some(arg => arg.startsWith('--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID=')), false);
  assert.deepEqual(trusted, ['/TRUSTED/node', ...provider.payload,
    '/opt/subscription-runtime/managed-launcher/launch.mjs', PAYLOAD_GUARD_PATH, '/usr/bin/unshare', '/usr/bin/setpriv', '/usr/bin/tini']);
  assert.ok(invocation.args.includes(`--property=CapabilityBoundingSet=${bootstrapCaps}`));
  const command = invocation.args.slice(invocation.args.indexOf('--') + 1);
  assert.deepEqual(command.slice(0, 3), ['/usr/bin/unshare', '--map-user=65532', '--map-group=65532']);
  assert.ok(command.indexOf('--bounding-set=-all') < command.indexOf(PAYLOAD_GUARD_PATH));
  assert.ok(command.indexOf(PAYLOAD_GUARD_PATH) < command.indexOf(provider.payload[0]));
  assert.ok(invocation.args.includes('--pipe'));
  await assert.rejects(build({ ...provider, payload: ['/usr/bin/sh', '/opt/runtime/hosted-app-server-launcher.js'] }), /unsupported/);
  let admitted = false;
  await assert.rejects(build(provider, { trust: async () => { throw Error('untrusted'); } }, async () => { admitted = true; }), /untrusted/);
  assert.equal(admitted, false);
});
test('both operations run Tini after dropping capabilities and before Node', async () => {
  for (const request of [job, provider]) {
    const { args } = await build(request);
    const command = args.slice(args.indexOf('--') + 1);
    assert.deepEqual(command.slice(0, command.indexOf(PAYLOAD_GUARD_PATH)), [
      '/usr/bin/unshare', '--map-user=65532', '--map-group=65532', '--keep-caps',
      '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL', '/usr/bin/setpriv',
      '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
      '/usr/bin/tini', '--', '/TRUSTED/node',
    ]);
    assert.ok(args.includes('--property=KillMode=control-group'));
    let admitted = false;
    await assert.rejects(build(request, { trust: async path => {
      if (path === '/usr/bin/tini') throw Error('untrusted Tini');
    } }, async () => { admitted = true; return admit(); }), /untrusted Tini/);
    assert.equal(admitted, false);
    await assert.rejects(build(request, { executable: async path => {
      assert.equal(path, '/usr/bin/tini');
      throw Error('Tini is not executable');
    } }, async () => { admitted = true; return admit(); }), /not executable/);
    assert.equal(admitted, false);
  }
});
test('custody is outside the managed launcher', async () => {
  for (const role of ['outer', 'ordinary']) {
    const payload = ['/usr/bin/node', role === 'outer' ? '/opt/runtime/hosted-readonly-runtime-bootstrap.js' : '/opt/runtime/hosted-readonly-host-launch-cli.js', ...(role === 'ordinary' ? ['ordinary-bootstrap'] : [])];
    const request = { operation: 'custody', unit: `subscription-runtime-${role}-${'b'.repeat(36)}.service`, cwd: '/TEST/job', payload };
    await assert.rejects(build(request), /unsupported/);
    await assert.rejects(build({ ...request, payload: ['/usr/bin/node', '/tmp/evil.js'] }), /unsupported/);
  }
});
test('provider has no writable overrides and readonly anchors cannot remap', async () => {
  const request = { ...provider, readonlyPaths: ['/etc/auth'] };
  const invocation = await build(request);
  assert.ok(invocation.args.includes('--property=BindReadOnlyPaths=/etc/auth:/etc/auth:norbind'));
  for (const workspacePath of ['/etc', '/', '/TEST/../etc']) {
    await assert.rejects(build({ ...request, mounts: { workspacePath, readonlyPaths: [] } }), /unsupported/);
  }
  await assert.rejects(build({ ...request, readonlyPaths: ['/etc:/TEST'] }), /unsupported/);
  await assert.rejects(build(request, {}, async () => { throw Error('symlink'); }), /symlink/);
});
test('malformed paths, unavailable policy and storage root fail closed', async () => {
  for (const storageRoot of ['/', '/TEST path', '/TEST%h', '/TEST\n/']) await assert.rejects(build(job, {}, async () => ({ storageRoot })), /unsupported/);
  await assert.rejects(build(job, {}, async () => { throw Error('mount unavailable'); }), /mount unavailable/);
});
test('final namespace guard refuses lost mount before payload spawn', async () => {
  let launched = false;
  await assert.rejects(runGuardedPayload(['/usr/bin/true'], { jobId: job.jobId, cwd: `/TEST/jobs/${job.jobId}/workspace`, owner: async () => 0n,
    admit: async () => { throw Error('mount lost'); }, launch: () => { launched = true; } }), /mount lost/);
  assert.equal(launched, false);
});
test('final namespace guard preserves payload and inherited streams after admission', async () => {
  const events = [];
  await runGuardedPayload(['/usr/bin/true', 'literal $argument'], { jobId: job.jobId, cwd: `/TEST/jobs/${job.jobId}/workspace`, owner: async () => 0n,
    admit: async () => { events.push('admit'); return finalAdmission(); },
    fstat: () => ({ isFile: () => false, isFIFO: () => true }),
    launch: (command, args, options) => { events.push('launch'); assert.equal(command, '/usr/bin/true'); assert.deepEqual(args, ['literal $argument']); assert.deepEqual(options, { cwd: `/TEST/jobs/${job.jobId}/workspace`, stdio: 'inherit' }); } });
  assert.deepEqual(events, ['admit', 'launch']);
});
test('trusted payload code cannot live under writable storage', async () => {
  await assert.rejects(build(job, { nodePath: '/TEST/node' }), /unsupported/);
  await assert.rejects(build({ ...provider, payload: ['/usr/bin/node', '/TEST/hosted-app-server-launcher.js'] }), /unsupported/);
});
test('regular inherited outputs must use external device; pipes and sockets accepted', async () => {
  for (const device of [1n, 2n]) {
    let launched = false;
    const invocation = runGuardedPayload(['/usr/bin/true'], { jobId: job.jobId, cwd: `/TEST/jobs/${job.jobId}/workspace`, admit: finalAdmission, owner: async () => 0n,
      fstat: () => ({ isFile: () => true, dev: device }), launch: () => { launched = true; } });
    if (device === 1n) await assert.rejects(invocation, /output outside/); else await invocation;
    assert.equal(launched, device === 2n);
  }
});
test('job opens external logs after admission and passes actual open descriptors', async () => {
  const events = [];
  await runGuardedPayload(['/usr/bin/true'], { jobId: job.jobId, cwd: `/TEST/jobs/${job.jobId}/workspace`, jobUnit: job.unit, owner: async () => 0n,
    admit: async () => { events.push('admit'); return finalAdmission(); },
    logs: async (root, unit, device) => { events.push('open'); assert.equal(root, `/TEST/jobs/${job.jobId}/payload-logs`); assert.equal(unit, job.unit); assert.equal(device, 2n);
      return [7, 8].map(fd => ({ fd, close: async () => events.push('close') })); },
    launch: (command, args, options) => { events.push('launch'); assert.deepEqual(options.stdio, ['ignore', 7, 8]); } });
  assert.deepEqual(events, ['admit', 'open', 'launch', 'close', 'close']);
});
test('both launcher profiles protect the host filesystem', async () => {
  for (const request of [job, provider]) {
    const invocation = await build(request);
    assert.ok(invocation.args.includes('--property=ProtectSystem=strict'));
  }
});
test('log descriptors reject foreign devices and hard links and close on failure', async () => {
  for (const fault of ['device', 'hardlink', 'directory', 'valid']) {
    let closed = 0;
    const metadata = { isDirectory: () => true, isSymbolicLink: () => false, uid: 0n, mode: 0o700n, dev: 2n };
    const probe = { mkdir: async () => {}, lstat: async () => ({ ...metadata, dev: fault === 'directory' ? 1n : 2n }),
      open: async () => ({ stat: async () => ({ isFile: () => true, uid: 0n, mode: 0o600n, dev: fault === 'device' ? 1n : 2n, nlink: fault === 'hardlink' ? 2n : 1n }), close: async () => closed++ }) };
    if (fault === 'valid') { const handles = await openJobLogs('/TEST', job.unit, 2n, probe); await Promise.all(handles.map(h => h.close())); assert.equal(closed, 2); }
    else { await assert.rejects(openJobLogs('/TEST', job.unit, 2n, probe), /unsafe log/); assert.equal(closed, fault === 'directory' ? 0 : 1); }
  }
});
