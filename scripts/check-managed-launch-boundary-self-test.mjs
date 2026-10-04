import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRawLaunches, checkManagedLaunchBoundary } from './check-managed-launch-boundary.mjs';

for (const source of [
  'spawn("/usr/bin/systemd-run", args)',
  'execFile("systemd-run", args)',
  'const command = "systemd-" + "run"; spawn(command, args)',
  'const prefix = "/usr/bin/"; const name = "systemd-"; const command = prefix + name + "run";',
  'const name = "systemd-run"; const alias = name; spawn(alias, args)',
  'const name = "systemd-"; const command = `${name}run`;',
  'spawn(("systemd-" + "run"), args)',
  'spawn("systemd\\x2drun", args)',
  'exec("sudo /usr/bin/systemd-run --wait true")',
]) assert.ok(findRawLaunches(source).length > 0, `Expected violation: ${source}`);

for (const source of [
  '// systemd-run is owned by the launcher\nconst value = "safe";',
  '/* spawn("systemd-run", args) */',
  'const name = "systemd-runner";',
  'const name = "managed-systemd-run-policy";',
  'const systemdRunPath = managedLauncherCommand;',
  'const name = "systemd-"; const other = "run";',
]) assert.deepEqual(findRawLaunches(source), [], `Unexpected violation: ${source}`);

assert.deepEqual(findRawLaunches('# systemd-run comment\nsudo /usr/bin/systemd-run --wait true', 'launch.sh'), [2]);
// A directory-wide exemption would let an unrelated provider bypass the boundary.
const root = await mkdtemp(join(tmpdir(), 'TEST-managed-launch-boundary-'));
try {
  for (const directory of ['src/provider-codex/app-server/adapters', 'packages', 'scripts', 'host-integration']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const adapters = join(root, 'src/provider-codex/app-server/adapters');
  await writeFile(join(adapters, 'hosted-dependency-provider-launch.ts'), 'const command = "/usr/bin/systemd-run";\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
  await writeFile(join(adapters, 'unapproved-provider-launch.ts'), 'const command = "/usr/bin/systemd-run";\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
    ['src/provider-codex/app-server/adapters/unapproved-provider-launch.ts:1']);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Managed-launch boundary self-tests OK.');
