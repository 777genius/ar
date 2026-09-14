import { describe, expect, it, vi } from 'vitest';
import { admitManagedGoal, isManagedGoalHost, managedGoalActivationPath } from '../managed-goal-admission';
import { deriveManagedJobLayout, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV, MANAGED_MARKER_ENV } from '../managed-job-layout';
import type { CodexGoalRunConfig } from '../codex-goal-runner';
const layout = deriveManagedJobLayout('/external/runtime/jobs/test', 'test');
const deps = { platform: 'linux' as const, isManagedHost: async () => false };
function config(): CodexGoalRunConfig {
  return { taskId: 'test', jobRootDir: layout.jobRoot, workspacePath: layout.workspace,
    authRootDir: '/readonly/auth', promptPath: '/readonly/prompt', accounts: [],
    sourceEnv: { [MANAGED_MARKER_ENV]: '1', [MANAGED_JOB_ROOT_ENV]: layout.jobRoot, [MANAGED_JOB_ID_ENV]: layout.jobId } };
}
describe('managed goal launcher contract', () => {
  it('routes the installed marker to the host API and the masked placeholder to payload mapping', async () => {
    const inspect = vi.fn(async () => ({ rdev: 0, isCharacterDevice: () => false }));
    expect(await isManagedGoalHost(inspect)).toBe(true);
    expect(inspect).toHaveBeenCalledWith(managedGoalActivationPath);
    expect(await isManagedGoalHost(async () => ({ rdev: 259, isCharacterDevice: () => true }))).toBe(false);
    for (const mode of [0o100000, 0o100644, 0o120777, 0o040755]) {
      expect(await isManagedGoalHost(async () => ({ mode, rdev: 0, isCharacterDevice: () => false }))).toBe(true);
    }
    expect(await isManagedGoalHost(async () => ({ rdev: 260, isCharacterDevice: () => true }))).toBe(true);
    expect(await isManagedGoalHost(async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); })).toBe(false);
    await expect(isManagedGoalHost(async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); })).rejects.toThrow('EACCES');
  });
  it.each([{}, { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1' }, {
    SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1', SUBSCRIPTION_RUNTIME_JOB_ROOT: layout.jobRoot,
    SUBSCRIPTION_RUNTIME_JOB_ID: layout.jobId,
  }])('rejects direct managed-host launch regardless of environment %j', async sourceEnv => {
    const write = vi.fn();
    const forged = { ...config(), sourceEnv };
    await expect(admitManagedGoal({ config: forged }, {
      ...deps, isManagedHost: async () => true,
    }).then(write)).rejects.toThrow('Host Jobs API');
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
    await expect(admitManagedGoal({ config: { ...config(), sourceEnv: {} } }, { ...deps, isManagedHost: async () => true })).rejects.toThrow('root-owned launcher');
  });
  it('keeps nonmanaged Linux and local legacy behavior', async () => {
    const input = { config: { ...config(), sourceEnv: {} } };
    expect(await admitManagedGoal(input, { platform: 'linux', isManagedHost: async () => false })).toBe(input);
    expect(await admitManagedGoal(input, { platform: 'darwin' })).toBe(input);
  });
  it('rejects malformed launcher data and mismatched identity', async () => {
    await expect(admitManagedGoal({ config: { ...config(), jobId: 'other' } }, deps)).rejects.toThrow('identity');
    for (const key of [MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV]) {
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
