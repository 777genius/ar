#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseArgs(args) {
  const options = {};
  const keys = ['external-root', 'runtime', 'node', 'sha', 'manifest-sha256'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !keys.includes(key) || options[key] || !args[i + 1]) throw new Error('invalid arguments');
    options[key] = args[i + 1];
  }
  if (keys.some(key => !options[key]) || !/^[a-f0-9]{40}$/.test(options.sha) || !/^[a-f0-9]{64}$/.test(options['manifest-sha256'])) throw new Error('required exact artifact identity missing');
  for (const key of ['external-root', 'runtime', 'node']) if (!options[key].startsWith('/') || resolve(options[key]) !== options[key] || options[key] === '/') throw new Error('canonical absolute path required');
  return options;
}

// Stable manifest of regular files; links and special files are rejected rather
// than followed into an unrelated workspace or credential store.
export function treeDigest(root) {
  const hash = createHash('sha256');
  function walk(relative) {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(relative ? `${relative}/${name}` : name);
    else if (stat.isFile()) hash.update(relative + '\0').update(createHash('sha256').update(readFileSync(path)).digest()).update('\0');
    else throw new Error('artifact contains link or special file');
  }
  walk('');
  return hash.digest('hex');
}

export function nspawnArgs(directory, name) {
  if (!/^sr-custody-canary-[a-f0-9]{16}$/.test(name) || !directory.endsWith(`/${name}/rootfs`)) throw new Error('non-disposable target refused');
  return ['--quiet', '--boot', `--directory=${directory}`, `--machine=${name}`, '--private-users=no', '--private-network', '--register=no', '--settings=no', '--link-journal=no', '--', 'systemd.unit=custody-canary.target', 'systemd.mask=systemd-journald.service'];
}

function command(program, args, timeout = 120000) {
  const result = spawnSync(program, args, { stdio: 'inherit', timeout, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LC_ALL: 'C' } });
  if (result.error || result.signal || result.status !== 0) throw new Error(`${program} failed or uncertain; preserve guest`);
}
function textFile(path, text, mode = 0o600) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode, flag: 'wx' }); }

export function main(args) {
  const o = parseArgs(args);
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Linux root operator required');
  for (const key of ['external-root', 'runtime', 'node']) if (realpathSync(o[key]) !== o[key]) throw new Error('symlink input refused');
  const external = lstatSync(o['external-root']);
  if (!external.isDirectory() || external.uid !== 0 || (external.mode & 0o022) || external.dev === lstatSync('/').dev) throw new Error('root-owned external filesystem required');
  if (lstatSync(o.node).uid !== 0 || (lstatSync(o.node).mode & 0o022)) throw new Error('trusted root-owned Node required');
  const entries = readdirSync(o.runtime).sort();
  if (entries.some(name => !['dist', 'package.json', 'node_modules'].includes(name)) || !entries.includes('dist') || !entries.includes('package.json')) throw new Error('provide sanitized dist/package.json/node_modules artifact only');
  if (treeDigest(o.runtime) !== o['manifest-sha256']) throw new Error('artifact manifest mismatch');
  const name = `sr-custody-canary-${randomBytes(8).toString('hex')}`;
  const directory = join(o['external-root'], name), rootfs = join(directory, 'rootfs');
  mkdirSync(directory, { mode: 0o700 });
  const ownership = JSON.stringify({ name, directory, rootfs });
  textFile(join(directory, 'ownership.json'), ownership);
  console.log(JSON.stringify({ name, directory, state: 'provisioning' }));
  // All installation writes occur in this freshly created tree.
  command('/usr/sbin/debootstrap', ['--variant=minbase', '--include=systemd,systemd-sysv,dbus,libstdc++6', 'bookworm', rootfs, 'https://deb.debian.org/debian'], 600000);
  const machineId = randomBytes(16).toString('hex');
  writeFileSync(join(rootfs, 'etc/machine-id'), machineId + '\n', { mode: 0o444 });
  writeFileSync(join(rootfs, 'etc/hostname'), name + '\n', { mode: 0o644 });
  const runtime = join(rootfs, 'opt/custody-canary/runtime');
  cpSync(o.runtime, runtime, { recursive: true });
  if (treeDigest(runtime) !== o['manifest-sha256']) throw new Error('copied artifact mismatch');
  mkdirSync(join(rootfs, 'usr/local/bin'), { recursive: true });
  cpSync(o.node, join(rootfs, 'usr/local/bin/node'));
  cpSync(fileURLToPath(new URL('./guest.mjs', import.meta.url)), join(rootfs, 'opt/custody-canary/guest.mjs'));
  cpSync(fileURLToPath(new URL('./guest-contract.mjs', import.meta.url)), join(rootfs, 'opt/custody-canary/guest-contract.mjs'));
  cpSync(fileURLToPath(new URL('./denied-probe.mjs', import.meta.url)), join(rootfs, 'opt/custody-canary/denied-probe.mjs'));
  textFile(join(rootfs, 'opt/custody-canary/config.json'), JSON.stringify({ name, machineId, sha: o.sha, manifestSha256: o['manifest-sha256'] }));
  for (const suffix of ['canary/job', 'canary/workspace']) mkdirSync(join(rootfs, suffix), { recursive: true, mode: 0o700 });
  // Remove enabled aliases/wants from a newly bootstrapped disposable root only.
  for (const base of ['etc/systemd/system', 'usr/lib/systemd/system']) {
    const walk = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isSymbolicLink() && /\.(service|socket|timer)$/.test(entry.name)) rmSync(child);
      }
    };
    walk(join(rootfs, base));
  }
  textFile(join(rootfs, 'etc/systemd/system/custody-canary.target'), '[Unit]\nDefaultDependencies=no\nRequires=custody-canary.service\nAfter=custody-canary.service\n', 0o644);
  textFile(join(rootfs, 'etc/systemd/system/custody-canary.service'), '[Unit]\nDefaultDependencies=no\n[Service]\nType=exec\nExecStart=/usr/local/bin/node /opt/custody-canary/guest.mjs\nWorkingDirectory=/canary/workspace\nStandardOutput=append:/canary/guest.log\nStandardError=append:/canary/guest.log\n', 0o644);
  textFile(join(rootfs, 'etc/systemd/system/custody-canary-denied.service'), '[Unit]\nDefaultDependencies=no\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/node /opt/custody-canary/denied-probe.mjs\nStandardOutput=append:/canary/denied.log\nStandardError=append:/canary/denied.log\n', 0o644);
  for (const name of ['systemd-journald.socket', 'systemd-journald-dev-log.socket', 'systemd-journald-audit.socket', 'dbus.socket']) {
    const path = join(rootfs, 'etc/systemd/system', name);
    if (!existsSync(path)) symlinkSync('/dev/null', path);
  }
  // Foreground bounded nspawn: no shared machine name, bind mount, auth or host policy.
  command('/usr/bin/systemd-nspawn', nspawnArgs(rootfs, name), 180000);
  const result = JSON.parse(readFileSync(join(rootfs, 'canary/result.json'), 'utf8'));
  textFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`canary failed; retained ${directory}`);
  console.log(JSON.stringify({ ...result, directory, retained: true }));
  // Deliberately retain even successful storage for evidence. No automated
  // recursive deletion and no stop retry following an uncertain nspawn result.
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
