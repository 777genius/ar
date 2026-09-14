import { describe, expect, it } from 'vitest';
import { deriveManagedJobLayout, parseManagedJobLayout } from '../managed-job-layout';
describe('launcher layout data contract', () => {
  it('accepts exact immutable layout without filesystem probes', () => {
    const layout = deriveManagedJobLayout('/external/runtime', 'job-1');
    expect(parseManagedJobLayout(JSON.stringify(layout))).toEqual(layout);
    expect(Object.isFrozen(parseManagedJobLayout(JSON.stringify(layout)))).toBe(true);
    expect(layout.payloadLogs).toBe('/external/runtime/jobs/job-1/payload-logs');
  });
  it('rejects noncanonical identities, roots and writable overrides', () => {
    for (const id of ['', '..', '../a', 'a/b', ' a', 'a:b', 'a\n', 'a'.repeat(129)]) expect(() => deriveManagedJobLayout('/external', id)).toThrow();
    for (const root of ['/', 'relative', '/external/../root', '/external/']) expect(() => deriveManagedJobLayout(root, 'job')).toThrow();
    const layout = deriveManagedJobLayout('/external', 'job');
    for (const value of [{ ...layout, state: '/root' }, { ...layout, extra: true }, {}, [], null]) expect(() => parseManagedJobLayout(JSON.stringify(value))).toThrow();
    expect(() => parseManagedJobLayout(' '.repeat(16385))).toThrow();
  });
});
