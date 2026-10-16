#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = 'host-integration/managed-launcher/launch.mjs';
const trustedCustodyLauncher = 'src/worker-codex/trusted-custody-systemd-launch.ts';
// Closed initial-root TEST operator: one qualified builtin harness, exact owned service.
// Its contained host-job alternative cannot satisfy the native operator namespaces.
const trustedLinkedNativeTestOperator = 'host-integration/runtime-admission/linked-native-mimo-operator.mts';
// Closed producer: requires the live host fence, retained origin and Running
// dependency owner before building one finite provider root. No directory exemption.
const trustedDependencyProviderLauncher = 'src/provider-codex/app-server/adapters/hosted-dependency-provider-launch.ts';
// Only this byte-exact inert declaration may name the provider command.
// Additional code or imports in the leaf fail closed; consumers remain scanned.
const trustedDependencyCommandLeaf = 'src/provider-codex/app-server/adapters/hosted-dependency-systemd-command.ts';
const trustedDependencyCommandDeclaration = 'export const hostedDependencySystemdRunExecutable = "/usr/bin/systemd-run";\n';
// Finite reviewed SOURCE100 administrative installation and its native TEST.
// The producer accepts only private original birth/source custody; the TEST
// submits one fixed forgery-negative unit. Neither is a provider/job launch API.
// Every byte edit requires fresh review and an explicit seal update. Exact
// physical paths below confer no directory, basename or general TEST exemption.
const trustedAdministrativeLaunchSources = new Map([
  // Reviewed fixed first-Positive ROOT installer transport; edits fail closed.
  ['scripts/dependency-retention-os-test/bootstrap-current-positive-public.mts',
    { bytes: 14434, sha256: 'f9703cc73982baf10abb7c38571c64f228ca377031f766b7f35a03bf7a876b7e' }],
  // Reviewed fixed original H1 Prepare/Finalize ROOT transport; exact bytes only.
  ['scripts/dependency-retention-os-test/bootstrap-current-h1-public.mts',
    { bytes: 23589, sha256: 'bea287919458d5061f0db41a207b1bc6513a638a78ccac46f21b90574042b6c8' }],
  ['scripts/dependency-retention-os-test/bootstrap-public-stage-9ca.mts',
    { bytes: 22046, sha256: '803cc575ff7c535505ea4b831d80947930e8ceb68e889cbeaa0f52f7f0caaa11' }],
  ['scripts/dependency-retention-os-test/current-administrative-installation.ts',
    { bytes: 38483, sha256: '1022a93b997fac577abca55ff0866eeaef3121499e35ddf56f13b4816ae101e2' }],
  ['scripts/dependency-retention-os-test/administrative-installation-native-TEST.ts',
    { bytes: 15647, sha256: 'bd97904cbda131955d7c15ce7f181c283c581d050596f946e853eaad22ae5888' }],
]);
const excludedDirectories = new Set(['node_modules', 'dist', '.git', 'docs', 'tests', '__tests__', 'fixtures', '__fixtures__', 'coverage']);
const sourceExtension = /\.(?:[cm]?[jt]sx?|sh|bash|py)$/;
const testFile = /(?:\.test\.|\.spec\.|\.node-test\.|-self-test\.)/;
const forbiddenCommand = /(?:^|[\s/;|&"'`])systemd-run(?=$|[\s;|&"'`])/;

// A deliberately small static evaluator, not execution or an attempted JS parser.
// Fold literal concatenations and local constant aliases, including templates.
// Comments do not count; unknown expressions remain unknown, never evaluated.
export function findRawLaunches(source, filename = 'source.js') {
  if (/\.(?:sh|bash)$/.test(filename)) {
    return source.split('\n').flatMap((line, index) =>
      forbiddenCommand.test(line.replace(/^\s*#.*$/, '')) ? [index + 1] : []);
  }
  const tokens = [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)]
    .filter(match => !match[0].startsWith('//') && !match[0].startsWith('/*'))
    .map(match => ({ text: match[0], offset: match.index }));
  const constants = new Map();
  function atom(token) {
    if (!token) return undefined;
    if (/^["'`]/.test(token.text)) {
      let value = token.text.slice(1, -1).replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|(.))/gi,
        (_, hex, unicode, escaped) => hex || unicode ? String.fromCharCode(parseInt(hex ?? unicode, 16)) : escaped);
      if (token.text[0] === '`') {
        let unknown = false;
        value = value.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_, name) => {
          if (!constants.has(name)) { unknown = true; return ''; }
          return constants.get(name);
        });
        if (unknown || value.includes('${')) return undefined;
      }
      return value;
    }
    return constants.get(token.text);
  }
  function expression(start) {
    let cursor = start;
    function term() {
      if (tokens[cursor]?.text === '(') {
        const nested = expression(cursor + 1);
        if (tokens[nested.end]?.text !== ')') return undefined;
        cursor = nested.end + 1;
        return nested.value;
      }
      return atom(tokens[cursor++]);
    }
    let value = term();
    while (tokens[cursor]?.text === '+') {
      cursor++;
      const next = term();
      value = value === undefined || next === undefined ? undefined : value + next;
    }
    return { value, end: cursor };
  }
  // A bounded fixed point handles alias chains even when declared out of order.
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    for (let i = 0; i < tokens.length - 3; i++) {
      if (tokens[i].text !== 'const' || tokens[i + 2].text !== '=') continue;
      const name = tokens[i + 1].text;
      const { value } = expression(i + 3);
      if (value !== undefined && constants.get(name) !== value) {
        constants.set(name, value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const lines = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (!/^["'`(]/.test(tokens[i].text) && !constants.has(tokens[i].text)) continue;
    const { value } = expression(i);
    if (value !== undefined && forbiddenCommand.test(value)) {
      lines.add(source.slice(0, tokens[i].offset).split('\n').length);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

export async function checkManagedLaunchBoundary(root = repositoryRoot) {
  const violations = [];
  let scanned = 0;
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await walk(path);
      } else if (entry.isFile() && sourceExtension.test(entry.name) && !testFile.test(entry.name)) {
        const name = relative(root, path).replaceAll('\\', '/');
        if (name === launcher || name === trustedCustodyLauncher || name === trustedDependencyProviderLauncher || name === trustedLinkedNativeTestOperator ||
            name === 'scripts/check-managed-launch-boundary.mjs') continue;
        scanned++;
        const bytes = await readFile(path), source = bytes.toString('utf8');
        const rawLaunches = findRawLaunches(source, name);
        // Actual joined path avoids POSIX backslash-name aliases in normalized display names.
        const trustedSource = [...trustedAdministrativeLaunchSources]
          .find(([sourcePath]) => path === join(root, sourcePath))?.[1];
        if (trustedSource) {
          if (bytes.length !== trustedSource.bytes ||
              createHash('sha256').update(bytes).digest('hex') !== trustedSource.sha256) violations.push(`${name}:1`);
          continue;
        }
        if (name === trustedDependencyCommandLeaf) {
          if (source !== trustedDependencyCommandDeclaration) violations.push(`${name}:1`);
          continue;
        }
        for (const line of rawLaunches) violations.push(`${name}:${line}`);
      }
    }
  }
  // Include operational launch adapters/scripts, not just TypeScript under src.
  for (const directory of ['src', 'packages', 'scripts', 'host-integration']) await walk(join(root, directory));
  return { scanned, violations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { scanned, violations } = await checkManagedLaunchBoundary();
  if (violations.length) {
    console.error(`Raw managed-launch executable outside ${launcher}:\n${violations.join('\n')}`);
    process.exitCode = 1;
  } else console.log(`Managed-launch boundary OK (${scanned} production source files).`);
}
