import { lstat, stat, statfs, realpath, open, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const MANAGED_STORAGE_ROOT_CONFIG = '/etc/subscription-runtime/storage-root';
export const MINIMUM_FREE_BYTES = 5368709120n;
export const MINIMUM_FREE_INODES = 50000n;
const LIMIT = 16384;
const MOUNT_LIMIT = 1024 * 1024;
const denied = reason => new Error(`storage admission: ${reason}`);
export function deriveManagedJobLayout(storageRoot, jobId) {
  if (typeof jobId !== 'string' || jobId !== jobId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId) ||
      typeof storageRoot !== 'string' || !isAbsolute(storageRoot) || resolve(storageRoot) !== storageRoot || storageRoot === '/') throw denied('invalid managed identity');
  const jobRoot = `${storageRoot}/jobs/${jobId}`;
  return Object.freeze({ storageRoot, jobId, jobRoot, ...Object.fromEntries(['workspace', 'state', 'logs', 'output', 'home', 'tmp', 'payloadLogs'].map(key => [key, `${jobRoot}/${key === 'payloadLogs' ? 'payload-logs' : key}`])) });
}

// One final check inside the completed namespace. No config or capacity reload.
export async function requireFinalJobStorage({ cwd, jobId, env = process.env, probe = storageProbe }) {
  const jobRoot = env.SUBSCRIPTION_RUNTIME_JOB_ROOT;
  const suffix = `/jobs/${jobId}`;
  if (typeof jobRoot !== 'string' || !jobRoot.endsWith(suffix)) throw denied('invalid launcher boundary');
  const layout = deriveManagedJobLayout(jobRoot.slice(0, -suffix.length), jobId);
  if (env.SUBSCRIPTION_RUNTIME_JOB_ID !== jobId || jobRoot !== layout.jobRoot || cwd !== layout.workspace) {
    throw denied('invalid launcher boundary');
  }
  const job = await probe.stat(layout.jobRoot);
  if (job.dev === (await probe.stat('/')).dev) throw denied('root filesystem forbidden');
  for (const path of [layout.jobRoot, cwd]) await directories(path, probe, job.dev, layout.jobRoot);
  requireSafeNestedMounts(await probe.readMountInfo(), layout.jobRoot, job.dev);
  return Object.freeze({ layout, device: job.dev });
}

export async function prepareManagedJobLayout(jobId, { configPath = MANAGED_STORAGE_ROOT_CONFIG, probe = storageProbe, create = mkdir,
  openDirectory = path => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), expectedUid = 0n } = {}) {
  const config = await loadManagedStorageRoot(configPath, probe, expectedUid);
  const layout = deriveManagedJobLayout(config.storageRoot, jobId);
  const root = await probe.stat(config.storageRoot);
  if (root.dev === (await probe.stat('/')).dev) throw denied('root filesystem forbidden');
  const handles = new Map();
  const validate = metadata => {
    if (!metadata.isDirectory() || metadata.dev !== root.dev || metadata.uid !== expectedUid || (metadata.mode & 0o022n) !== 0n) throw denied('unsafe anchored directory');
  };
  try {
    const anchor = await openDirectory(config.storageRoot);
    handles.set(config.storageRoot, anchor);
    const initial = await anchor.stat({ bigint: true });
    validate(initial);
    if (initial.ino !== root.ino) throw denied('storage root changed');
    for (const path of [`${config.storageRoot}/jobs`, layout.jobRoot, ...['workspace', 'state', 'logs', 'output', 'home', 'tmp', 'payloadLogs'].map(key => layout[key])]) {
      const parent = handles.get(dirname(path));
      validate(await parent.stat({ bigint: true }));
      const anchored = `/proc/self/fd/${parent.fd}/${path.slice(dirname(path).length + 1)}`;
      await create(anchored, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      // Every component is opened relative to a retained directory descriptor.
      // Mount loss or ancestor replacement cannot redirect creation onto root.
      const child = await openDirectory(anchored);
      handles.set(path, child);
      validate(await child.stat({ bigint: true }));
    }
    const final = await anchor.stat({ bigint: true });
    validate(final);
    if (final.ino !== initial.ino) throw denied('storage root changed');
    // Admission is a single policy/capacity snapshot. Retained descriptors and
    // visible identity checks guard creation; later config edits apply to later jobs.
    requireSafeNestedMounts(await probe.readMountInfo(), layout.jobRoot, root.dev);
    for (const [path, handle] of handles) {
      const pinned = await handle.stat({ bigint: true });
      const visible = await probe.lstat(path);
      validate(pinned);
      if (visible.isSymbolicLink() || visible.dev !== pinned.dev || visible.ino !== pinned.ino) throw denied('layout changed');
    }
  } finally { await Promise.all([...handles.values()].map(handle => handle.close())); }
  return layout;
}
export const storageProbe = {
  lstat: path => lstat(path, { bigint: true }),
  stat: path => stat(path, { bigint: true }),
  statfs: path => statfs(path, { bigint: true }),
  realpath,
  async readMountInfo() {
    const handle = await open('/proc/self/mountinfo', constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(MOUNT_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MOUNT_LIMIT) throw denied('mount table too large');
      return buffer.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
  },
  async readStorageRoot(path, expectedUid = 0n) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.uid !== expectedUid || (metadata.mode & 0o022n) !== 0n || metadata.size > BigInt(LIMIT)) throw denied('untrusted config');
      const buffer = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LIMIT) throw denied('invalid config');
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  },
};

function requireSafeNestedMounts(text, storageRoot, device, descendants = true) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MOUNT_LIMIT) throw denied('invalid mount table');
  for (const line of text.trimEnd().split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4 || !/^\d+:\d+$/.test(fields[2])) throw denied('invalid mount table');
    const mountpoint = fields[4].replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!isAbsolute(mountpoint) || resolve(mountpoint) !== mountpoint) throw denied('invalid mount table');
    if (mountpoint !== storageRoot && (!descendants || !mountpoint.startsWith(`${storageRoot}/`))) continue;
    const [major, minor] = fields[2].split(':').map(BigInt);
    // Linux dev_t encoding, matching bigint stat.dev without Number truncation.
    const mountedDevice = ((major & 0xfffn) << 8n) | (minor & 0xffn) |
      ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
    if (mountedDevice !== device) throw denied('nested filesystem forbidden');
  }
}

async function directories(path, probe, expectedDevice, boundary, trustedParents, expectedUid = 0n) {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw denied('noncanonical path');
  const parts = [];
  for (let current = path; ; current = dirname(current)) {
    parts.push(current);
    if (current === sep) break;
  }
  for (const current of parts.reverse()) {
    const metadata = await probe.lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw denied('unsafe path');
    if (trustedParents) {
      if (metadata.uid !== expectedUid || (metadata.mode & 0o022n) !== 0n) throw denied('untrusted config parent');
      const previous = trustedParents.get(current);
      if (previous && (previous.dev !== metadata.dev || previous.ino !== metadata.ino)) throw denied('config parent changed');
      trustedParents.set(current, { dev: metadata.dev, ino: metadata.ino });
    }
    if (expectedDevice !== undefined && (current === boundary || current.startsWith(`${boundary}${sep}`)) && metadata.dev !== expectedDevice) throw denied('filesystem mismatch');
  }
  if (await probe.realpath(path) !== path) throw denied('noncanonical path');
  return probe.stat(path);
}

// Trusted composition only: config path and probes never come from job JSON.
export async function requireHostStorage(cwd, configPath, probe = storageProbe, expectedUid = 0n) {
  return validateHostStorage(() => cwd, configPath, probe, expectedUid);
}

// Validate the root before a managed launcher derives or creates its job layout.
export async function loadManagedStorageRoot(configPath = MANAGED_STORAGE_ROOT_CONFIG, probe = storageProbe, expectedUid = 0n) {
  return validateHostStorage(config => config.storageRoot, configPath, probe, expectedUid);
}

async function validateHostStorage(selectCwd, configPath, probe, expectedUid) {
  try {
    const configParents = new Map();
    await directories(dirname(configPath), probe, undefined, undefined, configParents, expectedUid);
    const metadata = await probe.lstat(configPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== expectedUid || (metadata.mode & 0o022n) !== 0n) throw denied('untrusted config');
    const text = await probe.readStorageRoot(configPath, expectedUid);
    if (Buffer.byteLength(text) > LIMIT) throw denied('invalid config');
    const storageRoot = text.replace(/\n$/, '');
    if (!/^\/[A-Za-z0-9_./-]+$/.test(storageRoot) || storageRoot === '/' || resolve(storageRoot) !== storageRoot) throw denied('invalid storage root config');
    const config = { storageRoot };
    const storageParents = new Map();
    const root = await directories(config.storageRoot, probe, undefined, undefined, storageParents, expectedUid);
    if (root.uid !== expectedUid || (root.mode & 0o022n) !== 0n) throw denied('untrusted storage root');
    if (root.dev === (await probe.stat('/')).dev) throw denied('root filesystem forbidden');
    const cwd = selectCwd(config);
    const child = relative(config.storageRoot, cwd);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw denied('cwd outside storage root');
    const working = await directories(cwd, probe, root.dev, config.storageRoot);
    const capacity = await probe.statfs(cwd);
    if (![capacity.bavail, capacity.bsize, capacity.ffree].every(value => typeof value === 'bigint' && value >= 0n) || capacity.bsize === 0n) throw denied('invalid capacity');
    if (capacity.bavail * capacity.bsize < MINIMUM_FREE_BYTES) throw denied('insufficient bytes');
    if (capacity.ffree < MINIMUM_FREE_INODES) throw denied('insufficient inodes');
    // Recheck after the capacity probe, immediately before launch admission returns.
    const finalRoot = await directories(config.storageRoot, probe, undefined, undefined, storageParents, expectedUid);
    if (finalRoot.uid !== expectedUid || (finalRoot.mode & 0o022n) !== 0n) throw denied('untrusted storage root');
    const finalWorking = await directories(cwd, probe, root.dev, config.storageRoot);
    if (finalRoot.dev !== root.dev || finalRoot.ino !== root.ino || finalWorking.dev !== root.dev || finalWorking.ino !== working.ino ||
      (await probe.stat('/')).dev === root.dev) throw denied('filesystem changed');
    // Read the bounded kernel mount table, not the potentially large job tree.
    requireSafeNestedMounts(await probe.readMountInfo(), cwd, root.dev, cwd !== config.storageRoot);
    await directories(dirname(configPath), probe, undefined, undefined, configParents, expectedUid);
    return Object.freeze(config);
  } catch (error) {
    if (error.message?.startsWith('storage admission:')) throw error;
    throw denied('config or filesystem unavailable');
  }
}
