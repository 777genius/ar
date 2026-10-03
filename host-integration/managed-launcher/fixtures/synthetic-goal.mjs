import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Invoked only inside the opt-in disposable job. No real account is consulted.
export async function runSyntheticGoal(cli, layout, jobId) {
  const authRoot = join(layout.home, 'auth');
  await mkdir(join(authRoot, 'synthetic'), { recursive: true });
  const jwt = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  await writeFile(join(authRoot, 'synthetic', 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', last_refresh: new Date().toISOString(),
    tokens: {
      access_token: 'synthetic-not-a-real-token', refresh_token: 'synthetic-not-a-real-refresh',
      id_token: `${jwt({ alg: 'none' })}.${jwt({ sub: 'synthetic', email: 'synthetic@example.invalid',
        'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic', chatgpt_user_id: 'synthetic' } })}.synthetic`,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    },
  }), { flag: 'wx', mode: 0o600 });
  const prompt = join(layout.workspace, 'synthetic-prompt.txt');
  await writeFile(prompt, 'Return the synthetic completion marker. No network or external data.', { flag: 'wx' });
  const binary = join(layout.jobRoot, 'synthetic-codex');
  const providerEvidence = join(layout.output, 'synthetic-provider.json');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const writes = [];
  for (const directory of [process.env.HOME, process.env.TMPDIR]) {
    if (!directory) throw new Error('Missing runner HOME/temp');
    fs.mkdirSync(directory, { recursive: true });
    const path = directory + '/synthetic-runner-write';
    fs.writeFileSync(path, 'synthetic');
    writes.push(path);
  }
  fs.writeFileSync(${JSON.stringify(providerEvidence)}, JSON.stringify({ stdinBytes: input.length, home: process.env.HOME, temp: process.env.TMPDIR, codexHome: process.env.CODEX_HOME, writes }));
  process.stdout.write(JSON.stringify({ type: 'agent_message', message: 'synthetic runner completed' }) + '\\n');
});
`, { flag: 'wx', mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].includes(key) ||
    ['SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH', 'SUBSCRIPTION_RUNTIME_JOB_ID',
      'SUBSCRIPTION_RUNTIME_JOB_ROOT', 'SUBSCRIPTION_RUNTIME_HOST_JOB_ID'].includes(key)));
  const run = spawnSync(process.execPath, [cli, 'run', '--job-root', layout.jobRoot,
    '--workspace', layout.workspace, '--prompt', prompt, '--task-id', jobId, '--job-id', jobId,
    '--output', join(layout.output, `${jobId}.latest-result.json`),
    '--progress', join(layout.output, `${jobId}.progress.json`),
    '--log', join(layout.logs, `${jobId}.log`),
    '--accounts', 'synthetic', '--auth-root', authRoot, '--execution-engine', 'packaged-exec',
    '--codex-binary', binary, '--no-tmux', '--no-require-git-workspace', '--timeout', '30s', '--effort', 'low'],
  { encoding: 'utf8', timeout: 45000, env });
  if (run.error || run.status !== 0) throw new Error(`Synthetic goal failed: ${run.error?.message ?? run.stderr}\n${run.stdout}`);
  const progress = JSON.parse(await readFile(join(layout.output, `${jobId}.progress.json`), 'utf8'));
  const output = await readFile(join(layout.output, `${jobId}.latest-result.json`), 'utf8');
  const events = (await readFile(join(layout.output, `${jobId}.events.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  const state = await readdir(layout.state);
  const evidence = JSON.parse(await readFile(providerEvidence, 'utf8'));
  if (progress.status !== 'completed' || !output.includes('synthetic runner completed') ||
      !events.length || !state.includes('encryption-key.hex') || !state.includes('registry') || evidence.stdinBytes < 1 ||
      !Array.isArray(evidence.writes) || evidence.writes.length !== 2) {
    throw new Error('Synthetic runner did not persist required completed artifacts');
  }
  for (const path of [evidence.home, evidence.temp, evidence.codexHome]) {
    if (typeof path !== 'string' || !path.startsWith(`${layout.jobRoot}/`)) throw new Error('Runner writable path escaped layout');
  }
  for (const path of evidence.writes) {
    if (typeof path !== 'string' || !path.startsWith(`${layout.jobRoot}/`)) throw new Error('Runner write escaped layout');
  }
  // HOME is durable; an executor may intentionally clean its per-attempt temp.
  await readFile(join(evidence.home, 'synthetic-runner-write'));
  return { status: progress.status, events: events.length, state, provider: evidence };
}
