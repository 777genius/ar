import { describe, expect, it } from 'vitest';
import { mapManagedGoalLayout } from '../managed-goal-admission';
import { deriveManagedJobLayout, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV, MANAGED_MARKER_ENV } from '../managed-job-layout';
import type { CodexGoalRunConfig } from '../codex-goal-runner';
const layout = deriveManagedJobLayout('/external/runtime/jobs/test', 'test');
function config(): CodexGoalRunConfig {
  return { taskId: 'test', jobRootDir: layout.jobRoot, workspacePath: layout.workspace,
    authRootDir: '/readonly/auth', promptPath: '/readonly/prompt', accounts: [],
    sourceEnv: { [MANAGED_MARKER_ENV]: '1', [MANAGED_JOB_ROOT_ENV]: layout.jobRoot, [MANAGED_JOB_ID_ENV]: layout.jobId } };
}
describe('managed goal launcher contract', () => {
  it('pins immutable writable paths within the whole job root', () => {
    const result = mapManagedGoalLayout({ config: config() });
    expect(result.registryRootDir).toBe(layout.state + '/registry');
    expect(result.config.outputPath).toBe(layout.output + '/test.latest-result.json');
    expect(result.config.sourceEnv?.HOME).toBe(layout.home);
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(mapManagedGoalLayout(result)).toEqual(result);
  });
  it.each(['jobRootDir', 'workspacePath', 'stateRootDir', 'runtimeHomeRootDir', 'encryptionKeyPath', 'outputPath', 'progressPath'] as const)('rejects %s override', key => {
    expect(() => mapManagedGoalLayout({ config: { ...config(), [key]: '/root/escape' } })).toThrow(key);
  });
  it('rejects log and registry overrides', () => {
    for (const key of ['logPath', 'registryRootDir']) expect(() => mapManagedGoalLayout({ config: config(), [key]: '/root' })).toThrow(key);
  });
  it('keeps legacy behavior without launcher layout configuration', () => {
    const input = { config: { ...config(), sourceEnv: {} } };
    expect(mapManagedGoalLayout(input)).toBe(input);
  });
  it('rejects malformed launcher data and mismatched identity', () => {
    expect(() => mapManagedGoalLayout({ config: { ...config(), jobId: 'other' } })).toThrow('identity');
    for (const key of [MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV]) {
      const sourceEnv = { ...config().sourceEnv };
      delete sourceEnv[key];
      expect(() => mapManagedGoalLayout({ config: { ...config(), sourceEnv } })).toThrow('root-owned launcher');
    }
  });
  it('does not infer managed mode from legacy job root variables', () => {
    const input = { config: { ...config(), sourceEnv: { [MANAGED_JOB_ROOT_ENV]: '/legacy', [MANAGED_JOB_ID_ENV]: 'legacy' } } };
    expect(mapManagedGoalLayout(input)).toBe(input);
  });
});
