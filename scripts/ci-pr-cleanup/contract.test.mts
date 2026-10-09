import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Execute the production action script: a broad selector or lost lifecycle
// revalidation makes these tests cancel an unrelated/finished/live PR run.
const workflow = readFileSync(new URL('../../.github/workflows/ci-pr-cleanup.yml', import.meta.url), 'utf8');
const source = workflow.split('          script: |\n')[1];
assert.ok(source, 'Cleanup action script is present');
const script = source.split('\n').map(line => line.replace(/^            /, '')).join('\n');

interface Repository { id: number }
interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  closed_at: string | null;
  head: { sha: string; ref: string; repo: Repository | null };
  base: { repo: Repository };
}
interface Association { number: number; base: { repo: Repository }; head?: PullRequest['head'] }
interface Run {
  id: number;
  event: 'pull_request' | 'push' | 'workflow_dispatch';
  status: 'queued' | 'in_progress' | 'waiting' | 'pending' | 'requested' | 'completed';
  workflow_id: number;
  path: string;
  repository: Repository;
  head_repository: Repository;
  head_branch: string;
  head_sha: string;
  pull_requests: Association[];
}
interface Request {
  owner: string;
  repo: string;
  run_id?: number;
  workflow_id?: string | number;
  event?: string;
  status?: string;
  branch?: string;
  page?: number;
  per_page?: number;
  exclude_pull_requests?: boolean;
  pull_number?: number;
  commit_sha?: string;
  request: { timeout: number };
}
const pr: PullRequest = {
  number: 42, state: 'closed', closed_at: '2026-10-09T12:00:00Z',
  head: { sha: 'head-sha', ref: 'test/ci-cleanup', repo: { id: 99 } },
  base: { repo: { id: 10 } },
};
const association: Association = { number: 42, base: pr.base, head: pr.head };
const run = (id: number, changes: Partial<Run> = {}): Run => ({
  id, event: 'pull_request', status: 'queued', workflow_id: 20,
  path: '.github/workflows/ci.yml', repository: { id: 10 },
  head_repository: { id: 99 }, head_branch: pr.head.ref, head_sha: pr.head.sha,
  pull_requests: [association], ...changes,
});
interface Options {
  pages?: Run[][];
  live?: PullRequest[];
  details?: Run[];
  commits?: Association[][];
  closedAt?: string;
  dispatch?: string;
  cancelError?: number;
  workflowPath?: string;
}
async function execute(options: Options = {}) {
  const pages = options.pages ?? [[run(1)]];
  const details = new Map((options.details ?? pages.flat()).map(value => [value.id, value]));
  const cancelled: number[] = [];
  const logs: string[] = [];
  const scanned: number[] = [];
  let prReads = 0;
  let commitReads = 0;
  const check = (args: Request) => {
    assert.equal(args.owner, 'example');
    assert.equal(args.repo, 'base');
    assert.equal(args.request.timeout, 10000);
  };
  const github = { rest: {
    pulls: { get: async (args: Request) => {
      check(args);
      assert.equal(args.pull_number, 42);
      const data = options.live?.[prReads] ?? options.live?.at(-1) ?? pr;
      prReads++;
      return { data };
    } },
    actions: {
      getWorkflow: async (args: Request) => {
        check(args);
        assert.equal(args.workflow_id, 'ci.yml');
        return { data: { id: 20, path: options.workflowPath ?? '.github/workflows/ci.yml' } };
      },
      listWorkflowRuns: async (args: Request) => {
        check(args);
        assert.equal(args.workflow_id, 20);
        assert.equal(args.event, 'pull_request');
        assert.equal(args.branch, pr.head.ref);
        assert.equal(args.per_page, 100);
        assert.equal(args.exclude_pull_requests, false);
        if (args.status === 'queued') scanned.push(args.page!);
        return { data: { workflow_runs: args.status === 'queued' ? pages[args.page! - 1] ?? [] : [] } };
      },
      getWorkflowRun: async (args: Request) => {
        check(args);
        assert.equal(args.exclude_pull_requests, false);
        assert.ok(details.has(args.run_id!));
        return { data: details.get(args.run_id!)! };
      },
      cancelWorkflowRun: async (args: Request) => {
        check(args);
        if (options.cancelError) throw Object.assign(new Error('State changed'), { status: options.cancelError });
        cancelled.push(args.run_id!);
        return {};
      },
    },
    repos: { listPullRequestsAssociatedWithCommit: async (args: Request) => {
      check(args);
      assert.equal(args.commit_sha, pr.head.sha);
      assert.equal(args.per_page, 100);
      commitReads++;
      return { data: options.commits?.[args.page! - 1] ?? [association] };
    } },
  } };
  const context = {
    repo: { owner: 'example', repo: 'base' },
    payload: {
      repository: { id: 10 },
      ...(options.dispatch === undefined
        ? { pull_request: { number: 42, closed_at: options.closedAt ?? pr.closed_at } }
        : { inputs: { 'closed-pr-number': options.dispatch } }),
    },
  };
  const core = { info: (message: string) => logs.push(message), warning: (message: string) => logs.push(message) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...source: string[]
  ) => (github: unknown, context: unknown, core: unknown) => Promise<void>;
  await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
  return { cancelled, logs, scanned, prReads, commitReads };
}

test('cancels only CI pull-request runs with the exact base repository and PR number', async () => {
  const selected = await execute({ pages: [[
    run(1), run(2, { status: 'in_progress' }), run(3, { status: 'waiting' }),
    run(4, { status: 'pending' }), run(5, { status: 'requested' }),
    run(6, { event: 'push' }), run(7, { event: 'workflow_dispatch' }),
    run(8, { workflow_id: 21 }), run(9, { path: '.github/workflows/publish.yml' }),
    run(10, { repository: { id: 11 } }), run(11, { status: 'completed' }),
    run(12, { pull_requests: [{ ...association, number: 43 }] }),
    run(13, { pull_requests: [{ ...association, base: { repo: { id: 11 } } }] }),
    run(14, { pull_requests: [association, { ...association, number: 43 }] }),
  ]] });
  assert.deepEqual(selected.cancelled, [1, 2, 3, 4, 5]);
});

test('empty run PR links require unique commit association and exact head tuple', async () => {
  const result = await execute({ pages: [[
    run(1, { pull_requests: [] }),
    run(2, { pull_requests: [], head_sha: 'old-sha' }),
    run(3, { pull_requests: [], head_repository: { id: 98 } }),
    run(4, { pull_requests: [], head_branch: 'same-sha-other-branch' }),
  ]] });
  assert.deepEqual(result.cancelled, [1]);
  assert.equal(result.commitReads, 1);
  for (const commits of [[], [{ ...association, number: 43 }],
    [association, { ...association, number: 43 }],
    [{ ...association, base: { repo: { id: 11 } } }]]) {
    assert.deepEqual((await execute({ pages: [[run(1, { pull_requests: [] })]], commits: [commits] })).cancelled, []);
  }
});

test('detail response restores links absent from list without inferring a head match', async () => {
  const selected = await execute({ pages: [[run(1, { pull_requests: [], head_sha: 'older-sha' })]],
    details: [run(1, { head_sha: 'older-sha' })] });
  assert.deepEqual(selected.cancelled, [1]);
  assert.equal(selected.commitReads, 0);
});

test('completed runs and reopened or reclosed PR races are preserved', async () => {
  assert.deepEqual((await execute({ details: [run(1, { status: 'completed' })] })).cancelled, []);
  for (const changed of [
    { ...pr, state: 'open' as const, closed_at: null },
    { ...pr, closed_at: '2026-10-09T12:01:00Z' },
    { ...pr, head: { ...pr.head, sha: 'new-head' } },
  ]) assert.deepEqual((await execute({ live: [pr, changed] })).cancelled, []);
  assert.deepEqual((await execute({ closedAt: '2026-10-09T11:00:00Z' })).cancelled, []);
  assert.deepEqual((await execute({ live: [{ ...pr, state: 'open' }] })).cancelled, []);
  assert.deepEqual((await execute({ cancelError: 409 })).cancelled, []);
  await assert.rejects(execute({ cancelError: 403 }), /State changed/);
});

test('paginates the scan before cancellation and the empty-link fallback before selection', async () => {
  const filler = Array.from({ length: 100 }, (_, index) => run(1000 + index, { status: 'completed' }));
  const result = await execute({ pages: [filler, [run(1)]] });
  assert.deepEqual(result.scanned, [1, 2]);
  assert.deepEqual(result.cancelled, [1]);
  const unrelated = Array.from({ length: 100 }, (_, number) => ({ ...association, number: number + 100,
    head: { ...pr.head, ref: 'other-branch' } }));
  const fallback = await execute({ pages: [[run(1, { pull_requests: [] })]], commits: [unrelated, [association]] });
  assert.equal(fallback.commitReads, 2);
  assert.deepEqual(fallback.cancelled, [1]);
});

test('incomplete commit scans stay fail-safe for every candidate, and scan/candidate caps are bounded', async () => {
  const unrelated = { ...association, head: { ...pr.head, ref: 'other-branch' } };
  const full: Association[] = Array.from({ length: 100 }, () => unrelated);
  // Exactly one matching PR in a truncated result: retaining partial data
  // would let the second candidate bypass the incomplete-scan refusal.
  const incomplete = Array.from({ length: 10 }, () => full);
  incomplete[0] = [association, ...full.slice(1)];
  const result = await execute({ pages: [[run(1, { pull_requests: [] }), run(2, { pull_requests: [] })]],
    commits: incomplete });
  assert.deepEqual(result.cancelled, []);
  assert.equal(result.commitReads, 10);
  assert.ok(result.logs.some(message => message.includes('incomplete')));
  const hundred = Array.from({ length: 100 }, (_, index) => run(index + 1));
  const capped = await execute({ pages: Array.from({ length: 10 }, () => hundred) });
  assert.equal(capped.scanned.length, 10);
  assert.equal(capped.cancelled.length, 100);
  assert.ok(capped.logs.some(message => message.includes('Scan limit')));
  const limited = await execute({ pages: [hundred, [run(101)]] });
  assert.deepEqual(limited.cancelled, hundred.map(value => value.id));
  assert.ok(limited.logs.some(message => message.includes('Candidate limit')));
});

test('manual replay uses the same closed-PR guard and rejects malformed inputs', async () => {
  assert.deepEqual((await execute({ dispatch: '42' })).cancelled, [1]);
  assert.deepEqual((await execute({ dispatch: '42', live: [{ ...pr, state: 'open' }] })).cancelled, []);
  for (const dispatch of ['0', '-1', '42;echo bad', '9007199254740992']) {
    await assert.rejects(execute({ dispatch }), /positive PR number/);
  }
  await assert.rejects(execute({ workflowPath: '.github/workflows/publish.yml' }), /Unexpected CI workflow identity/);
});
