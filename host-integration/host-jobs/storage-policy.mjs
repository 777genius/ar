import { lstat, stat, statfs, realpath, open, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { requireTrustedExecutable } from '../managed-launcher/profiles.mjs';

export const MANAGED_STORAGE_ROOT_CONFIG = '/etc/subscription-runtime/storage-root';
export const MANAGED_STORAGE_LIFETIME_CONFIG = '/etc/subscription-runtime/storage-lifetime-pin-v1.json';
export const MANAGED_STORAGE_LIFETIME_KIND = 'fd-openfile-bind-v1';
const execute = promisify(execFile);
export const MINIMUM_FREE_BYTES = 5368709120n;
export const MINIMUM_FREE_INODES = 50000n;
const LIMIT = 16384;
// Busy hosts can exceed four MiB. Read the full table, retaining a hard bound.
const MOUNT_LIMIT = 8 * 1024 * 1024;
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

export async function prepareManagedJobLayout(jobId, options = {}) {
  const admission = await prepareAnchoredLayout(jobId, options, false);
  return admission.layout;
}
async function prepareAnchoredLayout(jobId, { configPath = MANAGED_STORAGE_ROOT_CONFIG, probe = storageProbe, create = mkdir,
  openDirectory = path => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), expectedUid = 0n, expectedJobRoot } = {}, retain = false) {
  const config = await loadManagedStorageRoot(configPath, probe, expectedUid);
  const layout = deriveManagedJobLayout(config.storageRoot, jobId);
  if (expectedJobRoot && layout.jobRoot !== expectedJobRoot.path) throw denied('ordinary job root changed');
  const root = await probe.stat(config.storageRoot);
  if (root.dev === (await probe.stat('/')).dev) throw denied('root filesystem forbidden');
  const handles = new Map();
  let retained;
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
      // A sealed ordinary job already exists. Never recreate its parent/root
      // before proving the exact opened anchor; only its bounded children prepare.
      if (!expectedJobRoot || path !== `${config.storageRoot}/jobs` && path !== layout.jobRoot) {
        await create(anchored, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      // Every component is opened relative to a retained directory descriptor.
      // Mount loss or ancestor replacement cannot redirect creation onto root.
      const child = await openDirectory(anchored);
      handles.set(path, child);
      const metadata = await child.stat({ bigint: true });
      validate(metadata);
      if (expectedJobRoot && path === layout.jobRoot && (metadata.dev !== BigInt(expectedJobRoot.device) ||
          metadata.ino !== BigInt(expectedJobRoot.inode))) throw denied('ordinary job root changed');
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
    if (retain) retained = { layout, handles };
  } finally { if (!retained) await Promise.all([...handles.values()].map(handle => handle.close())); }
  return retained ?? { layout };
}

/** Protected files and root-only configuration are host composition, never job data. */
export async function readManagedPinFile(path, limit = 65536, privateLeaf = true) {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) ||
        (current === path ? !info.isFile() || info.nlink !== 1 || (privateLeaf && (info.mode & 0o077)) : !info.isDirectory())) throw denied('untrusted pin artifact');
    if (current === '/') break;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & (privateLeaf ? 0o077n : 0o022n)) ||
        before.size > BigInt(limit)) throw denied('pin artifact invalid');
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeNs !== after.ctimeNs ||
        bytes.length !== Number(before.size)) throw denied('pin artifact changed');
    return bytes;
  } finally { await handle.close(); }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function managedPinRuntimeDigest() {
  const files = ['../managed-launcher/launch.mjs', '../managed-launcher/payload-guard.mjs', '../managed-launcher/profiles.mjs',
    './storage-policy.mjs', './contract.mjs', './manager.mjs'];
  const rows = [];
  for (const file of files) rows.push([file, digest(await readManagedPinFile(new URL(file, import.meta.url).pathname, 1024 * 1024, false))]);
  return digest(JSON.stringify(rows));
}
/** Absent by default. Installation never manufactures this native qualification. */
export async function requireManagedPinCapability(machineId, { path = MANAGED_STORAGE_LIFETIME_CONFIG, run = execute } = {}) {
  let bytes;
  try { bytes = await readManagedPinFile(path); }
  catch (error) { if (error.code === 'ENOENT') throw denied('storage lifetime unsupported: no native qualification'); throw error; }
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'blockSource,filesystemRoot,filesystemUuid,kernelRelease,kind,machineId,mountVersion,nativeQualificationSha256,nodeVersion,runtimeSha256,schemaVersion,storageRoot,systemdVersion' ||
      value.schemaVersion !== 1 || value.kind !== MANAGED_STORAGE_LIFETIME_KIND || value.machineId !== machineId ||
      !/^[a-f0-9]{32}$/.test(value.machineId) || !/^[a-f0-9]{64}$/.test(value.nativeQualificationSha256) ||
      value.runtimeSha256 !== await managedPinRuntimeDigest() || typeof value.systemdVersion !== 'string' ||
      value.kernelRelease !== release() || value.nodeVersion !== process.version ||
      typeof value.mountVersion !== 'string' || !value.mountVersion.startsWith('mount from util-linux 2.39.3') ||
      !/^systemd 255 /.test(value.systemdVersion) || !/^\/dev\/[A-Za-z0-9]+$/.test(value.blockSource) ||
      !/^[a-f0-9-]{36}$/.test(value.filesystemUuid) || value.filesystemRoot !== '/' ||
      typeof value.storageRoot !== 'string' || resolve(value.storageRoot) !== value.storageRoot || value.storageRoot === '/') throw denied('storage lifetime capability mismatch');
  const options = { timeout: 5000, maxBuffer: 65536, encoding: 'utf8' };
  for (const executable of ['/usr/bin/systemctl', '/usr/bin/mount', '/usr/sbin/blkid']) await requireTrustedExecutable(executable);
  if ((await run('/usr/bin/systemctl', ['--version'], options)).stdout.split('\n')[0] !== value.systemdVersion ||
      (await run('/usr/bin/mount', ['--version'], options)).stdout.split('\n')[0] !== value.mountVersion ||
      (await run('/usr/sbin/blkid', ['-p', '-s', 'UUID', '-o', 'value', value.blockSource], options)).stdout.trim() !== value.filesystemUuid) throw denied('storage lifetime host mismatch');
  return Object.freeze({ ...value, capabilitySha256: digest(bytes) });
}
function pinMounts(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MOUNT_LIMIT) throw denied('invalid pin mount table');
  const lines = text.trimEnd().split('\n');
  if (lines.length > 32768) throw denied('pin mount row budget');
  const ids = new Set();
  return lines.map(line => {
    const f = line.split(' '), split = f.indexOf('-');
    if (split < 6 || f.length !== split + 4 || !/^[1-9][0-9]*$/.test(f[0]) || ids.has(f[0]) || !/^\d+:\d+$/.test(f[2])) throw denied('invalid pin mount table');
    ids.add(f[0]);
    const decode = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const root = decode(f[3]), target = decode(f[4]);
    // nsfs show_path uses a kernel namespace handle on an anonymous device.
    // Retain the row for every topology veto; it is never ext4 pin backing.
    const namespace = /^(?:cgroup|ipc|mnt|net|pid|time|user|uts):\[([1-9]\d{0,9})\]$/.exec(root);
    const namespaceDevice = /^0:([1-9]\d{0,6})$/.exec(f[2]);
    const namespaceRoot = f[split + 1] === 'nsfs' && f[split + 2] === 'nsfs' && namespace &&
      Number(namespace[1]) <= 0xffffffff && namespaceDevice && Number(namespaceDevice[1]) <= 0xfffff;
    if (((!isAbsolute(root) || resolve(root) !== root) && !namespaceRoot) ||
        !isAbsolute(target) || resolve(target) !== target) throw denied('invalid pin mount table');
    return { id: f[0], device: f[2], root, target, options: f[5].split(','), optional: f.slice(6, split),
      type: f[split + 1], source: decode(f[split + 2]), superOptions: f[split + 3].split(',') };
  });
}
const within = (value, root) => value === root || value.startsWith(root.endsWith('/') ? root : root + '/');
const writableMount = record => record.options.includes('rw') && !record.options.includes('ro') &&
  record.superOptions.includes('rw') && !record.superOptions.includes('ro');
async function fdMountId(fd) {
  const handle = await open(`/proc/self/fdinfo/${fd}`, constants.O_RDONLY);
  try {
    const bytes = await handle.readFile();
    if (bytes.length > 65536) throw denied('invalid pin descriptor');
    const matches = [...bytes.toString('utf8').matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
    if (matches.length !== 1) throw denied('invalid pin descriptor');
    return matches[0][1];
  } finally { await handle.close(); }
}
/** Actual retained directory descriptor, kept by the independently owned issuer. */
export async function captureManagedStoragePin(jobId, capability, options = {}) {
  const admission = await prepareAnchoredLayout(jobId, options, true);
  const close = async () => { await Promise.all([...admission.handles.values()].map(handle => handle.close())); };
  try {
    const handle = admission.handles.get(admission.layout.jobRoot), metadata = await handle.stat({ bigint: true });
    const mounts = pinMounts(await (options.probe ?? storageProbe).readMountInfo());
    // The selected mount is identified by the opened descriptor, never longest path.
    const mountId = await (options.fdMountId ?? fdMountId)(handle.fd);
    const backing = mounts.find(record => record.id === mountId);
    if (!backing || admission.layout.storageRoot !== capability.storageRoot || !within(admission.layout.jobRoot, backing.target) ||
        backing.source !== capability.blockSource || backing.root !== capability.filesystemRoot || backing.type !== 'ext4' || !writableMount(backing)) throw denied('pin backing mismatch');
    const [major, minor] = backing.device.split(':').map(BigInt);
    const mountDevice = ((major & 0xfffn) << 8n) | (minor & 0xffn) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
    if (mountDevice !== metadata.dev) throw denied('pin mount device mismatch');
    const filesystemRoot = resolve(backing.root, relative(backing.target, admission.layout.jobRoot));
    for (const record of mounts) {
      if (record.id === backing.id) continue;
      if (within(record.target, admission.layout.jobRoot) || (record.device === backing.device &&
          (within(record.root, filesystemRoot) || within(filesystemRoot, record.root)))) throw denied('pin alias or nested mount unsupported');
    }
    const witness = Object.freeze({ device: metadata.dev.toString(), inode: metadata.ino.toString(), filesystemRoot,
      blockSource: backing.source, filesystemUuid: capability.filesystemUuid, mountDevice: backing.device,
      capabilitySha256: capability.capabilitySha256, jobRoot: admission.layout.jobRoot });
    return Object.freeze({ layout: admission.layout, handle, witness, close });
  } catch (error) { await close(); throw error; }
}
/** Runs before any logs or payload writes, in the acquired service namespace. */
export async function requireAcquiredStoragePin(witness, probe = storageProbe,
  { openDirectory = path => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), readMountId = fdMountId } = {}) {
  if (!witness || Object.keys(witness).sort().join(',') !== 'blockSource,capabilitySha256,device,filesystemRoot,filesystemUuid,inode,jobRoot,mountDevice' ||
      !/^[1-9][0-9]*$/.test(witness.device) || !/^[1-9][0-9]*$/.test(witness.inode)) throw denied('invalid acquired pin witness');
  const info = await probe.stat(witness.jobRoot);
  if (info.dev.toString() !== witness.device || info.ino.toString() !== witness.inode || info.dev === (await probe.stat('/')).dev) throw denied('acquired pin identity mismatch');
  const anchor = await openDirectory(witness.jobRoot);
  let record, records;
  try {
    const opened = await anchor.stat({ bigint: true });
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw denied('acquired pin changed');
    records = pinMounts(await probe.readMountInfo());
    const mountId = await readMountId(anchor.fd);
    record = records.find(value => value.id === mountId);
  } finally { await anchor.close(); }
  if (!record || record.target !== witness.jobRoot) throw denied('acquired pin mount ambiguous');
  if (record.root !== witness.filesystemRoot || record.source !== witness.blockSource || record.device !== witness.mountDevice ||
      record.type !== 'ext4' || !writableMount(record) || record.optional.some(value => /^(shared|master|propagate_from):/.test(value))) throw denied('acquired pin provenance mismatch');
  if (records.some(value => value.target !== witness.jobRoot && within(value.target, witness.jobRoot))) throw denied('acquired pin nested mount unsupported');
  return Object.freeze({ mountId: record.id, device: witness.device, inode: witness.inode });
}
/** Storage admission compares canonical string paths, not binary filenames.
 * @param {string} path
 */
async function canonicalStoragePath(path) { return realpath(path); }
export const storageProbe = {
  lstat: path => lstat(path, { bigint: true }),
  stat: path => stat(path, { bigint: true }),
  statfs: path => statfs(path, { bigint: true }),
  realpath: canonicalStoragePath,
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
