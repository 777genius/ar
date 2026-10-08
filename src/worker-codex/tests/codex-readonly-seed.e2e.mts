// One disposable namespace attempt. A denial is unqualified OS evidence, never
// authorization to widen mounts or to retry a real managed launch.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fresh } from './codex-seed-publication.e2e.mts';

const repository = process.env.SR_SYNTHETIC_RUNTIME_COPY!;
const root = await fresh('readonly');
await mkdir(join(root, 'jobs/tmp'), { recursive: true });
const args = ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--bind', join(root, 'jobs'), join(root, 'jobs'),
  '--ro-bind', join(root, 'auth'), join(root, 'auth'), '--chdir', repository, '--', process.execPath,
  fileURLToPath(new URL('./codex-seed-publication.e2e.mts', import.meta.url)), '--worker', root, 'newer'];
const handle = spawn('/usr/bin/bwrap', args, { env: { ...process.env, TMPDIR: join(root, 'jobs/tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; let launchError: string | null = null;
const deadline = setTimeout(() => handle.kill('SIGKILL'), 30_000);
handle.stdout.on('data', bytes => { stdout += String(bytes); });
handle.stderr.on('data', bytes => { stderr += String(bytes); });
handle.on('error', () => { launchError = 'namespace_tool_unavailable'; });
const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => handle.on('close', (code, signal) => resolve({ code, signal })));
clearTimeout(deadline);
const denied = launchError !== null || stderr.includes('Creating new namespace failed');
const result = { task: 'synthetic_readonly_seed_contract', root, executable: '/usr/bin/bwrap', args, exit, stdout, stderr,
  qualification: denied ? 'UNQUALIFIED_NAMESPACE_UNAVAILABLE' : 'EXECUTED_SYNTHETIC_OS_BOUNDARY', launchError,
  mountExpansion: false, realProviderCalls: false };
await writeFile(join(dirname(repository), 'readonly-boundary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.exitCode = denied ? 2 : exit.code ?? 1;
