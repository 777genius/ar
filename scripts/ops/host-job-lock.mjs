import { mkdir, lstat, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).stdout.trim(); }
  catch (error) { if (error.code === 1) return ''; throw error; }
}
export async function hostLock(directory, key, { timeoutMs = 30000, processIdentity = identity } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('socket directory must be private and owned by current user');
  const lock = join(directory, `${key}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let owner;
    try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (owner) {
      if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.started !== 'string') throw new Error('invalid host lock owner');
      const current = await processIdentity(owner.pid);
      if (!current || current !== owner.started) {
        // The owner may release and exit while ps is running. Only a still
        // published matching owner is evidence of a stale lock; never remove it.
        let published;
        try { published = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (published?.pid === owner.pid && published?.started === owner.started) throw new Error(`stale host lock: ${lock}; operator reconciliation required`);
      }
    }
    // Empty locks may belong to a process between mkdir and owner publication.
    // Never steal them, or stale locks, while a service outcome is unresolved.
    if (Date.now() >= deadline) throw new Error('host lock queue timeout');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    const temporary = join(lock, 'owner.pending');
    await writeFile(temporary, JSON.stringify({ pid: process.pid, started: await processIdentity(process.pid) }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(lock, 'owner.json'));
  } catch (error) { await rmdir(lock).catch(() => {}); throw error; }
  return async () => {
    await unlink(join(lock, 'owner.json'));
    await rmdir(lock);
  };
}
