import { describe, expect, it } from 'vitest';
import { deriveManagedJobLayout, MANAGED_JOB_ID_ENV, MANAGED_JOB_ROOT_ENV, MANAGED_MARKER_ENV, type ManagedJobLayout } from '../managed-job-layout';
describe('launcher layout data contract', () => {
  it('accepts exact immutable layout without filesystem probes', () => {
    const layout = deriveManagedJobLayout('/external/runtime/jobs/job-1', 'job-1');
    expect(Object.isFrozen(layout)).toBe(true);
    expect(layout.payloadLogs).toBe('/external/runtime/jobs/job-1/payload-logs');
  });
  it('rejects noncanonical identities, roots and writable overrides', () => {
    for (const id of ['', '..', '../a', 'a/b', ' a', 'a:b', 'a\n', 'a'.repeat(129)]) expect(() => deriveManagedJobLayout('/external', id)).toThrow();
    for (const root of ['/', 'relative', '/external/../root', '/external/']) expect(() => deriveManagedJobLayout(root, 'job')).toThrow();
  });
  it('does not infer storage policy or require a host directory layout', () => {
    const layout = deriveManagedJobLayout('/sandbox/custom-root', 'job');
    expect(layout.jobRoot).toBe('/sandbox/custom-root');
    expect(layout.workspace).toBe('/sandbox/custom-root/workspace');
    expect(layout).not.toHaveProperty('storageRoot');
  });
  it('preserves all managed paths and marker exports through the compatibility import', () => {
    const layout: ManagedJobLayout = deriveManagedJobLayout('/sandbox/custom-root', 'job');
    expect(layout).toEqual({
      jobId: 'job', jobRoot: '/sandbox/custom-root',
      workspace: '/sandbox/custom-root/workspace', state: '/sandbox/custom-root/state',
      logs: '/sandbox/custom-root/logs', payloadLogs: '/sandbox/custom-root/payload-logs',
      output: '/sandbox/custom-root/output', home: '/sandbox/custom-root/home', tmp: '/sandbox/custom-root/tmp',
    });
    expect([MANAGED_MARKER_ENV, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV]).toEqual([
      'SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH', 'SUBSCRIPTION_RUNTIME_JOB_ROOT', 'SUBSCRIPTION_RUNTIME_JOB_ID',
    ]);
    expect(() => deriveManagedJobLayout('/sandbox\0/elsewhere', 'job')).toThrow('Invalid managed jobRoot');
    expect(() => deriveManagedJobLayout('/sandbox', '../job')).toThrow('Invalid managed jobId');
  });
});
