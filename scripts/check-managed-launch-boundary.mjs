#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = 'host-integration/managed-launcher/launch.mjs';
const trustedCustodyLauncher = 'src/worker-codex/trusted-custody-systemd-launch.ts';
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
        if (name === launcher || name === trustedCustodyLauncher ||
            name === 'scripts/check-managed-launch-boundary.mjs') continue;
        scanned++;
        for (const line of findRawLaunches(await readFile(path, 'utf8'), name)) violations.push(`${name}:${line}`);
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
