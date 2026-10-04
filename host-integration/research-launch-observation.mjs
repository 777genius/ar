// Bounded, non-secret operator observation. This is never an authority receipt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

function canonical(path) {
  if (typeof path !== 'string' || path.length > 4096 || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) ||
      path.split('/').some(p => p === '.' || p === '..') || realpathSync(path) !== path) throw new Error('research_observation_path_invalid');
  return path;
}
function custody(path) {
  canonical(path);
  for (let p = path;; p = dirname(p)) {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('research_observation_custody_invalid');
    if (p === '/') break;
  }
}
function witness(path) {
  custody(path); const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('research_observation_file_invalid');
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), uid: stat.uid, mode: stat.mode & 0o777 };
}

export function observeResearchLaunch(args) {
  const [pid, unit, jobId, jobRootDir, workspacePath, runtimeDirectory] = args;
  if (args.length !== 6 || !/^[1-9][0-9]{0,9}$/.test(pid) || !/^[A-Za-z0-9_@.:-]{1,200}\.service$/.test(unit) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId)) throw new Error('research_observation_operands_invalid');
  if (process.platform !== 'linux' || process.getuid?.() !== 0 ||
      !/^0\s+0\s+4294967295$/.test(readFileSync('/proc/self/uid_map', 'utf8').trim()) ||
      ['user', 'mnt', 'pid'].some(ns => readlinkSync(`/proc/self/ns/${ns}`) !== readlinkSync(`/proc/1/ns/${ns}`))) {
    throw new Error('research_observation_host_root_required');
  }
  custody(jobRootDir); custody(workspacePath); custody(runtimeDirectory);
  const show = execFileSync('/usr/bin/systemctl', ['show', '--property=Id,ControlGroup,MainPID,FragmentPath,DropInPaths', '--', unit],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  const properties = Object.fromEntries(show.trim().split('\n').map(line => {
    const at = line.indexOf('='); if (at < 1) throw new Error('research_observation_unit_invalid');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (properties.Id !== unit || Object.keys(properties).sort().join(',') !== 'ControlGroup,DropInPaths,FragmentPath,Id,MainPID') {
    throw new Error('research_observation_unit_invalid');
  }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const pidBirth = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
  if (!stat.startsWith(pid + ' (') || !/^[1-9][0-9]*$/.test(pidBirth ?? '')) throw new Error('research_observation_pid_invalid');
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const processFacts = Object.fromEntries(status.split('\n').filter(line => /^(?:Uid|Gid|Cap(?:Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/.test(line))
    .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  return { diagnosticOnly: true, jobId, jobRootDir, workspacePath, runtimeDirectory,
    machineId: readFileSync('/etc/machine-id', 'utf8').trim(), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    process: { pidBirth: `${pid}:${pidBirth}`, cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(),
      uidMap: readFileSync(`/proc/${pid}/uid_map`, 'utf8').trim(), gidMap: readFileSync(`/proc/${pid}/gid_map`, 'utf8').trim(),
      namespaces: Object.fromEntries(['user', 'mnt', 'pid'].map(ns => [ns, readlinkSync(`/proc/${pid}/ns/${ns}`)])), ...processFacts },
    unit: { ...properties, fragment: properties.FragmentPath ? witness(properties.FragmentPath) : null,
      dropIns: properties.DropInPaths ? properties.DropInPaths.split(' ').map(witness) : [] },
    installed: ['dist/worker-codex/codex-goal-cli.js', 'dist/provider-codex/app-server/adapters/node-app-server-process.js',
      'host-integration/global-scan-guard/launch-hosted-subscription-runtime-job', 'host-integration/managed-launcher/launch.mjs'].map(p => witness(join(runtimeDirectory, p))) };
}
