import { describe, expect, it } from 'vitest';
import { deriveRuntimeJobLayout, deriveRuntimeStorageRoots } from '../runtime-storage-paths';

describe('runtime storage path contracts', () => {
  it('selects immutable neutral containers under the exact supplied storage root', () => {
    const roots = deriveRuntimeStorageRoots('/external/custom-storage');
    expect(roots).toEqual({
      rootDir: '/external/custom-storage',
      jobsRootDir: '/external/custom-storage/jobs',
      stateRootDir: '/external/custom-storage/state',
      tmpRootDir: '/external/custom-storage/tmp',
    });
    expect(Object.isFrozen(roots)).toBe(true);
  });

  it('rejects roots that could be normalized or truncated into a different location', () => {
    for (const root of ['', '/', 'relative', '/external/../root', '/external/.',
      '/external/', '//external', '/external//root', '/external\0/root']) {
      expect(() => deriveRuntimeStorageRoots(root)).toThrow();
      expect(() => deriveRuntimeJobLayout(root, 'job')).toThrow();
    }
  });

  it('uses the caller-selected job root independently of the safe identity', () => {
    const id = `J${'a'.repeat(127)}`;
    const layout = deriveRuntimeJobLayout('/external/jobs/custom-location', id);
    expect(layout.jobId).toBe(id);
    expect(layout.jobRoot).toBe('/external/jobs/custom-location');
    expect(layout.home).toBe('/external/jobs/custom-location/home');
    expect(Object.isFrozen(layout)).toBe(true);
    for (const unsafeId of ['', '..', '../job', '/job', 'job/a', 'a\0b', 'job\n',
      ' job', 'job ', 'a'.repeat(129)]) {
      expect(() => deriveRuntimeJobLayout('/external/jobs/custom-location', unsafeId)).toThrow();
    }
  });
});
