// Dependency-free source tests, not proof of root authority or live containment.
// Run with Node 24 --experimental-transform-types --experimental-test-module-mocks --test.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import * as filesystem from 'node:fs';
import * as childProcess from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = new URL('../../', import.meta.url);
const provider = new URL('src/provider-codex/', root);
const shim = 'data:text/javascript,' + encodeURIComponent(
  `export * from ${JSON.stringify(new URL('app-server/adapters/node-app-server-process.ts', provider).href)};` +
  `export * from ${JSON.stringify(new URL('codex-provider-egress-policy.ts', provider).href)};` +
  `export * from ${JSON.stringify(new URL('app-server/adapters/hosted-process-descriptors.ts', provider).href)};` +
  `export * from ${JSON.stringify(new URL('app-server/adapters/hosted-process-activation.ts', provider).href)};`);
const coreShim = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(new URL('src/worker-core/hosted-custody/index.ts', root).href)};`);
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@vioxen/subscription-runtime/provider-codex') return { url: shim, shortCircuit: true };
  if (specifier === '@vioxen/subscription-runtime/worker-core') return { url: coreShim, shortCircuit: true };
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try { return next(specifier, context); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return next(specifier + '.ts', context);
    }
  }
  return next(specifier, context);
}});
const { default: unusedFsDefault, ...fsExports } = filesystem;
const { default: unusedChildDefault, ...childExports } = childProcess;
const files = new Map(), handles = new Map(), locks = new Set(), events = [], syncs = [], exits = [];
const epochPublishes = [];
let fd = 100, inode = 7, hostInstalled = true;
const ordinaryMountinfo = '1 0 8:1 / / rw - ext4 /dev/test rw\n';
let mountinfo = ordinaryMountinfo, failedWritePath, failedSyncPath, operatorStops = false;
const stat = (file, size = 0) => ({ isFile: () => file, isDirectory: () => !file,
  isSymbolicLink: () => false, uid: 0, nlink: file ? 1 : 2, mode: file ? 0o100600 : 0o40700,
  size, dev: 1, ino: inode, ctimeMs: 1, mtimeMs: 1 });
function missing() { throw Object.assign(new Error('synthetic absence'), { code: 'ENOENT' }); }
mock.module('node:fs', { namedExports: { ...fsExports,
  statfsSync: () => ({ type: 0xef53 }),
  lstatSync(path) {
    if (path === '/var/lib/subscription-runtime-host-policy' && !hostInstalled) missing();
    return stat(path === '/fixture/workspace/input');
  },
  openSync(path, flags) {
    if (flags & filesystem.constants.O_CREAT) {
      if (files.has(path)) throw Object.assign(new Error(), { code: 'EEXIST' });
      files.set(path, Buffer.alloc(0));
      if (!path.endsWith('/readonly-epoch.next') && !path.endsWith('/host-activation.next')) events.push(['reserve', path]);
    } else if (!(flags & filesystem.constants.O_DIRECTORY) && !files.has(path)) missing();
    handles.set(++fd, path); return fd;
  },
  fstatSync: handle => stat(true, files.get(handles.get(handle)).length),
  readSync(handle, buffer, offset, length, position) {
    return files.get(handles.get(handle)).copy(buffer, offset, position, position + length);
  },
  writeFileSync(handle, bytes) {
    if (handles.get(handle) === failedWritePath) throw new Error('synthetic interrupted publication');
    files.set(handles.get(handle), Buffer.from(bytes));
  },
  readdirSync: directory => [...files.keys()].filter(path => path.startsWith(directory + '/') &&
    !path.slice(directory.length + 1).includes('/')).map(path => path.slice(directory.length + 1)),
  renameSync(from, to) { if (!files.has(from)) missing(); files.set(to, files.get(from)); files.delete(from); epochPublishes.push(JSON.parse(files.get(to))); },
  closeSync: handle => handles.delete(handle), fsyncSync(handle) {
    const path = handles.get(handle); syncs.push(path);
    if (path === failedSyncPath) throw new Error('synthetic fsync failure');
  },
  mkdirSync(path) { assert.ok(!locks.has(path), 'overlapping lock'); locks.add(path); },
  rmdirSync(path) { assert.ok(locks.delete(path)); },
  readFileSync(path) {
    if (path === '/proc/sys/kernel/random/boot_id') return 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n';
    if (path === '/proc/self/cgroup') return '0::/synthetic-runtime\n';
    if (path === '/proc/self/uid_map') return '0 0 4294967295\n';
    if (path === '/proc/self/mountinfo') return mountinfo;
    return missing();
  },
  readlinkSync: path => 'namespace:' + path.split('/').at(-1),
} });
const { default: unusedPromisesDefault, ...promiseExports } = fsPromises;
mock.module('node:fs/promises', { namedExports: { ...promiseExports,
  lstat: async () => stat(false), mkdir: async () => {},
} });
mock.module('node:child_process', { namedExports: { ...childExports,
  spawn(command, args, options) {
    events.push(['spawn', command, args, options]);
    return { on(event, listener) { if (event === 'exit') exits.push(listener); }, stdin: { write(frame) { events.push(['bootstrap', JSON.parse(frame)]); return true; } } };
  },
  spawnSync(command, args, options) {
    assert.ok(operatorStops, 'unexpected synchronous process attempt');
    assert.equal(command, '/usr/bin/systemctl');
    events.push(['stop-request', command, args, options]);
    // Absent/pending service: this is never evidence of terminal descendants.
    return { status: 1, error: new Error('synthetic absent unit') };
  },
} });
const kernelUrl = new URL('src/worker-codex/hosted-readonly-host-kernel.ts', root);
const actualKernel = await import(kernelUrl);
mock.module(kernelUrl.href, { namedExports: { ...actualKernel,
  HostedReadonlyHostKernel: class {
    operatorSession() { return this.session(); }
    session() { return { hostId: 'a'.repeat(32), bootId: 'synthetic-boot', supervisorId: 'synthetic-supervisor' }; }
    verifyRuntimeOwner() {} // Synthetic outer ownership.
    verifyExclusiveInventory() {} // Explicit synthetic facts; separate kernel adapter tests are required.
    verifyDescriptorBoundary() {}
    fenceCreator(record) { assert.ok(files.has(actualKernel.completionPath(record)), 'no synthetic --wait completion'); }
    drainQueuedStart() {}
    confirmTerminalDescendants() {}
    requestStop(record) {
      assert.ok(operatorStops, 'unexpected synthetic stop');
      events.push(['stop-request', '/usr/bin/systemctl', ['kill', '--signal=SIGTERM', '--kill-whom=all', record.unit]]);
      events.push(['stop-request', '/usr/bin/systemctl', ['stop', '--no-block', record.unit]]);
      throw new Error('synthetic stop failure');
    }
  },
} });
const { admitHostedReadonlyInputs: admit, assertReadonlyAdmittedFactory: assertFactory } =
  await import(new URL('src/worker-codex/hosted-readonly-admission.ts', root));
const { readonlyCustodySnapshot: snapshot, createReadonlyPrivateRecord: createRecord, assertReadonlyEnrollmentProfile: enrollmentProfile } = await import(new URL('src/worker-codex/hosted-readonly-custody.ts', root));
const { egressBoundCodexProcessFactory: egressBound } = await import(new URL('app-server/adapters/egress-bound-process.ts', provider));
const { codexProviderEgressPolicy, CodexProviderEgressProfileId: Profile } = await import(shim);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const hostRoot = '/run/user/0/subscription-runtime-host-policy/';
const name = hash('job') + '.json';
const durableRoot = '/var/lib/subscription-runtime-host-policy/';
const epochPath = durableRoot + 'readonly-epoch.json';
const enrollmentPath = durableRoot + 'readonly-enrollment.json';
const path = kind => (['codex-readonly-custody', 'codex-readonly-services', 'codex-readonly-revoked'].includes(kind) ? durableRoot : hostRoot) + kind + '/' + name;
const policy = { schemaVersion: 1, jobId: 'job', jobRootDir: '/fixture/job', workspacePath: '/fixture/workspace',
  runtimeSha: 'a'.repeat(40), runtimeManifestSha256: 'b'.repeat(64), issuerDeploymentDigest: 'c'.repeat(64),
  readonlyPaths: ['/fixture/workspace/input'] };
const runtimeDirectory = root.pathname.replace(/\/$/, '');
const stagePath = hostRoot + 'codex-readonly-stages/' + hash(runtimeDirectory) + '.json';
const input = { ...policy, providerEgressPolicy: codexProviderEgressPolicy(Profile.TestManagedQualification),
  sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: 'hosted-codex-job' } };
const launch = { command: '/synthetic/codex', args: ['app-server'], cwd: '/fixture/session-home',
  env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: 'hosted-codex-job' } };
function setup(phase = 'EXCLUSIVE') {
  hostInstalled = true; files.clear(); handles.clear(); locks.clear(); events.length = 0; syncs.length = 0; exits.length = 0; epochPublishes.length = 0; inode = 7;
  mountinfo = ordinaryMountinfo; failedWritePath = undefined; failedSyncPath = undefined; operatorStops = false;
  files.set(path('codex-readonly'), json(policy));
  files.set(path('codex-egress'), json({ schemaVersion: 1, jobId: 'job', jobRootDir: policy.jobRootDir,
    workspacePath: policy.workspacePath, profileId: Profile.TestManagedQualification }));
  files.set(path('codex-readonly-reviewed'), json({ schemaVersion: 1, policy,
    reviewReference: 'synthetic independently supplied review', custodyReference: 'synthetic exclusive host custody', corepackShim: null }));
  files.set(stagePath, json({ schemaVersion: 1, runtimeDirectory,
    runtimeSha: policy.runtimeSha, runtimeManifestSha256: policy.runtimeManifestSha256 }));
  files.set(path('codex-readonly-custody'), json({ schemaVersion: 1, jobId: 'job',
    policySha256: hash(files.get(path('codex-readonly'))), reviewSha256: hash(files.get(path('codex-readonly-reviewed'))),
    stageSha256: hash(files.get(stagePath)), snapshot: snapshot(policy) }));
  files.set(epochPath, json({ schemaVersion: 1, hostId: 'a'.repeat(32), bootId: 'synthetic-boot', supervisorId: 'synthetic-supervisor',
    outerRuntime: null, generation: 1, requirement: 'test_managed_qualification', phase: 'ready', revoked: false, reservations: [], identity: {
      jobId: policy.jobId, jobRootDir: policy.jobRootDir, workspacePath: policy.workspacePath, runtimeSha: policy.runtimeSha,
      runtimeManifestSha256: policy.runtimeManifestSha256, issuerDeploymentDigest: policy.issuerDeploymentDigest,
      policySha256: hash(files.get(path('codex-readonly'))), reviewSha256: hash(files.get(path('codex-readonly-reviewed'))),
      stageSha256: hash(files.get(stagePath)), grantSha256: hash(files.get(path('codex-egress'))),
    } }));
  files.set(enrollmentPath, json({ ...JSON.parse(files.get(epochPath)), phase: 'closed' }));
  const inventory = { schemaVersion: 2, hostId: 'a'.repeat(32), supervisorUnit: 'synthetic.service',
    units: [{ name: 'synthetic.service', controlGroup: '/system.slice/synthetic.service', fragmentSha256: 'd'.repeat(64) }],
    runtimeLaunch: { command: '/synthetic/node', args: ['/synthetic/cli'], cwd: policy.workspacePath }, ordinaryCreators: [], disabledCreators: [] };
  files.set(durableRoot + 'readonly-inventory.json', json(inventory));
  files.set(durableRoot + 'host-installation.json', json({ schemaVersion: 1, installationId: 'synthetic-installation',
    hostId: inventory.hostId, runtimeDirectory, runtimeSha: policy.runtimeSha, runtimeManifestSha256: policy.runtimeManifestSha256,
    inventorySha256: hash(json(inventory)) }));
  const origins = json({ schemaVersion: 1, installationId: 'synthetic-installation', revision: 1, origins: [] });
  files.set(durableRoot + 'ordinary-origins.json', origins);
  files.set(durableRoot + 'host-activation.json', json({ schemaVersion: 1, installationId: 'synthetic-installation',
    hostId: inventory.hostId, bootId: 'synthetic-boot', supervisorId: 'synthetic-supervisor', generation: 1,
    phase, ordinaryOriginsSha256: hash(origins), exclusiveEnrollmentSha256: hash(files.get(enrollmentPath)), ordinaryStarts: [] }));

}
// Explicit synthetic prior activation fact for interrupted lifecycle cases.
// Real enter/leave transitions and OS inventory are composed in Vitest suites.
function seedPreparation() {
  const path = durableRoot + 'host-activation.json';
  files.set(path, json({ ...JSON.parse(files.get(path)), phase: 'ENTERING_EXCLUSIVE' }));
}
function completeLastProxy() { const listener = exits.shift(); assert.ok(listener); listener(0, null); }
test('actual admission/real adapter against explicitly synthetic root filesystem and process facts', async t => {
  const originalUid = process.getuid;
  process.getuid = () => 0;
  try {
    await t.test('valid receipt uses real adapter; reserves before spawn; ignores mount/launcher substitution', () => {
      setup(); const factory = admit(input); assertFactory(factory, policy.workspacePath);
      assert.throws(() => assertFactory(factory, '/other'));
      assert.throws(() => assertFactory(() => {}, policy.workspacePath));
      factory({ ...launch, admittedMounts: { readonlyPaths: ['/attacker'] }, platform: 'darwin', hostedLauncher: '/attacker' });
      assert.equal(events[0][0], 'reserve'); assert.equal(events[1][0], 'spawn');
      assert.equal(events[1][1], '/usr/bin/systemd-run');
      assert.ok(events[1][2].includes('--property=BindReadOnlyPaths=/fixture/workspace/input:/fixture/workspace/input:norbind'));
      assert.ok(!events[1][2].join(' ').includes('/attacker'));
      assert.equal(locks.size, 0); assert.equal(handles.size, 0);
    });
    await t.test('egress stays outermost across distinct account homes', () => {
      setup(); const guarded = admit(input);
      const factory = egressBound(input.providerEgressPolicy, guarded);
      for (const account of ['a', 'b']) { factory({ ...launch, cwd: '/fixture/session-' + account,
        env: { ...launch.env, SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: Profile.ProviderApi } }); completeLastProxy(); }
      const frames = events.filter(row => row[0] === 'bootstrap').map(row => row[1]);
      assert.equal(frames.length, 2);
      assert.deepEqual(frames.map(frame => frame.cwd), ['/fixture/session-a', '/fixture/session-b']);
      assert.ok(frames.every(frame => frame.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE === Profile.TestManagedQualification));
    });
    for (const kind of ['codex-readonly', 'codex-egress', 'codex-readonly-reviewed', 'codex-readonly-custody', 'stage']) {
      await t.test('missing ' + kind + ' rejects before process creation', () => {
        setup(); files.delete(kind === 'stage' ? stagePath : path(kind));
        assert.throws(() => admit(input)); assert.equal(events.length, 0);
      });
      await t.test('revalidates ' + kind + ' at every respawn/account switch', () => {
        setup(); const factory = admit(input); factory(launch);
        const spawns = events.filter(row => row[0] === 'spawn').length;
        files.delete(kind === 'stage' ? stagePath : path(kind));
        assert.throws(() => factory(launch));
        assert.equal(events.filter(row => row[0] === 'spawn').length, spawns);
      });
    }
    for (const [label, kind, mutate] of [
      ['wrong job', 'codex-readonly', value => ({ ...value, jobId: 'other' })],
      ['wrong job root', 'codex-readonly', value => ({ ...value, jobRootDir: '/other/job' })],
      ['wrong workspace', 'codex-readonly', value => ({ ...value, workspacePath: '/other', readonlyPaths: ['/other/input'] })],
      ['wrong runtime', 'codex-readonly', value => ({ ...value, runtimeSha: 'd'.repeat(40) })],
      ['wrong manifest', 'codex-readonly', value => ({ ...value, runtimeManifestSha256: 'd'.repeat(64) })],
      ['self-authored deployment approval', 'codex-readonly', value => ({ ...value, issuerDeploymentDigest: 'd'.repeat(64) })],
      ['changed path projection', 'codex-readonly', value => ({ ...value, readonlyPaths: ['/fixture/workspace/other'] })],
      ['unknown approval field', 'codex-readonly-reviewed', value => ({ ...value, approved: true })],
      ['missing custody evidence reference', 'codex-readonly-reviewed', value => ({ ...value, custodyReference: '' })],
      ['unsealed shim target', 'codex-readonly-reviewed', value => ({ ...value, corepackShim: { path: '/fixture/workspace/input/shim', target: '/outside' } })],
      ['downgraded genuine grant', 'codex-egress', value => ({ ...value, profileId: Profile.ProviderApi })],
      ['foreign stage directory', 'stage', value => ({ ...value, runtimeDirectory: '/other/runtime' })],
      ['stage commit mismatch', 'stage', value => ({ ...value, runtimeSha: 'd'.repeat(40) })],
      ['stage manifest mismatch', 'stage', value => ({ ...value, runtimeManifestSha256: 'd'.repeat(64) })],
    ]) {
      await t.test(label + ' rejects both admission and reuse of an admitted factory', () => {
        setup(); const factory = admit(input);
        const target = kind === 'stage' ? stagePath : path(kind);
        files.set(target, json(mutate(JSON.parse(files.get(target)))));
        assert.throws(() => admit(input)); assert.throws(() => factory(launch));
        assert.equal(events.length, 0); assert.equal(locks.size, 0);
      });
    }
    await t.test('durable revocation and replaced inputs reject another spawn', () => {
      setup(); const factory = admit(input); files.set(path('codex-readonly-revoked'), json({ schemaVersion: 1, jobId: 'job' }));
      assert.throws(() => factory(launch)); assert.equal(events.length, 0);
      files.delete(path('codex-readonly-revoked')); inode++;
      assert.throws(() => factory(launch)); assert.equal(events.length, 0);
    });
    for (const [label, layout] of [
      ['writable alias', ordinaryMountinfo + '2 1 8:1 /fixture/workspace/input /alias rw - ext4 /dev/test rw\n'],
      ['readonly alias with separate remount lifecycle', ordinaryMountinfo + '2 1 8:1 /fixture/workspace /alias ro - ext4 /dev/test rw\n'],
      ['ancestor alias', ordinaryMountinfo + '2 1 8:1 /fixture /alias rw - ext4 /dev/test rw\n'],
      ['escaped alias', ordinaryMountinfo + '2 1 8:1 /fixture/workspace /other\\040view rw - ext4 /dev/test rw\n'],
      ['bound workspace with original exposure', ordinaryMountinfo + '2 1 8:1 /original /fixture/workspace rw - ext4 /dev/test rw\n'],
      ['ambiguous stacked workspace', ordinaryMountinfo + '2 1 8:1 /fixture/workspace /fixture/workspace rw - ext4 /dev/test rw\n3 1 8:1 /fixture/workspace /fixture/workspace rw - ext4 /dev/test rw\n'],
      ['nested mount', ordinaryMountinfo + '2 1 8:2 / /fixture/workspace/input rw - ext4 /dev/other rw\n'],
      ['malformed mountinfo', '1 0 8:1 / / rw\n'],
    ]) {
      await t.test(label + ' rejects initial admission and a later spawn', () => {
        setup(); const factory = admit(input); factory(launch);
        const count = events.length; mountinfo = layout;
        assert.throws(() => admit(input), /custody_invalid/);
        assert.throws(() => factory(launch), /custody_invalid/);
        assert.equal(events.length, count); assert.equal(locks.size, 0);
      });
    }
    await t.test('unrelated backing roots and distinct devices preserve valid layout', () => {
      setup(); const factory = admit(input);
      mountinfo += '2 1 8:1 /unrelated /elsewhere rw - ext4 /dev/test rw\n' +
        '3 1 8:2 /fixture/workspace /separate rw - ext4 /dev/other rw\n';
      factory(launch); assert.equal(events.filter(row => row[0] === 'spawn').length, 1);
    });
    await t.test('separate filesystem ancestry maps subvolume roots before checking aliases', () => {
      setup();
      mountinfo = '1 0 8:2 / / rw - ext4 /dev/system rw\n' +
        '2 1 8:1 /volume /fixture rw - btrfs /dev/test rw\n';
      const factory = admit(input); factory(launch);
      mountinfo += '3 1 8:1 /volume/workspace/input /alias rw - btrfs /dev/test rw\n';
      assert.throws(() => factory(launch), /custody_invalid/);
      assert.equal(events.filter(row => row[0] === 'spawn').length, 1);
    });
    await t.test('create-only publication permits identical replay and preserves conflicting/partial records', () => {
      setup(); const target = durableRoot + 'codex-readonly-custody/replay.json';
      createRecord(target, json({ reviewed: true }));
      createRecord(target, json({ reviewed: true }));
      assert.throws(() => createRecord(target, json({ reviewed: false })), /conflicting_enrollment/);
      assert.deepEqual(files.get(target), json({ reviewed: true }));
      files.set(target, Buffer.from('{'));
      assert.throws(() => createRecord(target, json({ reviewed: true })), /conflicting_enrollment/);
      assert.equal(files.get(target).toString(), '{');
      assert.equal(handles.size, 0);
    });
    await t.test('uninstalled local defaults remain available; hosted and managed origin cannot downgrade to API', () => {
      setup(); const ordinary = { ...input, providerEgressPolicy: codexProviderEgressPolicy(Profile.ProviderApi) };
      assert.throws(() => admit(ordinary));
      files.clear(); assert.throws(() => admit(ordinary), /hosted_activation_authority_required/);
      hostInstalled = false; assert.equal(admit({ ...ordinary, sourceEnv: {} }), undefined);
      hostInstalled = true;
      files.set(path('codex-readonly-revoked'), json({ schemaVersion: 1, jobId: 'job' }));
      assert.throws(() => admit(ordinary));
    });
  } finally { process.getuid = originalUid; }
});

let operatorInvocation = 0;
async function operator(...args) {
  const saved = { argv: process.argv, out: process.stdout.write, err: process.stderr.write, exitCode: process.exitCode };
  let stdout = '', stderr = '';
  process.argv = ['node', 'hosted-readonly-inputs-cli', ...args];
  process.stdout.write = chunk => { stdout += chunk; return true; };
  process.stderr.write = chunk => { stderr += chunk; return true; };
  process.exitCode = undefined;
  try {
    await import(new URL('src/worker-codex/hosted-readonly-inputs-cli.ts?test=' + ++operatorInvocation, root));
    return { stdout, stderr, exitCode: process.exitCode ?? 0 };
  } finally {
    process.argv = saved.argv; process.stdout.write = saved.out; process.stderr.write = saved.err;
    process.exitCode = saved.exitCode;
  }
}
function unenrolled() {
  setup('ENTERING_EXCLUSIVE'); files.delete(path('codex-readonly')); files.delete(path('codex-readonly-custody'));
  files.set('/review/candidate.json', json(policy));
}
test('actual operator entrypoint with synthetic root facts; no real service operations', async t => {
  const originalUid = process.getuid; process.getuid = () => 0;
  try {
    await t.test('explicit first enrollment stays CLOSED until successful fresh recovery', async () => {
      unenrolled(); files.delete(epochPath); files.delete(enrollmentPath);
      const active = JSON.parse(files.get(durableRoot + 'host-activation.json'));
      files.set(durableRoot + 'host-activation.json', json({ ...active, exclusiveEnrollmentSha256: null }));
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
      assert.equal((await operator('recover', 'job')).exitCode, 1);
      const result = await operator('enroll', '/review/candidate.json');
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(files.get(epochPath)).phase, 'closed');
      assert.equal(JSON.parse(files.get(epochPath)).generation, 1);
      assert.ok(events.findIndex(row => row[1] === enrollmentPath) < events.findIndex(row => row[1] === path('codex-readonly')));
      assert.throws(() => admit(input));
      const recovered = await operator('recover', 'job');
      assert.equal(recovered.exitCode, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).generation, 2);
      assert.equal((await operator('finish-exclusive')).exitCode, 0);
      const factory = admit(input); factory(launch); completeLastProxy();
      assert.equal(JSON.parse(files.get(epochPath)).reservations[0].state, 'terminal');
    });
    await t.test('same-session recovery invalidates a previously admitted factory', async () => {
      setup(); const factory = admit(input);
      seedPreparation();
      assert.equal((await operator('recover', 'job')).exitCode, 0);
      assert.throws(() => factory(launch));
      assert.equal(JSON.parse(files.get(epochPath)).phase, 'closed');
      assert.deepEqual(JSON.parse(files.get(epochPath)).reservations, []);
      assert.ok(!events.some(row => row[0] === 'spawn'));
      assert.equal((await operator('recover', 'job')).exitCode, 0);
      assert.equal((await operator('finish-exclusive')).exitCode, 0);
      admit(input)(launch); completeLastProxy();
    });
    await t.test('pending revocation is recovered durably but never regains READY', async () => {
      setup('ENTERING_EXCLUSIVE');
      files.set(durableRoot + 'readonly-epoch.next', json({ ...JSON.parse(files.get(epochPath)), phase: 'closed', revoked: true }));
      assert.throws(() => admit(input), /publication_recovery_required/);
      assert.equal((await operator('recover', 'job')).exitCode, 1);
      assert.equal(JSON.parse(files.get(epochPath)).revoked, true);
      assert.equal(JSON.parse(files.get(epochPath)).phase, 'closed');
      assert.ok(!files.has(durableRoot + 'readonly-epoch.next'));
      assert.ok(!events.some(row => row[0] === 'spawn'));
    });
    await t.test('pending start survives recovery without a creator completion proof', async () => {
      setup(); admit(input)(launch); seedPreparation();
      const pending = JSON.parse(files.get(epochPath));
      files.set(epochPath, json({ ...pending, reservations: [] }));
      files.set(durableRoot + 'readonly-epoch.next', json(pending));
      assert.equal((await operator('recover', 'job')).exitCode, 1);
      const retained = JSON.parse(files.get(epochPath));
      assert.equal(retained.phase, 'closed');
      assert.deepEqual(retained.reservations, pending.reservations);
      assert.equal(retained.generation, pending.generation + 1);
    });
    await t.test('lost durable epoch cannot be restored by admit, recover or repeated enroll', async () => {
      setup(); files.set('/review/candidate.json', json(policy)); files.delete(epochPath);
      for (const [action, operand] of [['admit', '/review/candidate.json'], ['enroll', '/review/candidate.json'], ['recover', 'job']]) {
        assert.equal((await operator(action, operand)).exitCode, 1);
        assert.ok(!files.has(epochPath));
      }
    });
    await t.test('revoked and changed volatile material cannot regain READY through recovery', async () => {
      for (const change of ['grant', 'lease', 'revoked']) {
        setup('ENTERING_EXCLUSIVE');
        if (change === 'grant') files.delete(path('codex-egress'));
        if (change === 'lease') files.delete(path('codex-readonly-custody'));
        if (change === 'revoked') files.set(epochPath, json({ ...JSON.parse(files.get(epochPath)), phase: 'closed', revoked: true }));
        assert.equal((await operator('recover', 'job')).exitCode, 1);
        assert.equal(JSON.parse(files.get(epochPath)).phase, 'closed');
        assert.ok(!events.some(row => row[0] === 'spawn'));
      }
    });
    await t.test('admit publishes lease before policy and identical replay succeeds', async () => {
      unenrolled();
      const result = await operator('admit', '/review/candidate.json');
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(events.map(row => row[1]), [path('codex-readonly-custody'), path('codex-readonly')]);
      assert.equal(JSON.parse(result.stdout).custodyLeaseRetained, true);
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 0);
      assert.equal(events.length, 2); assert.equal(handles.size, 0); assert.equal(locks.size, 0);
      assert.equal((await operator('finish-exclusive')).exitCode, 0);
      assertFactory(admit(input), policy.workspacePath);
    });
    await t.test('missing independent approval cannot be manufactured by candidate', async () => {
      unenrolled(); files.delete(path('codex-readonly-reviewed'));
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
      assert.equal(events.length, 0); assert.ok(!files.has(path('codex-readonly')));
    });
    await t.test('interrupted policy publication retains lease and rejects launch or conflicting replay', async () => {
      unenrolled(); failedWritePath = path('codex-readonly');
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
      assert.ok(files.has(path('codex-readonly-custody')));
      assert.equal(files.get(path('codex-readonly')).length, 0);
      assert.throws(() => admit(input));
      failedWritePath = undefined;
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
      assert.equal(files.get(path('codex-readonly')).length, 0);
      assert.equal(handles.size, 0); assert.equal(locks.size, 0);
    });
    await t.test('revoke stops reserved units but absent units never release custody; replay retries stop', async () => {
      setup(); const factory = admit(input); factory(launch);
      const lease = files.get(path('codex-readonly-custody')); operatorStops = true;
      const result = await operator('revoke', 'job');
      assert.equal(result.exitCode, 1, 'failed stop must not claim success');
      assert.equal(JSON.parse(files.get(epochPath)).revoked, true);
      const stops = events.filter(row => row[0] === 'stop-request');
      assert.equal(stops.length, 2);
      assert.deepEqual(stops[0][2].slice(0, 3), ['kill', '--signal=SIGTERM', '--kill-whom=all']);
      assert.deepEqual(stops[1][2].slice(0, 2), ['stop', '--no-block']);
      assert.ok(files.get(path('codex-readonly-custody')).equals(lease));
      assert.ok(files.has(path('codex-readonly'))); assert.throws(() => factory(launch));
      assert.equal((await operator('revoke', 'job')).exitCode, 1);
      assert.equal(events.filter(row => row[0] === 'stop-request').length, 4);
      files.set('/review/candidate.json', json(policy));
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
    });
    await t.test('persistent enrollment and new parent names are synced before volatile policy publication', async () => {
      unenrolled();
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 0);
      const policySync = syncs.indexOf(path('codex-readonly'));
      for (const required of [path('codex-readonly-custody'), durableRoot.slice(0, -1), '/var/lib', '/var', '/']) {
        assert.ok(syncs.indexOf(required) >= 0 && syncs.indexOf(required) < policySync, required);
      }
      syncs.length = 0;
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 0);
      assert.ok(syncs.includes(path('codex-readonly-custody')), 'replay fsyncs the permanent enrollment');
    });
    await t.test('persistent fsync failure retains identity but cannot publish volatile admission', async () => {
      unenrolled(); failedSyncPath = '/var/lib';
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
      assert.ok(files.has(path('codex-readonly-custody')));
      assert.ok(!files.has(path('codex-readonly')));
      assert.throws(() => enrollmentProfile('job', false), /managed_grant_required/);
    });
    await t.test('invalid revocation identities cannot publish oversized or control-bearing tombstones', async () => {
      setup();
      for (const id of ['', 'x'.repeat(257), 'job\nforged']) {
        assert.equal((await operator('revoke', id)).exitCode, 1);
      }
      assert.equal(events.length, 0);
    });
    await t.test('crashed mutex rejects enrollment without clearing unresolved custody', async () => {
      unenrolled(); locks.add(path('codex-readonly-custody') + '.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.lock');
      assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1);
      assert.equal(events.length, 0); assert.equal(locks.size, 1);
    });
    await t.test('operator rejects non-root even with synthetic approval records', async () => {
      unenrolled(); process.getuid = () => 65534;
      try { assert.equal((await operator('admit', '/review/candidate.json')).exitCode, 1); }
      finally { process.getuid = () => 0; }
      assert.equal(events.length, 0);
    });
  } finally { process.getuid = originalUid; }
});


test('durable enrollment excludes ordinary fallback after complete volatile loss', t => {
  t.mock.method(process, 'getuid', () => 0);
  setup();
  for (const key of files.keys()) if (key.startsWith(hostRoot)) files.delete(key);
  assert.throws(() => enrollmentProfile('job', false), /managed_grant_required/);
  assert.throws(() => admit({ ...input, providerEgressPolicy: codexProviderEgressPolicy(Profile.ProviderApi) }), /managed_grant_required/);
  assert.throws(() => admit(input), /policy_required/);
  // An unrelated identity retains its ordinary profile; no de-enrollment occurs.
  assert.doesNotThrow(() => enrollmentProfile('unrelated', false));
});
test('durable revocation excludes every profile after volatile loss and factory recreation', t => {
  t.mock.method(process, 'getuid', () => 0);
  setup();
  files.set(path('codex-readonly-revoked'), json({ schemaVersion: 1, jobId: 'job' }));
  for (const key of files.keys()) if (key.startsWith(hostRoot)) files.delete(key);
  for (const managed of [true, false]) assert.throws(() => enrollmentProfile('job', managed), /revoked/);
  assert.throws(() => admit(input), /revoked/);
  assert.throws(() => admit({ ...input, providerEgressPolicy: codexProviderEgressPolicy(Profile.ProviderApi) }), /revoked/);
});
