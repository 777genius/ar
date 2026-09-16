import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANAGED_STORAGE_ROOT_CONFIG, loadManagedStorageRoot, storageProbe } from '../host-jobs/storage-policy.mjs';

// Public configuration: non-root user managers must read it, never modify it.
export const CONFIG_FILE_MODE = 0o644;

export function parseStorageRootArguments(argv) {
  const args = [...argv];
  const check = args[0] === '--check';
  if (check) args.shift();
  if (args.length !== 1) throw new Error('usage: install-policy [--check] /absolute/external/root');
  const [storageRoot] = args;
  if (!/^\/[A-Za-z0-9_./-]+$/.test(storageRoot) || storageRoot === '/' || resolve(storageRoot) !== storageRoot) throw new Error('storage root must be an absolute canonical safe path');
  return { check, config: { storageRoot } };
}

// Reuse launch admission with a virtual candidate file; all filesystem and
// kernel mount checks still run against the actual storage root.
export async function validateCandidate(config, probe = storageProbe) {
  const candidate = '/subscription-runtime-storage-root-candidate';
  return loadManagedStorageRoot(candidate, {
    ...probe,
    lstat: path => path === candidate ? Promise.resolve({ isSymbolicLink: () => false, isFile: () => true, uid: 0n, mode: BigInt(CONFIG_FILE_MODE) }) : probe.lstat(path),
    readStorageRoot: async () => `${config.storageRoot}\n`,
  });
}

async function trustedDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || await realpath(path) !== path) throw new Error('untrusted config parent directory');
}

async function installStorageRoot(config) {
  const parent = dirname(MANAGED_STORAGE_ROOT_CONFIG);
  await trustedDirectory('/');
  await trustedDirectory('/etc');
  await mkdir(parent, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await trustedDirectory(parent);
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const temporary = `${parent}/.storage-root-${randomUUID()}`;
  try {
    // Root custody is required before changing an existing directory's mode.
    await directory.chown(0, 0);
    await directory.chmod(0o755);
    const previous = await lstat(MANAGED_STORAGE_ROOT_CONFIG).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== 0 || (previous.mode & 0o022) !== 0)) throw new Error('untrusted existing config');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CONFIG_FILE_MODE);
    try {
      await file.chown(0, 0);
      await file.chmod(CONFIG_FILE_MODE);
      await file.writeFile(`${config.storageRoot}\n`);
      await file.sync();
    } finally { await file.close(); }
    await validateCandidate(config);
    await rename(temporary, MANAGED_STORAGE_ROOT_CONFIG);
    await directory.sync();
  } finally {
    await directory.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function main(argv) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error('config installation and check require root');
  if (process.platform !== 'linux') throw new Error('config installation requires Linux');
  const { check, config } = parseStorageRootArguments(argv);
  await validateCandidate(config);
  if (!check) await installStorageRoot(config);
  console.log(check ? 'Storage config candidate validated; no files changed.' : `Installed ${MANAGED_STORAGE_ROOT_CONFIG}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
