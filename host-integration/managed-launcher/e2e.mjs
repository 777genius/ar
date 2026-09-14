#!/usr/bin/env node
// Explicitly opt-in: run only as root on a disposable Linux test host.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, stat, realpath, rm, unlink, rmdir, open, symlink, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { requireHostStorage, prepareManagedJobLayout } from '../host-jobs/storage-policy.mjs';

const POLICY = '/etc/subscription-runtime/storage-policy.json';
const WRAPPER = '/opt/subscription-runtime/managed-launcher/launch.mjs';
const check = (condition, message) => { if (!condition) throw new Error(message); };
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  check(!result.error && result.status === 0, `${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  check(args.length === 9 && args[0] === '--allow-live-synthetic' && args[1] === '--external-root' && args[3] === '--expected-machine-id' && args[5] === '--goal-cli' && args[7] === '--provider-launcher',
    'Usage: sudo node e2e.mjs --allow-live-synthetic --external-root /disposable/external/test-root --expected-machine-id ID --goal-cli /trusted/dist/worker-codex/codex-goal-cli.js --provider-launcher /trusted/dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js');
  check(process.platform === 'linux' && process.getuid() === 0, 'Requires root on disposable Linux host');
  check((await readFile('/etc/machine-id', 'utf8')).trim() === args[4], 'Machine identity mismatch');
  const external = resolve(args[2]);
  check(external === args[2] && external !== '/' && await realpath(external) === external && /^\/[a-zA-Z0-9_./-]+$/.test(external), 'External root must be canonical');
  check((await stat(external)).isDirectory() && (await stat(external)).dev !== (await stat('/')).dev, 'External root must be on another filesystem');
  // Read the deployed policy unchanged so launcher and final namespace guard
  // observe the same trusted admission state.
  const goalCli = resolve(args[6]);
  const providerLauncher = resolve(args[8]);
  check(providerLauncher === args[8] && providerLauncher.endsWith('/hosted-app-server-launcher.js'), 'Provider launcher must be an absolute installed runtime path');
  check(goalCli === args[6] && goalCli.endsWith('/codex-goal-cli.js'), 'Goal CLI must be an absolute installed runtime path');
  for (const path of [POLICY, WRAPPER, process.execPath, goalCli, providerLauncher]) {
    const metadata = await stat(path);
    check(await realpath(path) === path && metadata.isFile() && metadata.uid === 0 && !(metadata.mode & 0o022), `Untrusted installed file: ${path}`);
  }
  const policy = await requireHostStorage(external, POLICY);
  check(!goalCli.startsWith(`${policy.storageRoot}/`), 'Goal CLI must be outside writable storage');
  check(!providerLauncher.startsWith(`${policy.storageRoot}/`), 'Provider launcher must be outside writable storage');
  check(external.startsWith(`${policy.storageRoot}/`), 'Disposable external root must be a strict descendant of policy.storageRoot');
  run('/usr/bin/systemctl', ['show-environment']);
  const unit = `subscription-job-${randomBytes(32).toString('hex')}.service`;
  const jobId = `managed-launcher-e2e-${randomBytes(16).toString('hex')}`;
  const layout = await prepareManagedJobLayout(jobId);
  const logDirectory = layout.payloadLogs;
  let logDirectoryExisted = true;
  try { await stat(logDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; logDirectoryExisted = false; }
  const logs = ['stdout', 'stderr'].map(stream => join(logDirectory, `${unit}.${stream}.log`));
  const owned = [layout.jobRoot];
  let child;
  let foreign;
  let foreignExit;
  let foreignFd;
  let preserveFiles = false;
  try {
    const work = layout.workspace;
    const sentinel = await mkdtemp('/var/lib/managed-launcher-e2e-'); owned.push(sentinel);
    check((await stat(sentinel)).dev === (await stat('/')).dev, 'Sentinel must be backed by root filesystem');
    await chmod(sentinel, 0o777);
    const faultEvidence = [];
    for (const mode of ['missing-policy', 'untrusted-policy']) {
      const source = await mkdtemp('/var/lib/managed-launcher-policy-'); owned.push(source);
      const fingerprint = randomBytes(32).toString('hex');
      const faultUnit = `subscription-job-${fingerprint}.service`;
      const request = { operation: 'job', unit: faultUnit,
        jobId: `managed-e2e-policy-${randomBytes(16).toString('hex')}`, fingerprint,
        payload: [process.execPath, '-e', 'process.exit(97)'],
        limits: { memoryMiB: 128, runtimeSeconds: 5, stopSeconds: 5, tasksMax: 32, cpuPercent: 100 } };
      try {
        faultEvidence.push(JSON.parse(run('/usr/bin/unshare', ['--mount', '--propagation', 'private', process.execPath,
          fileURLToPath(new URL('./fixtures/policy-fault.mjs', import.meta.url)),
          JSON.stringify({ mode, source, storageRoot: policy.storageRoot, request, wrapper: WRAPPER })])));
      } finally {
        spawnSync('/usr/bin/systemctl', ['stop', faultUnit], { encoding: 'utf8', timeout: 10000 });
        const state = spawnSync('/usr/bin/systemctl', ['is-active', faultUnit], { encoding: 'utf8', timeout: 5000 });
        if (state.error || !['inactive', 'failed', 'unknown'].includes(state.stdout.trim())) preserveFiles = true;
        check(!preserveFiles, 'Policy fault unit not stopped');
      }
    }
    for (const mode of ['lost-storage', 'nested-root']) {
      const faultLayout = await prepareManagedJobLayout(`managed-e2e-fault-${randomBytes(16).toString('hex')}`);
      owned.push(faultLayout.jobRoot);
      const source = await mkdtemp('/var/lib/managed-launcher-fault-'); owned.push(source);
      await mkdir(join(faultLayout.workspace, 'nested-root'));
      const fingerprint = randomBytes(32).toString('hex');
      const faultUnit = `subscription-job-${fingerprint}.service`;
      const request = { operation: 'job', unit: faultUnit, jobId: faultLayout.jobId, fingerprint,
        payload: [process.execPath, '-e', 'process.exit(97)'],
        limits: { memoryMiB: 128, runtimeSeconds: 5, stopSeconds: 5, tasksMax: 32, cpuPercent: 100 } };
      try {
        faultEvidence.push(JSON.parse(run('/usr/bin/unshare', ['--mount', '--propagation', 'private', process.execPath,
          fileURLToPath(new URL('./fixtures/mount-fault.mjs', import.meta.url)),
          JSON.stringify({ mode, source, layout: faultLayout, request, wrapper: WRAPPER })])));
      } finally {
        // Even a broken admission may have dispatched the exact synthetic unit.
        spawnSync('/usr/bin/systemctl', ['stop', faultUnit], { encoding: 'utf8', timeout: 10000 });
        const state = spawnSync('/usr/bin/systemctl', ['is-active', faultUnit], { encoding: 'utf8', timeout: 5000 });
        if (state.error || !['inactive', 'failed', 'unknown'].includes(state.stdout.trim())) preserveFiles = true;
        check(!preserveFiles, 'Fault unit not stopped');
      }
    }
    const providerLayout = await prepareManagedJobLayout(`managed-e2e-provider-${randomBytes(16).toString('hex')}`);
    owned.push(providerLayout.jobRoot);
    const providerUnit = `subscription-runtime-hosted-${randomUUID()}.service`;
    let providerEvidence;
    try {
      const marker = `synthetic-provider-${randomBytes(16).toString('hex')}`;
      const frame = { schemaVersion: 1, command: process.execPath,
        args: ['-e', "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data); process.stdin.on('end', () => { process.stdout.write(input); process.stderr.write('synthetic-provider-stderr'); });"],
        cwd: providerLayout.workspace, env: { HOME: providerLayout.home, TMPDIR: providerLayout.tmp } };
      const roundtrip = spawnSync(process.execPath, [WRAPPER, 'provider', JSON.stringify({ operation: 'provider',
        unit: providerUnit, jobId: providerLayout.jobId, payload: [process.execPath, providerLauncher] })],
      { encoding: 'utf8', input: `${JSON.stringify(frame)}\n${marker}`, timeout: 20000 });
      check(!roundtrip.error && roundtrip.status === 0 && roundtrip.stdout === marker && roundtrip.stderr.includes('synthetic-provider-stderr'),
        `Provider pipe roundtrip failed: ${roundtrip.error?.message ?? roundtrip.stderr}`);
      providerEvidence = { pipeRoundtrip: true, installedLauncher: providerLauncher };
    } finally {
      spawnSync('/usr/bin/systemctl', ['stop', providerUnit], { encoding: 'utf8', timeout: 10000 });
      const state = spawnSync('/usr/bin/systemctl', ['is-active', providerUnit], { encoding: 'utf8', timeout: 5000 });
      if (state.error || !['inactive', 'failed', 'unknown'].includes(state.stdout.trim())) preserveFiles = true;
      check(!preserveFiles, 'Provider unit not stopped');
    }
    for (const directory of [work, layout.home]) await symlink(sentinel, join(directory, 'root-link'));
    check((await stat(WRAPPER)).dev === (await stat('/')).dev, 'Trusted hardlink source must be backed by root filesystem');
    const inheritedFile = join(sentinel, 'inherited-fd');
    foreignFd = await open(inheritedFile, 'wx', 0o600);
    await foreignFd.writeFile('synthetic-original');
    foreign = spawn('/usr/bin/setpriv', ['--securebits=+noroot,+noroot_locked', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', process.execPath, '-e',
      "process.stdout.write('synthetic-foreign-ready'); setInterval(() => {}, 1000)"],
    { cwd: sentinel, stdio: ['ignore', 'pipe', 'pipe', foreignFd.fd] });
    let foreignReady = false;
    let foreignError;
    foreign.stdout.on('data', data => { if (data.toString().includes('synthetic-foreign-ready')) foreignReady = true; });
    foreign.stderr.resume();
    foreignExit = new Promise(resolveExit => {
      foreign.once('exit', () => resolveExit(true));
      foreign.once('error', error => { foreignError = error; resolveExit(true); });
    });
    for (let i = 0; i < 50 && !foreignReady && !foreignError && foreign.exitCode === null; i++) await delay(100);
    check(foreignReady && !foreignError && foreign.exitCode === null, `Synthetic foreign process failed: ${foreignError?.message ?? 'not ready'}`);
    const foreignStatus = await readFile(`/proc/${foreign.pid}/status`, 'utf8');
    check(/^Uid:\s+0\s+0\s+0\s+0$/m.test(foreignStatus) && /^CapPrm:\s+0000000000000000$/m.test(foreignStatus), 'Foreign process must have host UID 0 and no permitted capabilities');
    check(await realpath(`/proc/${foreign.pid}/cwd`) === sentinel && await realpath(`/proc/${foreign.pid}/fd/3`) === inheritedFile, 'Foreign process did not retain synthetic cwd/fd');
    const resultPath = join(work, 'result.json');
    const probe = join(work, 'probe.mjs');
    await writeFile(join(work, 'synthetic-goal.mjs'), await readFile(new URL('./fixtures/synthetic-goal.mjs', import.meta.url)), { flag: 'wx', mode: 0o600 });
    await writeFile(probe, `import { writeFile, readFile, mkdir, readdir, lstat, statfs, link } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { runSyntheticGoal } from './synthetic-goal.mjs';
const result = {};
result.goalRunner = await runSyntheticGoal(${JSON.stringify(goalCli)}, ${JSON.stringify(layout)}, ${JSON.stringify(jobId)});
result.identity = { uid: process.getuid(), gid: process.getgid(), home: process.env.HOME };
const cli = spawnSync(process.execPath, [${JSON.stringify(goalCli)}, 'status', '--job-root', ${JSON.stringify(layout.jobRoot)}, '--task-id', ${JSON.stringify(jobId)}, '--workspace', ${JSON.stringify(work)}, '--format', 'json'], { encoding: 'utf8', timeout: 15000 });
result.goalCli = { status: cli.status, error: cli.error?.code ?? null, stdout: cli.stdout, stderr: cli.stderr };
result.symlinkWrites = {};
for (const directory of ${JSON.stringify([work, layout.home])}) {
 try { await writeFile(directory + '/root-link/symlink-escape', 'synthetic'); result.symlinkWrites[directory] = 'succeeded'; }
 catch (error) { result.symlinkWrites[directory] = error.code; }
}
try { await writeFile('/proc/self/fd/3', 'synthetic-escape'); result.inheritedFd = 'succeeded'; }
catch (error) { result.inheritedFd = error.code; }
result.layoutWrites = {};
for (const [key, directory] of Object.entries(${JSON.stringify(Object.fromEntries(['workspace', 'home', 'tmp', 'payloadLogs', 'state', 'logs', 'output', 'jobRoot'].map(key => [key, layout[key]])))})) {
 try { await writeFile(directory + '/synthetic-layout-probe', 'synthetic'); result.layoutWrites[key] = 'writable'; }
 catch (error) { result.layoutWrites[key] = error.code; }
}
result.foreignProc = {};
try { await lstat(${JSON.stringify(`/proc/${foreign.pid}`)}); result.foreignProc.visibility = 'visible'; }
catch (error) { result.foreignProc.visibility = error.code; }
for (const [name, path] of Object.entries(${JSON.stringify({ root: `/proc/${foreign.pid}/root${sentinel}/proc-root-write`, fd: `/proc/${foreign.pid}/fd/3` })})) {
 try { await writeFile(path, 'synthetic-escape'); result.foreignProc[name] = 'succeeded'; }
 catch (error) { result.foreignProc[name] = error.code; }
}
try { await link(${JSON.stringify(WRAPPER)}, ${JSON.stringify(join(work, 'forbidden-hardlink'))}); result.hardlink = 'succeeded'; }
catch (error) { result.hardlink = error.code; }
const status = await readFile('/proc/self/status', 'utf8');
result.capabilities = Object.fromEntries(status.split('\\n').filter(line => /^Cap(Eff|Bnd):/.test(line)).map(line => line.trim().split(/:\\s+/)));
result.controlSockets = {};
for (const path of ['/run/systemd/private', '/run/dbus/system_bus_socket', '/run/docker.sock', '/var/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock']) {
 result.controlSockets[path] = await new Promise(resolveSocket => {
  const socket = createConnection({ path });
  const timer = setTimeout(() => { socket.destroy(); resolveSocket('timeout'); }, 1000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveSocket('connected'); });
  socket.once('error', error => { clearTimeout(timer); resolveSocket(error.code ?? 'error'); });
 });
}
result.blockDevices = [];
async function scanDevices(path) {
 for (const entry of await readdir(path, { withFileTypes: true })) {
  const child = path + '/' + entry.name;
  if (entry.isBlockDevice()) result.blockDevices.push(child);
  else if (entry.isDirectory()) await scanDevices(child);
 }
}
await scanDevices('/dev');
await mkdir('/tmp/synthetic-mount');
const mount = spawnSync('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', '/tmp/synthetic-mount'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
result.mount = { status: mount.status, error: mount.error?.code ?? null, stderr: mount.stderr };
await writeFile(${JSON.stringify(join(work, 'external-write'))}, 'synthetic');
result.externalWrite = true;
try { await writeFile(${JSON.stringify(join(sentinel, 'must-not-exist'))}, 'failure'); result.rootWrite = 'succeeded'; }
catch (error) { result.rootWrite = error.code; }
for (const path of ['/tmp', '/var/tmp']) {
 const fs = await statfs(path); result[path] = { type: fs.type, bytes: fs.blocks * fs.bsize };
 await writeFile(path + '/synthetic-probe', 'synthetic');
}
console.log('synthetic-e2e-stdout');
console.error('synthetic-e2e-stderr');
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(result));
setTimeout(() => {}, 90000);
`, { flag: 'wx', mode: 0o600 });
    const request = { operation: 'job', unit, payload: [process.execPath, probe],
      jobId, fingerprint: unit.slice(17, -8),
      limits: { memoryMiB: 512, runtimeSeconds: 90, stopSeconds: 30, tasksMax: 64, cpuPercent: 100 } };
    child = spawn(process.execPath, [WRAPPER, 'job', JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe', foreignFd.fd] });
    let diagnostics = '';
    child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-16000); });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-16000); });
    let launchError;
    child.on('error', error => { launchError = error; });
    let result;
    for (let i = 0; i < 650; i++) {
      try { result = JSON.parse(await readFile(resultPath, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      check(!launchError && (child.exitCode === null || child.exitCode === 0), `Launcher failed: ${launchError?.message ?? diagnostics}`);
      await delay(100);
    }
    check(result, `Probe timed out: ${diagnostics}`);
    check(result.goalRunner.status === 'completed', 'Real synthetic goal runner did not complete');
    check(result.goalCli.status === 0 && result.goalCli.error === null, `Real goal CLI status failed: ${JSON.stringify(result.goalCli)}`);
    check(result.identity.uid === 65532 && result.identity.gid === 65532 && result.identity.home === layout.home, `Identity/HOME mismatch: ${JSON.stringify(result.identity)}`);
    check(Object.values(result.symlinkWrites).every(value => value === 'EROFS'), `Symlink escape not denied: ${JSON.stringify(result.symlinkWrites)}`);
    check(['ENOENT', 'EACCES', 'EPERM', 'EBADF', 'EINVAL', 'ENXIO', 'ENODEV'].includes(result.inheritedFd), `Unexpected writable inherited fd: ${result.inheritedFd}`);
    check(foreign.exitCode === null && foreign.signalCode === null, 'Foreign process exited before isolation assertion');
    check(result.foreignProc.visibility === 'ENOENT' && ['ENOENT', 'EACCES', 'EPERM'].includes(result.foreignProc.root) && ['ENOENT', 'EACCES', 'EPERM'].includes(result.foreignProc.fd), `Foreign process exposed: ${JSON.stringify(result.foreignProc)}`);
    check((await readFile(inheritedFile, 'utf8')) === 'synthetic-original', 'Inherited root-backed fd was modified');
    check(['EXDEV', 'EROFS', 'EPERM', 'EACCES'].includes(result.hardlink), `Trusted root file hardlink not denied: ${result.hardlink}`);
    check(result.capabilities.CapEff === '0000000000000000' && result.capabilities.CapBnd === '0000000000000000', `Capabilities remain: ${JSON.stringify(result.capabilities)}`);
    check(Object.values(result.controlSockets).every(value => ['masked', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(value)), `Control socket visible: ${JSON.stringify(result.controlSockets)}`);
    check(result.blockDevices.length === 0, `Block devices visible: ${result.blockDevices}`);
    check(result.mount.status !== 0 && result.mount.error === null && /permission denied|operation not permitted|must be superuser/i.test(result.mount.stderr), `Mount not denied by permissions: ${JSON.stringify(result.mount)}`);
    check(result.externalWrite && result.rootWrite === 'EROFS', `Write confinement failed: ${JSON.stringify(result)}`);
    for (const key of ['workspace', 'home', 'tmp', 'payloadLogs', 'state', 'logs', 'output', 'jobRoot']) check(result.layoutWrites[key] === 'writable', `Job path not writable: ${key}`);
    for (const [path, limit] of [['/tmp', 256 * 1024 ** 2], ['/var/tmp', 64 * 1024 ** 2]]) {
      check(result[path].type === 0x01021994 && result[path].bytes > 0 && result[path].bytes <= limit, `Unbounded/non-tmpfs ${path}`);
    }
    const properties = Object.fromEntries(run('/usr/bin/systemctl', ['show', unit, '--property=ProtectSystem,ReadWritePaths,NoNewPrivileges,MemorySwapMax,TemporaryFileSystem,RequiresMountsFor,LimitCORE,CapabilityBoundingSet,AmbientCapabilities,PrivateDevices,InaccessiblePaths,RestrictSUIDSGID,StandardOutput,StandardError']).split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    check(properties.ProtectSystem === 'strict' && properties.ReadWritePaths === layout.jobRoot && properties.NoNewPrivileges === 'yes' && properties.MemorySwapMax === '0', `Effective properties mismatch: ${JSON.stringify(properties)}`);
    check(properties.CapabilityBoundingSet?.split(/\s+/).sort().join(' ') === 'cap_setfcap cap_setpcap cap_sys_admin' && properties.AmbientCapabilities === '' && properties.PrivateDevices === 'yes' && properties.RestrictSUIDSGID === 'yes', `Privilege properties mismatch: ${JSON.stringify(properties)}`);
    for (const path of ['/run/systemd/private', '/run/dbus', '/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock']) check(properties.InaccessiblePaths?.split(/\s+/).some(value => value.replace(/^-/, '') === path), `Missing inaccessible path ${path}`);
    if (Object.hasOwn(properties, 'RequiresMountsFor')) check(properties.RequiresMountsFor.split(/\s+/).includes(policy.storageRoot), 'Missing mount dependency');
    if (Object.hasOwn(properties, 'LimitCORE')) check(properties.LimitCORE === '0', 'Core dumps are not disabled');
    for (const [index, stream] of ['stdout', 'stderr'].entries()) {
      check((await readFile(logs[index], 'utf8')).includes(`synthetic-e2e-${stream}`), `Missing external ${stream} log marker`);
    }
    check(properties.StandardOutput === 'null' && properties.StandardError === 'null', 'Guard must open external output itself');
    console.log(JSON.stringify({ ok: true, scope: 'job-confinement-and-synthetic-goal-runner', machineId: args[4], unit, faultEvidence, providerEvidence, result, properties }, null, 2));
  } catch (error) {
    // These files belong only to this randomized synthetic unit. Surface a
    // bounded diagnostic before cleanup so a failed confinement canary remains
    // actionable without retaining directories or reading unrelated logs.
    const payloadLogs = Object.fromEntries(await Promise.all(logs.map(async path => {
      try { return [path, (await readFile(path, 'utf8')).slice(-65536)]; }
      catch (readError) { return [path, `<${readError.code ?? 'unavailable'}>`]; }
    })));
    throw new Error(`${error.message}; synthetic payload logs: ${JSON.stringify(payloadLogs)}`, { cause: error });
  } finally {
    // The synthetic foreign process is owned directly, independently of systemd.
    if (foreign && foreign.exitCode === null && foreign.signalCode === null) {
      foreign.kill('SIGTERM');
      if (!await Promise.race([foreignExit, delay(2000, false)])) {
        foreign.kill('SIGKILL');
        check(await Promise.race([foreignExit, delay(2000, false)]), 'Synthetic foreign process failed to stop; preserving files');
      }
    }
    await foreignFd?.close();
    // Exact randomized unit only. Stop before deleting its writable root.
    const stop = spawnSync('/usr/bin/systemctl', ['stop', unit], { encoding: 'utf8', timeout: 15000 });
    const active = spawnSync('/usr/bin/systemctl', ['is-active', unit], { encoding: 'utf8', timeout: 15000 });
    check(!stop.error && !active.error && ['inactive', 'failed', 'unknown'].includes(active.stdout.trim()), `Cleanup could not confirm stopped unit ${unit}; preserving ${owned.join(', ')}`);
    if (['inactive', 'failed'].includes(active.stdout.trim())) {
      const reset = spawnSync('/usr/bin/systemctl', ['reset-failed', unit], { encoding: 'utf8', timeout: 15000 });
      if (reset.error || reset.status !== 0) {
        const load = spawnSync('/usr/bin/systemctl', ['show', unit, '--property=LoadState', '--value'], { encoding: 'utf8', timeout: 15000 });
        check(!load.error && load.status === 0 && load.stdout.trim() === 'not-found', `Cleanup could not reset synthetic unit ${unit}; preserving ${owned.join(', ')}`);
      }
    }
    child?.kill('SIGTERM');
    check(!preserveFiles, `A synthetic unit may remain active; preserving ${owned.join(', ')}`);
    for (const path of logs) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!logDirectoryExisted) await rmdir(logDirectory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    for (const path of owned.reverse()) await rm(path, { recursive: true, force: false });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
