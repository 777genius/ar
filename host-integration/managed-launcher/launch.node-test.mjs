import test, { beforeEach, afterEach, mock } from 'node:test';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildSystemdInvocation, managedLauncherInvocation, originalJobReservation, assertOriginalReservation } from './launch.mjs';
import { runGuardedPayload as guardedPayload, PAYLOAD_GUARD_PATH, openJobLogs } from './payload-guard.mjs';
import { socketFence, bootstrapCaps } from './profiles.mjs';
import { deriveManagedJobLayout } from '../host-jobs/storage-policy.mjs';
let capabilityRead;
const actualSpawnSync = cp.spawnSync;
const completed = (stdout, status = 0, stderr = '') => ({ stdout, stderr, status, signal: null, error: undefined });
beforeEach(() => { capabilityRead = mock.method(cp, 'spawnSync', (command, ...args) => command === '/usr/bin/systemd-run' ? completed('  --expand-environment=BOOL\n') : actualSpawnSync(command, ...args)); syncBuiltinESMExports(); });
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
const old252 = () => capabilityRead.mock.mockImplementation((_file, args) => args.includes('--help')
  ? completed('', 1, "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n")
  : completed('systemd 252 (252.39-1~deb12u2)\n+PAM +AUDIT\n'));
const job = { operation: 'job', unit: `subscription-job-${'a'.repeat(64)}.service`, payload: ['/usr/bin/true'],
  jobId: 'test-1.foo-bar_', fingerprint: 'a'.repeat(64), limits: { runtimeSeconds: 90, stopSeconds: 30, memoryMiB: 256, tasksMax: 64, cpuPercent: 100 } };
const admit = async () => deriveManagedJobLayout('/TEST', job.jobId);
const finalAdmission = async () => ({ layout: deriveManagedJobLayout('/TEST', job.jobId), device: 2n });
// Existing launch-contract tests simulate a terminal child; physical pressure
// behavior has its own typed synthetic lifecycle tests.
const runGuardedPayload = (args, input) => guardedPayload(args, { ...input,
  pressure: async () => ({ attach() {}, close() {}, reason: null }),
  launch: (...params) => { input.launch?.(...params); const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null)); return child; },
});
const build = (request, options = {}, admission = admit) => buildSystemdInvocation(request, admission, {
  memoryInfo: () => 'MemAvailable: 67108864 kB\n', nodePath: '/TRUSTED/node', trust: async () => {}, executable: async () => {},
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
  assert.equal(invocation.args.includes('--service-type=exec'), true);
  assert.deepEqual(invocation.args.filter(arg => arg.startsWith('--property=TimeoutStartSec=')),
    ['--property=TimeoutStartSec=600']);
  assert.ok(invocation.args.includes('--property=TimeoutStopSec=30'));
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
test('fixed startup budget reserves the same bounded time inside original monotonic ends', async () => {
  const invocation = await build(job);
  const startup = invocation.args.find(arg => arg.startsWith('--property=TimeoutStartSec='));
  assert.equal(startup, '--property=TimeoutStartSec=600');
  const second = 1_000_000_000n;
  const reservation = originalJobReservation(job);
  assert.deepEqual(reservation, { workNs: 690n * second, cleanupNs: 720n * second });
  assert.equal(reservation.workNs, (BigInt(startup.split('=')[2]) + BigInt(job.limits.runtimeSeconds)) * second);
  const anchor = second, now = 2n * second;
  const ends = { workEndNs: now + reservation.workNs + 1n, cleanupEndNs: now + reservation.cleanupNs + 1n };
  assert.doesNotThrow(() => assertOriginalReservation(ends, reservation, anchor, now));
  assert.throws(() => assertOriginalReservation(ends, reservation, anchor, now + 1n), /original ends exhausted/);
  assert.throws(() => assertOriginalReservation(ends, reservation, anchor, anchor - 1n), /original ends exhausted/);
});
test('request denies old argv bridge, unknown operations and arbitrary policy fields', async () => {
  for (const value of [[], ['--property=ProtectSystem=no'], null, { ...job, operation: 'shell' }, { ...job, startupSeconds: 600 }, { ...provider, startupSeconds: 600 },
    ...['cwd', 'mounts', 'workspacePath', 'jobRoot', 'properties', 'args', 'capabilities', 'sockets', 'storageRoot', 'pipe', 'env', 'startupSeconds'].map(key => ({ ...job, [key]: [] }))]) {
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
  assert.deepEqual(invocation.args.filter(arg => arg.startsWith('--property=TimeoutStartSec=')),
    ['--property=TimeoutStartSec=600']);
  assert.ok(invocation.args.includes('--property=RuntimeMaxSec=8h'));
  assert.ok(invocation.args.includes('--property=TimeoutStopSec=30s'));
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

test("both supported launches derive tool bulk from admitted scratch tmp", async () => {
  for (const request of [job, provider]) {
    const { args } = await build(request);
    const env = Object.fromEntries(args.filter(x => x.startsWith("--setenv=")).map(x => {
      const value = x.slice(9), boundary = value.indexOf("=");
      return [value.slice(0, boundary), value.slice(boundary + 1)];
    }));
    const tmp = `/TEST/jobs/${job.jobId}/tmp`;
    for (const key of ["TMPDIR", "TMP", "TEMP", "GOTMPDIR"]) assert.equal(env[key], tmp);
    for (const key of ["XDG_CACHE_HOME", "npm_config_cache", "COREPACK_HOME", "YARN_CACHE_FOLDER",
      "PIP_CACHE_DIR", "UV_CACHE_DIR", "GOCACHE", "GOMODCACHE"])
      assert.ok(env[key].startsWith(tmp + "/tool-caches"), key);
    assert.equal(env.RUSTUP_HOME, undefined, "Retained scratch HOME toolchains remain selected");
    assert.equal(env.CARGO_HOME, undefined, "Cargo credential lookup remains with admitted HOME");
    assert.equal(env.HOME, `/TEST/jobs/${job.jobId}/home`);
    assert.ok(args.includes(`--property=ReadWritePaths=/TEST/jobs/${job.jobId}`));
  }
});
test("admission cannot supply a host HOME or tmp fallback", async () => {
  for (const field of ["home", "tmp"]) {
    await assert.rejects(build(job, {}, async () => ({ ...(await admit()), [field]: "/root/cache" })), /unsupported/);
  }
});

test('memory snapshot admits equality and refuses below requested max plus OS/SSH reserve', async () => {
  for (const request of [job, provider]) {
    const requiredKiB = (request.operation === 'job' ? request.limits.memoryMiB : 4096) * 1024 + 2 * 1024 ** 2;
    const { args } = await build(request, { memoryInfo: () => `MemAvailable: ${requiredKiB} kB\n` });
    assert.ok(args.includes(`--unit=${request.unit}`));
    await assert.rejects(build(request, { memoryInfo: () => `MemAvailable: ${requiredKiB - 1} kB\n` }), /memory admission unavailable/);
  }
  await assert.rejects(build({ ...job, limits: { ...job.limits, memoryMiB: 1048576 } }), /memory admission unavailable/);
});
test('unknown memory observations never yield an invocation', async () => {
  for (const memoryInfo of [() => '', () => 'MemAvailable: -1 kB\n',
    () => 'MemAvailable: 99999999 kB\nMemAvailable: 99999999 kB\n',
    () => 'x'.repeat(65536), () => { throw Error('private read error'); }]) {
    await assert.rejects(build(provider, { memoryInfo }), /^Error: managed launcher: memory admission unavailable$/);
  }
});
test('memory snapshot is taken after awaited admission, not before stale work', async () => {
  let admitted = false;
  await assert.rejects(build(provider, { memoryInfo: () => {
    assert.equal(admitted, true); return 'MemAvailable: 1 kB\n';
  } }, async () => { admitted = true; return admit(); }), /memory admission unavailable/);
});

// A pending asynchronous observation must not delay pressure service teardown.
test('pressure CLI exits finitely after its child exits despite a pending observation', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'payload-pressure-exit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Bypass this loader's suffix match while retaining the real policy exports.
  const realPolicy = new URL('../host-jobs/storage-policy.mjs?pressure-cli-fixture-real', import.meta.url).href;
  const policy = `export * from ${JSON.stringify(realPolicy)};
    export async function requireFinalJobStorage(){return {layout:{jobRoot:'/TEST/jobs/owned'},device:2n};}`;
  const pressure = `export class ScratchPressureError extends Error{}
    export async function prepareScratchPressureGuard(){return {reason:'scratch_bytes',
      attach(){setTimeout(()=>{},10000);},close(){}};}`;
  const loader = join(root, 'loader.mjs');
  writeFileSync(loader, `export async function resolve(specifier,context,next){
    const source=specifier.endsWith('/storage-policy.mjs')?${JSON.stringify(policy)}:
      specifier.endsWith('/storage-pressure-guard.mjs')?${JSON.stringify(pressure)}:null;
    return source===null?next(specifier,context):{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
  }`, { flag: 'wx', mode: 0o600 });
  const entry = fileURLToPath(new URL('./payload-guard.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-loader', loader, entry, '--', '/usr/bin/true'],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 3000, maxBuffer: 65536 });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 70, result.stderr);
});

test('stock252 closed provider preserves exact command/properties except unsupported flag', async () => {
  const modern = await build(provider); old252(); const legacy = await build(provider);
  assert.deepEqual(legacy, { command: modern.command, args: modern.args.filter(a => a !== '--expand-environment=no') });
  assert.ok(legacy.args.slice(legacy.args.indexOf('--') + 1).every(a => !a.includes('$')));
  assert.deepEqual(capabilityRead.mock.calls.slice(-2).map(c => c.arguments[1]), [['--expand-environment=no', '--help'], ['--version']]);
  for (const call of capabilityRead.mock.calls) {
    assert.equal(call.arguments[0], '/usr/bin/systemd-run');
    assert.equal(call.arguments[2].timeout, 2000); assert.equal(call.arguments[2].maxBuffer, 32768);
    assert.deepEqual(call.arguments[2].env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_COLORS: '0' });
  }
});
test('stock252 provider rejects dollars in all dynamic command operands', async () => {
  old252();
  for (const dollar of ['$USER', '${USER}', '$$', 'literal$tail']) {
    await assert.rejects(build(provider, { nodePath: '/synthetic/' + dollar }), /unsupported/);
    await assert.rejects(build(provider, { guardPath: '/synthetic/' + dollar }), /unsupported/);
  }
  for (const value of ['', 'x'.repeat(4097), 'line\nbreak', 'nul\0byte'])
    await assert.rejects(build(provider, { guardPath: value }), /unsupported/);
});
test('modern provider keeps explicit veto and literal dollar argv', async () => {
  const plan = await build(provider, { nodePath: '/synthetic/$USER', guardPath: '/synthetic/${USER}' });
  assert.ok(plan.args.includes('--expand-environment=no'));
  assert.ok(plan.args.includes('/synthetic/$USER')); assert.ok(plan.args.includes('/synthetic/${USER}'));
  assert.equal(capabilityRead.mock.callCount(), 1);
});
test('unknown capability and non252 versions refuse provider before systemd launch', async () => {
  for (const value of [completed('ambiguous help'), completed('', 1, 'foreign error'), { ...completed(''), signal: 'SIGTERM' }, { ...completed(''), error: Error('private') }]) {
    capabilityRead.mock.mockImplementation(() => value); await assert.rejects(build(provider), /unsupported/);
  }
  for (const version of ['systemd 251\n', 'systemd 253\n', 'systemd UNKNOWN\n']) {
    capabilityRead.mock.mockImplementation((_file, args) => args.includes('--help') ? completed('', 1, "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n") : completed(version));
    await assert.rejects(build(provider), /unsupported/);
  }
});
test('managed job keeps original explicit flag without provider capability IO', async () => {
  old252(); const plan = await build(job);
  assert.ok(plan.args.includes('--expand-environment=no')); assert.equal(capabilityRead.mock.callCount(), 0);
});
