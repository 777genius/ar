import { spawnSync } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import { requireFinalJobStorage } from '/opt/subscription-runtime/host-jobs/storage-policy.mjs';

// Parent executes this helper under unshare --mount --propagation private.
// Mounts vanish with the child; no host policy or shared mount is changed.
const { mode, source, layout, request, wrapper } = JSON.parse(process.argv[2]);
const check = (condition, message) => { if (!condition) throw new Error(message); };
check(['lost-storage', 'nested-root'].includes(mode), 'Unknown fault');
check((await stat(source)).dev === (await stat('/')).dev, 'Fault source must be root-backed');
// Assert unshare actually gave this process private propagation before mutation.
const mounts = await readFile('/proc/self/mountinfo', 'utf8');
check(!mounts.split('\n').some(line => / (?:shared|master):\d+/.test(line)), 'Mount propagation is not private');
const target = mode === 'lost-storage' ? layout.storageRoot : `${layout.workspace}/nested-root`;
const mount = spawnSync('/usr/bin/mount', ['--bind', source, target], { encoding: 'utf8', timeout: 5000 });
check(!mount.error && mount.status === 0, `Fault mount failed: ${mount.stderr}`);
const launched = spawnSync(process.execPath, [wrapper, 'job', JSON.stringify(request)], { encoding: 'utf8', timeout: 10000 });
check(!launched.error && launched.status !== 0 && /storage admission: (root filesystem forbidden|nested filesystem forbidden)/.test(launched.stderr),
  `Wrapper did not reject ${mode} at storage admission: ${launched.stderr}`);
check((await readdir(source)).length === 0, 'Fault redirected writes onto root filesystem');
let finalError;
try {
  await requireFinalJobStorage({ cwd: layout.workspace, jobId: layout.jobId, env: {
    SUBSCRIPTION_RUNTIME_JOB_ROOT: layout.jobRoot,
    SUBSCRIPTION_RUNTIME_JOB_ID: layout.jobId,
  } });
} catch (error) { finalError = error; }
const finalDenied = /storage admission: (root filesystem forbidden|nested filesystem forbidden)/.test(finalError?.message ?? '') ||
  (mode === 'lost-storage' && finalError?.code === 'ENOENT' && finalError.message.includes(layout.jobRoot));
check(finalDenied,
  `Final namespace admission did not reject ${mode}: ${finalError?.message}`);
console.log(JSON.stringify({ mode, admissionDenied: true, finalGuardDenied: true, rootWrites: 0 }));
