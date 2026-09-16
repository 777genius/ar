import { spawnSync } from 'node:child_process';

export function assertDisposableIdentity(config, facts) {
  if (!config || typeof config !== 'object' || !/^sr-custody-canary-[a-f0-9]{16}$/.test(config.name ?? '') ||
      !/^[a-f0-9]{32}$/.test(config.machineId ?? '') || !/^[a-f0-9]{40}$/.test(config.sha ?? '') ||
      !/^[a-f0-9]{64}$/.test(config.manifestSha256 ?? '') || facts.machineId !== config.machineId ||
      facts.container !== 'systemd-nspawn' || facts.pid1 !== 'systemd' || facts.hostname !== config.name ||
      facts.configUid !== 0 || (facts.configMode & 0o022)) throw new Error('not disposable guest');
}

export function runGuestCommand(command, args, expected = 0, spawn = spawnSync, output = bytes => process.stdout.write(bytes)) {
  const result = spawn(command, args, { cwd: '/canary/workspace', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' },
    stdio: 'pipe', timeout: 90000, maxBuffer: 1024 * 1024 });
  // Commands never inherit regular log files or /dev/null. Their bounded pipe
  // output reaches the supervisor's log only after command completion.
  for (const bytes of [result.stdout, result.stderr]) if (bytes?.length) output(bytes.subarray(0, 1024 * 1024));
  if (result.error || result.signal || result.status !== expected) throw new Error(`canary command failed: ${command} (${result.status})`);
}
