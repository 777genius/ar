import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function publicEntrypoints(goalCli) {
  const dist = dirname(dirname(goalCli));
  return {
    goal: goalCli,
    mcp: join(dist, 'worker-codex/codex-goal-mcp.js'),
    task: join(dist, 'worker-local/agent-task-runner-cli.js'),
    runtime: join(dist, 'worker-local/agent-runtime-task-runner-cli.js'),
  };
}

// Called only by the opt-in disposable Linux canary. Every subprocess uses an
// empty credential environment and its own synthetic HOME, cwd and temp tree.
export async function provePublicEntrypointDenial(bins, sentinel) {
  const evidence = [];
  for (const [entrypoint, executable] of Object.entries(bins)) {
    for (const forgedEnvironment of [false, true]) {
      const root = join(sentinel, `public-${entrypoint}-${forgedEnvironment ? 'forged' : 'plain'}`);
      await mkdir(root);
      const prompt = join(root, 'prompt.txt');
      await writeFile(prompt, 'synthetic refusal probe', { flag: 'wx' });
      const jobRoot = join(root, 'must-not-exist');
      const jobId = `synthetic-${entrypoint}-${forgedEnvironment ? 'forged' : 'plain'}`;
      const args = entrypoint === 'goal' ? ['run', '--job-root', jobRoot,
        '--workspace', root, '--prompt', prompt, '--task-id', jobId, '--job-id', jobId,
        '--accounts', 'synthetic', '--auth-root', join(root, 'absent-auth'),
        '--no-tmux', '--no-require-git-workspace']
        : entrypoint === 'mcp' ? []
          : ['--provider', 'codex', '--state-root', jobRoot];
      const input = entrypoint === 'mcp'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-denial', version: '1' },
        } }) + '\n'
        : JSON.stringify({ protocolVersion: 1, runId: jobId,
          task: { kind: 'structured-prompt', prompt: 'synthetic refusal probe' } });
      const before = (await readdir(root, { recursive: true })).sort();
      const result = spawnSync(process.execPath, [executable, ...args], {
        cwd: root, input, encoding: 'utf8', timeout: 15000,
        env: { PATH: '/nonexistent-synthetic-bin', HOME: root, TMPDIR: root, TMP: root, TEMP: root,
          ...(forgedEnvironment ? { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1',
            SUBSCRIPTION_RUNTIME_JOB_ID: jobId, SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRoot } : {}) },
      });
      const after = (await readdir(root, { recursive: true })).sort();
      if (result.error || result.status === null || result.status === 0 ||
          !/Managed host requires root-owned launcher; submit through Host Jobs API/.test(result.stderr) ||
          JSON.stringify(before) !== JSON.stringify(after) || await readFile(prompt, 'utf8') !== 'synthetic refusal probe') {
        throw new Error(`Public ${entrypoint} ${forgedEnvironment ? 'forged-env' : 'plain'} denial failed before sentinel write: ${result.error?.message ?? result.stderr}`);
      }
      evidence.push({ entrypoint, executable, forgedEnvironment, exitCode: result.status, denied: true, sentinelUnchanged: true });
    }
  }
  return { denied: evidence.length, rootWrites: 0, entrypoints: evidence };
}
