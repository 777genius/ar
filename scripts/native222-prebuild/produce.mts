import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, cpSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prebuild only: this producer never launches the native qualification harness.
const sourceSha = '853ce6ee213689cc11c52139077b01d39652cd62';
const sourceTree = '0fd48b8c4e512b89d3dbb9c7042f49109059752c';
function requireFact(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function requiredEnv(name: string, pattern: RegExp): string {
  const value = process.env[name]; requireFact(value !== undefined && pattern.test(value), `invalid ${name}`); return value;
}
function hash(p: string): string {
  const fd = openSync(p, 'r'); const digest = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (n === 0) break; digest.update(buffer.subarray(0, n)); } return digest.digest('hex'); } finally { closeSync(fd); }
}
requireFact(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'vioxen/subscription-runtime' && process.env.GITHUB_ACTOR === '777genius', 'Source CI identity required');
requireFact(process.env.RUNNER_OS === 'Linux' && process.env.RUNNER_ARCH === 'X64' && process.version === 'v22.23.3', 'exact Linux x64 Node22 required');
const runId = requiredEnv('GITHUB_RUN_ID', /^[1-9][0-9]*$/);
const runAttempt = requiredEnv('GITHUB_RUN_ATTEMPT', /^[1-9][0-9]*$/);
const workflowSha = requiredEnv('NATIVE222_WORKFLOW_SHA', /^[a-f0-9]{40}$/);
const helperSha = requiredEnv('NATIVE222_HELPER_SHA', /^[a-f0-9]{40}$/);
const workflowRef = requiredEnv('NATIVE222_WORKFLOW_REF', /^vioxen\/subscription-runtime\/\.github\/workflows\/native222-prebuild\.yml@refs\//);
const runnerName = requiredEnv('NATIVE222_RUNNER_NAME', /^arc-runner-set-[a-z0-9-]+$/);
const runnerTemp = realpathSync(requiredEnv('RUNNER_TEMP', /^\//));
const workspace = realpathSync(requiredEnv('GITHUB_WORKSPACE', /^\//));
requireFact(process.cwd() === workspace, 'workspace mismatch');
const producerPath = realpathSync(fileURLToPath(import.meta.url));
requireFact(producerPath === `${workspace}/helper/scripts/native222-prebuild/produce.mts`, 'producer location mismatch');
const root = `${runnerTemp}/native222-prebuild-${runId}-${runAttempt}`;
mkdirSync(root, { mode: 0o700 });
const capacity = statfsSync(root, { bigint: true });
requireFact(capacity.bavail * capacity.bsize >= 5n * 1024n ** 3n && capacity.ffree >= 50000n, 'runner scratch capacity refusal');
const source = `${root}/source`;
const artifact = `${root}/artifact`;
const output = `${root}/output`;
for (const p of [source, artifact, output, `${root}/home`, `${root}/tmp`, `${root}/cache`]) mkdirSync(p, { mode: 0o700 });
const toolchain = realpathSync(dirname(dirname(process.execPath)));
requireFact(realpathSync(`${toolchain}/bin/node`) === realpathSync(process.execPath), 'toolchain layout mismatch');
const env: NodeJS.ProcessEnv = {
  PATH: `${toolchain}/bin:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C',
  HOME: `${root}/home`, TMPDIR: `${root}/tmp`, TMP: `${root}/tmp`, TEMP: `${root}/tmp`,
  XDG_CACHE_HOME: `${root}/cache/xdg`, npm_config_cache: `${root}/cache/npm`,
  npm_config_userconfig: `${root}/home/.npmrc`, npm_config_globalconfig: `${root}/npm-globalrc`, npm_config_update_notifier: 'false',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};
writeFileSync(`${root}/home/.npmrc`, '', { flag: 'wx', mode: 0o600 });
writeFileSync(`${root}/npm-globalrc`, '', { flag: 'wx', mode: 0o600 });
function run(exe: string, args: string[], cwd = source): void { execFileSync(exe, args, { cwd, env, stdio: 'inherit', timeout: 1200000 }); }
function git(args: string[], cwd: string): string { return execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', timeout: 30000 }).trim(); }
const checkout = `${workspace}/pinned-source`;
requireFact(git(['rev-parse', 'HEAD'], checkout) === sourceSha && git(['rev-parse', 'HEAD^{tree}'], checkout) === sourceTree, 'pinned Source checkout mismatch');
requireFact(git(['rev-parse', 'HEAD'], `${workspace}/helper`) === helperSha, 'helper checkout mismatch');
const sourceArchive = `${root}/source.tar`;
run('/usr/bin/git', ['archive', '--format=tar', `--output=${sourceArchive}`, sourceSha], checkout);
run('/usr/bin/tar', ['--extract', '--file', sourceArchive, '--no-same-owner', '--no-same-permissions', '--directory', source]);
requireFact(!readdirSync(source).includes('.git'), 'source archive must omit Git metadata');
run('/usr/bin/git', ['init', '--quiet']);
run('/usr/bin/git', ['-c', 'core.autocrlf=false', '-c', 'core.fileMode=true', 'add', '--force', '--all']);
requireFact(git(['write-tree'], source) === sourceTree, 'complete Source tree mismatch before npm');
run(`${toolchain}/bin/npm`, ['ci', '--ignore-scripts']);
run(`${toolchain}/bin/npm`, ['run', 'build']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'scripts/dependency-retention-test/tsconfig.json']);
// External handwritten producer typecheck must bypass the Source tsconfig.
run(process.execPath, ['node_modules/typescript/bin/tsc', '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--typeRoots', `${source}/node_modules/@types`, producerPath]);
for (const name of ['dist', 'package.json', 'scripts', 'node_modules', 'packages']) cpSync(join(source, name), join(artifact, name), { recursive: true, dereference: false, verbatimSymlinks: true });
cpSync(toolchain, `${artifact}/toolchain`, { recursive: true, dereference: false, verbatimSymlinks: true });
// Official Node22.23.3 ships this empty npm config. Omit only its proven
// empty copy; the complete credential-name exclusion below stays unchanged.
const npmBuiltinConfigPath = 'toolchain/lib/node_modules/npm/.npmrc';
const npmBuiltinConfig = `${artifact}/${npmBuiltinConfigPath}`;
const npmBuiltinConfigFd = openSync(npmBuiltinConfig, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
let npmBuiltinConfigSha256: string;
try {
  const st = fstatSync(npmBuiltinConfigFd);
  requireFact(st.isFile() && st.nlink === 1 && st.size === 0, 'official npm builtin config must be an empty regular single-link file');
  requireFact(readSync(npmBuiltinConfigFd, Buffer.alloc(1), 0, 1, null) === 0, 'official npm builtin config changed');
  npmBuiltinConfigSha256 = createHash('sha256').digest('hex');
  requireFact(npmBuiltinConfigSha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'official npm builtin config digest mismatch');
  const current = lstatSync(npmBuiltinConfig);
  requireFact(current.isFile() && !current.isSymbolicLink() && current.dev === st.dev && current.ino === st.ino && current.nlink === 1 && current.size === 0, 'official npm builtin config identity changed');
  unlinkSync(npmBuiltinConfig);
} finally { closeSync(npmBuiltinConfigFd); }
type Leaf = { path: string; mode: number; kind: 'file' | 'symlink'; bytes?: number; sha256?: string; target?: string };
const leaves: Leaf[] = [];
let unpackedBytes = 0;
function inventory(p: string): void {
  const st = lstatSync(p); const rel = relative(artifact, p);
  requireFact(!rel.split(sep).some(x => ['.git', '.npmrc', 'auth.json', '.env'].includes(x)), 'forbidden artifact leaf');
  if (st.isSymbolicLink()) {
    const target = readlinkSync(p); const resolved = resolve(dirname(p), target);
    requireFact(!target.startsWith('/') && resolved.startsWith(`${artifact}/`) && realpathSync(p).startsWith(`${artifact}/`), 'escaping artifact symlink');
    leaves.push({ path: rel, mode: st.mode & 0o777, kind: 'symlink', target }); return;
  }
  requireFact(st.isDirectory() || st.isFile(), 'special artifact inode refused');
  chmodSync(p, st.mode & 0o755);
  if (st.isDirectory()) { for (const name of readdirSync(p).sort()) inventory(join(p, name)); }
  else { unpackedBytes += st.size; leaves.push({ path: rel, mode: st.mode & 0o755, kind: 'file', bytes: st.size, sha256: hash(p) }); }
}
inventory(artifact);
writeFileSync(`${output}/artifact-leaves.json`, JSON.stringify(leaves) + '\n', { flag: 'wx', mode: 0o600 });
run('/usr/bin/tar', ['--create', '--file', `${output}/artifact.tar`, '--directory', artifact, 'dist', 'package.json', 'scripts', 'node_modules', 'packages', 'toolchain']);
const archiveBytes = statSync(`${output}/artifact.tar`).size;
const result = {
  schema: 1, repository: 'vioxen/subscription-runtime', sourceSha, sourceTree,
  workflowSha, workflowRef, helperSha, runId, runAttempt, runnerName,
  nodeVersion: process.version, nodeSha256: hash(`${artifact}/toolchain/bin/node`),
  sourceArchiveSha256: hash(sourceArchive), payloadSha256: hash(producerPath),
  omittedEmptyNpmBuiltinConfig: { path: npmBuiltinConfigPath, bytes: 0, sha256: npmBuiltinConfigSha256 },
  commands: ['npm ci --ignore-scripts', 'npm run build', 'node node_modules/typescript/bin/tsc -p scripts/dependency-retention-test/tsconfig.json', 'external producer strict typecheck with --ignoreConfig'],
  archiveSha256: hash(`${output}/artifact.tar`), archiveBytes, unpackedBytes,
  leavesSha256: hash(`${output}/artifact-leaves.json`), archiveWithinCarrierCap: archiveBytes <= 3 * 1024 ** 3,
  qualification: 'prebuild_and_typecheck_only', nativeExecuted: false,
};
writeFileSync(`${output}/producer-receipt.json`, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
requireFact(result.archiveWithinCarrierCap, 'artifact exceeds unchanged carrier cap; retain output, do not stage');
