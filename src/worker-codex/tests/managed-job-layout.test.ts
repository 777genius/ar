import { describe, expect, it } from 'vitest';
import { deriveManagedJobLayout } from '../managed-job-layout';
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
});
