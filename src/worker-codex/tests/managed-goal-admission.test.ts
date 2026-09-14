import { describe, expect, it, vi } from 'vitest';
import { admitManagedGoal } from '../managed-goal-admission';
import { requireManagedLaunchKernelProof } from '../managed-launch-kernel-proof';
import { deriveManagedJobLayout, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV, MANAGED_MARKER_ENV } from '../managed-job-layout';
import type { CodexGoalRunConfig } from '../codex-goal-runner';
const layout = deriveManagedJobLayout('/external/runtime/jobs/test', 'test');
const deps = { platform: 'linux' as const, isManagedHost: async () => true, requireKernelProof: async () => {} };
function config(): CodexGoalRunConfig {
  return { taskId: 'test', jobRootDir: layout.jobRoot, workspacePath: layout.workspace,
    authRootDir: '/readonly/auth', promptPath: '/readonly/prompt', accounts: [],
    sourceEnv: { [MANAGED_MARKER_ENV]: '1', [MANAGED_JOB_ROOT_ENV]: layout.jobRoot, [MANAGED_JOB_ID_ENV]: layout.jobId } };
}
describe('managed goal launcher contract', () => {
  it.each([true, false])('rejects forged marker before downstream side effects (managed host: %s)', async managed => {
    const write = vi.fn();
    const forged = config();
    // Kernel identity, unlike sourceEnv, is not caller-provided launcher evidence.
    const requireKernelProof = () => requireManagedLaunchKernelProof({ uid: () => 1000, gid: () => 1000 });
    await expect(admitManagedGoal({ config: forged }, {
      ...deps, isManagedHost: async () => managed, requireKernelProof,
    }).then(write)).rejects.toThrow('invalid user namespace');
    expect(write).not.toHaveBeenCalled();
    expect(forged.outputPath).toBeUndefined();
  });
  it('pins immutable writable paths within the whole job root', async () => {
    const result = await admitManagedGoal({ config: config() }, deps);
    expect(result.registryRootDir).toBe(layout.state + '/registry');
    expect(result.config.outputPath).toBe(layout.output + '/test.latest-result.json');
    expect(result.config.sourceEnv?.HOME).toBe(layout.home);
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(await admitManagedGoal(result, deps)).toEqual(result);
  });
  it.each(['jobRootDir', 'workspacePath', 'stateRootDir', 'runtimeHomeRootDir', 'encryptionKeyPath', 'outputPath', 'progressPath'] as const)('rejects %s override', async key => {
    await expect(admitManagedGoal({ config: { ...config(), [key]: '/root/escape' } }, deps)).rejects.toThrow(key);
  });
  it('rejects log and registry overrides', async () => {
    for (const key of ['logPath', 'registryRootDir']) await expect(admitManagedGoal({ config: config(), [key]: '/root' }, deps)).rejects.toThrow(key);
  });
  it('fails closed outside launcher even when policy is absent', async () => {
    await expect(admitManagedGoal({ config: { ...config(), sourceEnv: {} } }, deps)).rejects.toThrow('root-owned launcher');
  });
  it('keeps nonmanaged Linux and local legacy behavior', async () => {
    const input = { config: { ...config(), sourceEnv: {} } };
    expect(await admitManagedGoal(input, { platform: 'linux', isManagedHost: async () => false })).toBe(input);
    expect(await admitManagedGoal(input, { platform: 'darwin' })).toBe(input);
  });
  it('rejects malformed launcher data and mismatched identity', async () => {
    await expect(admitManagedGoal({ config: { ...config(), jobId: 'other' } }, deps)).rejects.toThrow('identity');
    for (const key of [MANAGED_MARKER_ENV, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV]) {
      const sourceEnv = { ...config().sourceEnv };
      delete sourceEnv[key];
      await expect(admitManagedGoal({ config: { ...config(), sourceEnv } }, deps)).rejects.toThrow('root-owned launcher');
    }
  });
  it('does not infer managed mode from legacy job root variables', async () => {
    const input = { config: { ...config(), sourceEnv: { [MANAGED_JOB_ROOT_ENV]: '/legacy', [MANAGED_JOB_ID_ENV]: 'legacy' } } };
    expect(await admitManagedGoal(input, { platform: 'linux', isManagedHost: async () => false })).toBe(input);
  });
  it('does not fall back when the installation check fails', async () => {
    await expect(admitManagedGoal({ config: config() }, { platform: 'linux', isManagedHost: async () => { throw new Error('EACCES'); } })).rejects.toThrow('EACCES');
  });
});

describe('managed launch kernel proof', () => {
  const validMap = '     65532          0          1\n';
  const probe = { uid: () => 65532, gid: () => 65532, read: async () => validMap };
  it('accepts the exact launcher UID and GID mapping', async () => {
    const read = vi.fn(probe.read);
    await expect(requireManagedLaunchKernelProof({ ...probe, read })).resolves.toBeUndefined();
    expect(read.mock.calls).toEqual([['/proc/self/uid_map'], ['/proc/self/gid_map']]);
  });
  it.each(['uid', 'gid'] as const)('rejects a wrong effective %s', async key => {
    await expect(requireManagedLaunchKernelProof({ ...probe, [key]: () => 0 })).rejects.toThrow('invalid user namespace');
  });
  it.each(['0 0 4294967295\n', '65532 1000 1\n', '65532 0 2\n', '65532 0 1\n0 1000 1\n', '', '65532 0 1 extra'])('rejects unexpected maps: %j', async map => {
    for (const target of ['/proc/self/uid_map', '/proc/self/gid_map']) {
      await expect(requireManagedLaunchKernelProof({ ...probe, read: async path => path === target ? map : validMap })).rejects.toThrow('invalid user namespace');
    }
  });
  it('fails closed when kernel maps cannot be read', async () => {
    await expect(requireManagedLaunchKernelProof({ ...probe, read: async () => { throw new Error('EACCES'); } })).rejects.toThrow('EACCES');
  });
});
