import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

// Only invoked by the opt-in E2E inside a private child mount namespace.
const { mode, source, storageRoot, request, wrapper } = JSON.parse(process.argv[2]);
const check = (condition, message) => { if (!condition) throw new Error(message); };
check(['missing-policy', 'untrusted-policy'].includes(mode), 'Unknown policy fault');
check((await stat(source)).dev === (await stat('/')).dev, 'Policy fault sentinel must be root-backed');
const mounts = await readFile('/proc/self/mountinfo', 'utf8');
check(!mounts.split('\n').some(line => / (?:shared|master):\d+/.test(line)), 'Mount propagation is not private');
check(await readlink('/proc/self/ns/mnt') !== await readlink(`/proc/${process.ppid}/ns/mnt`), 'Must run in a child mount namespace');
const policyDirectory = join(source, 'policy');
const sentinel = join(source, 'sentinel');
await mkdir(policyDirectory, { mode: 0o755 });
await mkdir(sentinel, { mode: 0o755 });
if (mode === 'untrusted-policy') {
  const path = join(policyDirectory, 'storage-root');
  await writeFile(path, await readFile('/etc/subscription-runtime/storage-root'), { flag: 'wx', mode: 0o666 });
  await chmod(path, 0o666);
}
for (const [from, to] of [[policyDirectory, '/etc/subscription-runtime'], [sentinel, storageRoot]]) {
  const mounted = spawnSync('/usr/bin/mount', ['--bind', from, to], { encoding: 'utf8', timeout: 3000 });
  check(!mounted.error && mounted.status === 0, `Private policy fault mount failed: ${mounted.stderr}`);
}
const launched = spawnSync(process.execPath, [wrapper, 'job', JSON.stringify(request)], { encoding: 'utf8', timeout: 5000 });
const expected = mode === 'missing-policy' ? /storage admission: config or filesystem unavailable/ : /storage admission: untrusted config/;
check(!launched.error && launched.status !== null && launched.status !== 0 && expected.test(launched.stderr),
  `Installed launcher did not reject ${mode} at policy admission: ${launched.error?.message ?? launched.stderr}`);
check((await readdir(sentinel)).length === 0, 'Policy fault created root-backed job files');
check((await readdir(policyDirectory)).sort().join(',') === (mode === 'missing-policy' ? '' : 'storage-root'),
  'Policy fault created unexpected root-backed policy files');
console.log(JSON.stringify({ mode, admissionDenied: true, rootWrites: 0 }));
