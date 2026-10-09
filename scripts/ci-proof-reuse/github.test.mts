import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubReader } from './github.mts';
// Exercise the actual transport paginator; partial pages must never masquerade
// as complete authoritative job or artifact evidence.
test('GitHub pagination refuses partial, changing and over-bound snapshots', async () => {
  const original = globalThis.fetch;
  try {
    for (const bodies of [
      [{ total_count: 2, jobs: [{ id: 1 }] }],
      [{ total_count: 301, jobs: [] }],
      [{ total_count: 101, jobs: Array.from({ length: 100 }, (_, id) => ({ id })) }, { total_count: 100, jobs: [] }],
    ]) {
      let calls = 0;
      globalThis.fetch = async input => {
        assert.ok(String(input).includes('/actions/runs/30/attempts/1/jobs'));
        return new Response(JSON.stringify(bodies[calls++] ?? {}), { status: 200 });
      };
      await assert.rejects(new GitHubReader('example/repository', 'test-token').jobs(30, 1), /Partial|Incomplete/);
    }
    let calls = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({ total_count: 101,
      jobs: calls++ === 0 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }] }));
    assert.equal((await new GitHubReader('example/repository', 'test-token').jobs(30, 1)).length, 101);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
test('signed redirects never receive the repository token and unexpected hosts fail closed', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      if (calls++ === 0) {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
        return new Response(null, { status: 302, headers: { location: 'https://proof.blob.core.windows.net/log?signature=example' } });
      }
      assert.equal(init?.headers, undefined);
      assert.equal(new URL(String(input)).hostname, 'proof.blob.core.windows.net');
      return new Response('bounded trusted log');
    };
    assert.equal(await new GitHubReader('example/repository', 'test-token').log(100), 'bounded trusted log');
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/collect' } });
    await assert.rejects(new GitHubReader('example/repository', 'test-token').log(100), /Untrusted/);
  } finally { globalThis.fetch = original; }
});
