import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_STORAGE_POLICY_PATH, loadHostStoragePolicy, storageProbe } from '../host-jobs/storage-policy.mjs';

// Public configuration: non-root user managers must read it, never modify it.
export const POLICY_FILE_MODE = 0o644;

export function parsePolicyArguments(argv) {
  const args = [...argv];
  const check = args[0] === '--check';
  if (check) args.shift();
  if (args.length !== 1) throw new Error('usage: install-policy [--check] /absolute/external/root');
  const [storageRoot] = args;
  if (!/^\/[A-Za-z0-9_./-]+$/.test(storageRoot) || storageRoot === '/' || resolve(storageRoot) !== storageRoot) throw new Error('storage root must be an absolute canonical safe path');
  return { check, policy: { schemaVersion: 1, storageRoot } };
}

// Reuse launch admission with a virtual candidate file; all filesystem and
// kernel mount checks still run against the actual storage root.
export async function validateCandidate(policy, probe = storageProbe) {
  const candidate = '/subscription-runtime-policy-candidate.json';
  return loadHostStoragePolicy(candidate, {
    ...probe,
    lstat: path => path === candidate ? Promise.resolve({ isSymbolicLink: () => false, isFile: () => true, uid: 0n, mode: BigInt(POLICY_FILE_MODE) }) : probe.lstat(path),
    readPolicy: async () => JSON.stringify(policy),
  });
}

async function trustedDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || await realpath(path) !== path) throw new Error('untrusted policy parent directory');
}

async function installPolicy(policy) {
  const parent = dirname(HOST_STORAGE_POLICY_PATH);
  await trustedDirectory('/');
  await trustedDirectory('/etc');
  await mkdir(parent, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await trustedDirectory(parent);
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const temporary = `${parent}/.storage-policy-${randomUUID()}.json`;
  try {
    // Root custody is required before changing an existing directory's mode.
    await directory.chown(0, 0);
    await directory.chmod(0o755);
    const previous = await lstat(HOST_STORAGE_POLICY_PATH).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== 0 || (previous.mode & 0o022) !== 0)) throw new Error('untrusted existing policy');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, POLICY_FILE_MODE);
    try {
      await file.chown(0, 0);
      await file.chmod(POLICY_FILE_MODE);
      await file.writeFile(`${JSON.stringify(policy, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await validateCandidate(policy);
    await rename(temporary, HOST_STORAGE_POLICY_PATH);
    await directory.sync();
  } finally {
    await directory.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function main(argv) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error('policy installation and check require root');
  if (process.platform !== 'linux') throw new Error('policy installation requires Linux');
  const { check, policy } = parsePolicyArguments(argv);
  await validateCandidate(policy);
  if (!check) await installPolicy(policy);
  console.log(check ? 'Storage policy candidate validated; no files changed.' : `Installed ${HOST_STORAGE_POLICY_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
