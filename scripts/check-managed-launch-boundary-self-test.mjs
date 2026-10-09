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
  const leaf = join(adapters, 'hosted-dependency-systemd-command.ts');
  const declaration = 'export const hostedDependencySystemdRunExecutable = "/usr/bin/systemd-run";\n';
  await writeFile(leaf, declaration);
  await writeFile(join(adapters, 'hosted-retained-tool-files.ts'),
    'import { hostedDependencySystemdRunExecutable } from "./hosted-dependency-systemd-command";\n' +
    'if (invocation.command !== hostedDependencySystemdRunExecutable) fail();\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
  for (const source of [declaration + 'spawn("/usr/bin/systemd-run", args);\n', declaration + declaration,
    declaration + 'import "./foreign-launcher";\n', declaration.replace('/usr/bin/systemd-run', '/usr/bin/other')]) {
    await writeFile(leaf, source);
    assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
      ['src/provider-codex/app-server/adapters/hosted-dependency-systemd-command.ts:1']);
  }
  await writeFile(leaf, declaration);
  await writeFile(join(adapters, 'hosted-retained-tool-files.ts'), 'spawn("/usr/bin/systemd-run", args);\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
    ['src/provider-codex/app-server/adapters/hosted-retained-tool-files.ts:1']);
  await writeFile(join(adapters, 'hosted-retained-tool-files.ts'), 'const command = "/usr/bin/systemd-run";\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
    ['src/provider-codex/app-server/adapters/hosted-retained-tool-files.ts:1']);
  await writeFile(join(adapters, 'hosted-retained-tool-files.ts'), 'const command = trustedCommand;\n');
  await writeFile(join(adapters, 'unapproved-provider-launch.ts'), 'const command = "/usr/bin/systemd-run";\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
    ['src/provider-codex/app-server/adapters/unapproved-provider-launch.ts:1']);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Managed-launch boundary self-tests OK.');
