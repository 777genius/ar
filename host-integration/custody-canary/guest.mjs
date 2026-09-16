import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { hostname } from 'node:os';
import { assertDisposableIdentity, runGuestCommand as run } from './guest-contract.mjs';

const root = '/var/lib/subscription-runtime-host-policy';
const artifact = '/opt/custody-canary/runtime';
const node = '/usr/local/bin/node';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const put = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
let disposableVerified = false;
try {
  const config = json('/opt/custody-canary/config.json');
  const configStat = lstatSync('/opt/custody-canary/config.json');
  if (!configStat.isFile()) throw new Error('not disposable guest');
  assertDisposableIdentity(config, { machineId: readFileSync('/etc/machine-id', 'utf8').trim(),
    container: readFileSync('/run/systemd/container', 'utf8').trim(), pid1: readFileSync('/proc/1/comm', 'utf8').trim(),
    hostname: hostname(), configUid: configStat.uid, configMode: configStat.mode });
  disposableVerified = true;
  for (const suffix of ['', '/ordinary-origins', '/ordinary-starts', '/ordinary-completed', '/codex-readonly-custody', '/codex-readonly-revoked']) mkdirSync(root + suffix, { recursive: true, mode: 0o700 });
  const stageRoot = '/run/user/0/subscription-runtime-host-policy/codex-readonly-stages';
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  put(`${stageRoot}/${digest(artifact)}.json`, { schemaVersion: 1, runtimeDirectory: artifact, runtimeSha: config.sha, runtimeManifestSha256: config.manifestSha256 });
  const launch = { command: node, args: [`${artifact}/dist/worker-codex/codex-goal-cli.js`, '--help'], cwd: '/canary/workspace' };
  put(`${root}/readonly-inventory.json`, { schemaVersion: 2, hostId: config.machineId, supervisorUnit: 'custody-canary.service', units: [{ name: 'custody-canary.service', controlGroup: '/system.slice/custody-canary.service', fragmentSha256: digest(readFileSync('/etc/systemd/system/custody-canary.service')) }], ordinaryCreators: [{ creatorId: 'canary', jobId: config.name, jobRootDir: '/canary/job', workspacePath: launch.cwd, launch }], disabledCreators: [], runtimeLaunch: launch });
  const cli = `${artifact}/dist/worker-codex/hosted-readonly-inputs-cli.js`;
  // Independent cgroup must fail before any installation is published.
  run('/usr/bin/systemctl', ['start', 'custody-canary-denied.service'], 1);
  const denied = spawnSync('/usr/bin/systemctl', ['show', '--property=ExecMainStatus', '--value', 'custody-canary-denied.service'], { encoding: 'utf8', timeout: 10000 });
  if (denied.status !== 0 || denied.stdout.trim() !== '73') throw new Error('outside-supervisor operatorSession refusal not proven');
  run('/usr/bin/systemctl', ['reset-failed', 'custody-canary-denied.service']);
  for (const args of [['install-host'], ['enroll-ordinary', 'canary'], ['resume-ordinary']]) run(node, [cli, ...args]);
  run(node, [`${artifact}/dist/worker-codex/hosted-readonly-host-launch-cli.js`, 'runtime', '--', launch.command, ...launch.args]);
  const installation = json(`${root}/host-installation.json`);
  const activation = json(`${root}/host-activation.json`);
  if (installation.hostId !== config.machineId || installation.runtimeSha !== config.sha || installation.runtimeManifestSha256 !== config.manifestSha256 || activation.ordinaryStarts.length !== 1) throw new Error('binding mismatch');
  const [startId] = readdirSync(`${root}/ordinary-starts`);
  const startBytes = readFileSync(`${root}/ordinary-starts/${startId}`);
  const receipt = json(`${root}/ordinary-completed/${startId}`);
  const start = JSON.parse(startBytes);
  if (receipt.waitStatus !== 0 || receipt.startSha256 !== digest(startBytes) || receipt.startId + '.json' !== startId || start.jobId !== config.name || start.installationId !== installation.installationId || start.supervisorId !== activation.supervisorId) throw new Error('receipt mismatch');
  put('/canary/result.json', { passed: true, scope: 'ordinary CLI help process, no provider invocation', outsideSupervisorOperatorSessionDenied: true, installation, receipt });
} catch (error) {
  if (disposableVerified) put('/canary/result.json', { passed: false, error: String(error) });
  else process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
} finally {
  // Power off this guest only. The outer supervisor retains storage on failure.
  if (disposableVerified) spawnSync('/usr/bin/systemctl', ['--no-block', 'poweroff'], { stdio: 'ignore', timeout: 10000 });
}
