import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const testOperators = join(root, 'host-integration/runtime-admission');
  await mkdir(testOperators);
  await writeFile(join(testOperators, 'linked-native-mimo-operator.mts'), 'const command = \"/usr/bin/systemd-run\";\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
  const unapprovedOperator = join(testOperators, 'unapproved-operator.mts');
  await writeFile(unapprovedOperator, 'const command = \"/usr/bin/systemd-run\";\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
    ['host-integration/runtime-admission/unapproved-operator.mts:1']);
  await writeFile(unapprovedOperator, 'const command = trustedCommand;\n');
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
  await rm(join(adapters, 'unapproved-provider-launch.ts'));
  // Actual metadata consumer reuses the exact inert command leaf already
  // sealed above. This grants no executable-file/directory exemption.
  const peers = join(root, 'src/worker-codex');
  await mkdir(peers);
  const peerName = 'src/worker-codex/hosted-project-control-peer-selection.ts';
  const peerPath = join(root, peerName);
  const peerSource = await readFile(new URL('../src/worker-codex/hosted-project-control-peer-selection.ts', import.meta.url));
  await writeFile(peerPath, peerSource);
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
  // Literal/concatenated raw commands remain denied in the real consumer.
  // The lexical checker does not resolve imported identifiers; runtime custody
  // remains the separate original execution boundary.
  for (const raw of ['spawn("/usr/bin/systemd-run", args);',
    'const rawCommand = "systemd-" + "run"; execFile(rawCommand, args);']) {
    await writeFile(peerPath, Buffer.concat([peerSource, Buffer.from('\n' + raw + '\n')]));
    assert.ok((await checkManagedLaunchBoundary(root)).violations.some(value => value.startsWith(peerName + ':')));
  }
  await writeFile(peerPath, peerSource);
  // Read the actual approved SOURCE bytes; never import or execute the ROOT installer.
  const approved = await readFile(new URL('./dependency-retention-os-test/bootstrap-public-stage-9ca.mts', import.meta.url));
  assert.ok(findRawLaunches(approved.toString('utf8'), 'bootstrap-public-stage-9ca.mts').length > 0);
  const publicDirectory = join(root, 'scripts/dependency-retention-os-test');
  await mkdir(publicDirectory);
  const publicName = 'scripts/dependency-retention-os-test/bootstrap-public-stage-9ca.mts';
  const bootstrap = join(root, publicName);
  await writeFile(bootstrap, approved);
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
  const replacementCharacter = approved.indexOf(Buffer.from('SOURCE'));
  assert.ok(replacementCharacter >= 0);
  for (const changed of [
    Buffer.concat([approved, Buffer.from('\nspawn("/usr/bin/systemd-run", process.argv.slice(2));\n')]),
    Buffer.from('const harmless = true;\n'),
    ...[0x80, 0x81].map(byte => { const copy = Buffer.from(approved); copy[replacementCharacter] = byte; return copy; }),
  ]) {
    await writeFile(bootstrap, changed);
    assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, [`${publicName}:1`]);
  }
  await writeFile(bootstrap, approved);
  const foreign = join(publicDirectory, 'unapproved-public-bootstrap.mts');
  await writeFile(foreign, approved);
  assert.ok((await checkManagedLaunchBoundary(root)).violations.some(name => name.startsWith('scripts/dependency-retention-os-test/unapproved-public-bootstrap.mts:')));
  await writeFile(foreign, 'spawn("/usr/bin/systemd-run", args);\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, ['scripts/dependency-retention-os-test/unapproved-public-bootstrap.mts:1']);
  await rm(foreign);
  if (process.platform !== 'win32') {
    const alias = join(root, 'scripts', 'dependency-retention-os-test\\bootstrap-public-stage-9ca.mts');
    await writeFile(alias, approved);
    assert.ok((await checkManagedLaunchBoundary(root)).violations.length > 0, 'POSIX backslash display alias is not the approved physical path');
    await rm(alias);
  }
  // The newly reviewed producer/native TEST are sealed individually, not
  // exempted by their directory or native-TEST suffix. Read only SOURCE bytes.
  for (const basename of ['current-administrative-installation.ts', 'administrative-installation-native-TEST.ts',
    'bootstrap-current-positive-public.mts', 'bootstrap-current-h1-public.mts']) {
    const source = await readFile(new URL(`./dependency-retention-os-test/${basename}`, import.meta.url));
    assert.ok(findRawLaunches(source.toString('utf8'), basename).length > 0);
    const name = `scripts/dependency-retention-os-test/${basename}`, path = join(root, name);
    await writeFile(path, source);
    assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
    const sameSize = Buffer.from(source); sameSize[0] = sameSize[0] === 47 ? 32 : 47;
    for (const changed of [sameSize, Buffer.concat([source, Buffer.from('\nspawn("/usr/bin/systemd-run", process.argv.slice(2));\n')]),
      Buffer.from('const harmless = true;\n')]) {
      await writeFile(path, changed);
      assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, [`${name}:1`]);
    }
    await writeFile(path, source);
    const copied = join(publicDirectory, `unapproved-${basename}`);
    await writeFile(copied, source);
    assert.ok((await checkManagedLaunchBoundary(root)).violations.some(value =>
      value.startsWith(`scripts/dependency-retention-os-test/unapproved-${basename}:`)));
    await rm(copied);
    if (process.platform !== 'win32') {
      const alias = join(root, 'scripts', `dependency-retention-os-test\\${basename}`);
      await writeFile(alias, source);
      assert.ok((await checkManagedLaunchBoundary(root)).violations.length > 0,
        'POSIX backslash display alias is not an approved physical path');
      await rm(alias);
    }
  }
  const unrelatedTest = join(publicDirectory, 'unapproved-native-TEST.ts');
  await writeFile(unrelatedTest, 'spawn("/usr/bin/systemd-run", args);\n');
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations,
    ['scripts/dependency-retention-os-test/unapproved-native-TEST.ts:1']);
  await rm(unrelatedTest);
  assert.deepEqual((await checkManagedLaunchBoundary(root)).violations, []);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Managed-launch boundary self-tests OK.');
