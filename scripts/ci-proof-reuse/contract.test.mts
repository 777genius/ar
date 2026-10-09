import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactName, CAPTURE_STEP, CHECKOUT_ACTION, IDENTITY_MARKER, LANES, ProofFamily,
  ReuseDecision, SETUP_NODE_ACTION, TTL_MS, UPLOAD_STEP, WORKFLOW_PATH,
  observeCheckout, type Artifact, type Fingerprint, type GitCommit, type Job, type PullRequest,
  type Receipt, type Run, type Target } from './protocol.mts';
import type { ProofGitHub } from './github.mts';
import { findReusableProof } from './reuse.mts';
// These contracts fail if a claimed artifact tree, latest-attempt jobs, failed
// certification step, foreign workflow or incomplete scan can suppress tests.
const hash = (digit: string): string => digit.repeat(40);
const digest = (digit: string): string => digit.repeat(64);
const fingerprint: Fingerprint = { runnerLabel: 'arc-runner-set', imageDigest: `sha256:${digest('1')}`,
  configRevision: digest('2'), os: 'linux', architecture: 'x64', kernel: '6.8.0', osReleaseHash: digest('3'),
  nodeVersion: 'v22.23.3', nodeBinaryHash: digest('4'), npmVersion: '10.9.9', gitVersion: 'git version 2.55.0',
  resticVersion: 'restic 0.16.4 compiled with go1.22.2 on linux/amd64', resticBinaryHash: digest('5') };
const repository = { id: 10, full_name: 'example/repository' };
const target: Target = { repositoryId: 10, repository: repository.full_name, sha: hash('a'), tree: hash('b'),
  workflowId: 20, workflowBlob: hash('c'), lockBlob: hash('d'), fingerprint, now: Date.parse('2026-10-09T12:10:00Z') };
const pr: PullRequest = { number: 42, state: 'closed', merged_at: '2026-10-09T12:05:00Z', merge_commit_sha: target.sha,
  head: { sha: hash('e'), ref: 'perf/proof', repo: repository }, base: { ref: 'main', repo: repository } };
const run: Run = { id: 30, run_attempt: 1, event: 'pull_request', status: 'completed', path: WORKFLOW_PATH,
  workflow_id: 20, repository, head_repository: repository, head_sha: pr.head.sha, head_branch: pr.head.ref,
  created_at: '2026-10-09T12:00:00Z', pull_requests: [] };
const checkout = hash('f');
const commit: GitCommit = { sha: checkout, tree: { sha: target.tree }, parents: [{ sha: hash('9') }, { sha: run.head_sha }] };
function fixture() {
  const receipts = new Map<number, Receipt>();
  const logs = new Map<number, string>();
  const jobs: Job[] = LANES.map((lane, index) => {
    const receipt: Receipt = { version: 1, repositoryId: 10, repository: repository.full_name, runId: 30, attempt: 1,
      family: lane.family, lane: lane.lane, checkoutSha: checkout, tree: target.tree, workflowBlob: target.workflowBlob,
      lockBlob: target.lockBlob, fingerprint: { ...fingerprint,
        ...(lane.family === ProofFamily.Crash ? { resticVersion: '', resticBinaryHash: '' } : {}) } };
    receipts.set(index + 100, receipt);
    const step = (name: string, number: number) => ({ name, number, status: 'completed', conclusion: 'success',
      started_at: `2026-10-09T12:00:${String(number * 10).padStart(2, '0')}Z`,
      completed_at: `2026-10-09T12:00:${String(number * 10 + 1).padStart(2, '0')}Z` });
    logs.set(index + 100, [
      `2026-10-09T12:00:01.100Z Download action repository 'actions/checkout@${CHECKOUT_ACTION}' (SHA:${CHECKOUT_ACTION})`,
      `2026-10-09T12:00:01.200Z Download action repository 'actions/setup-node@${SETUP_NODE_ACTION}' (SHA:${SETUP_NODE_ACTION})`,
      '2026-10-09T12:00:10.100Z [command]/usr/bin/git log -1 --format=%H',
      `2026-10-09T12:00:10.200Z ${checkout}`,
      `2026-10-09T12:00:20.100Z node: ${fingerprint.nodeVersion}`,
      `2026-10-09T12:00:20.200Z npm: ${fingerprint.npmVersion}`,
      `2026-10-09T12:00:30.100Z ${IDENTITY_MARKER}${JSON.stringify(receipt)}`,
    ].join('\n'));
    return { id: index + 100, run_id: 30, run_attempt: 1, head_sha: run.head_sha, name: lane.name,
      status: 'completed', conclusion: 'success', labels: [fingerprint.runnerLabel],
      started_at: run.created_at, completed_at: '2026-10-09T12:04:00Z',
      steps: [step(`Run actions/checkout@${CHECKOUT_ACTION}`, 1), step(`Run actions/setup-node@${SETUP_NODE_ACTION}`, 2),
        step(CAPTURE_STEP, 3), step('Run npm ci', 4), step(lane.testStep, 5),
        { ...step(UPLOAD_STEP, 6), started_at: '2026-10-09T12:01:00Z', completed_at: '2026-10-09T12:01:01Z' }] };
  });
  const artifacts: Artifact[] = LANES.map((lane, index) => ({ id: index + 100, name: artifactName(1, lane), expired: false,
    size_in_bytes: 1000, digest: `sha256:${digest('1')}`, workflow_run: { id: 30, head_sha: run.head_sha } }));
  const attemptReads: number[] = [];
  const github: ProofGitHub = {
    associatedPulls: async () => [pr], pull: async () => pr, runs: async () => [run],
    attempt: async (_id, attempt) => { attemptReads.push(attempt); return { ...run, run_attempt: attempt }; },
    jobs: async () => jobs, artifacts: async () => artifacts,
    log: async id => { assert.ok(logs.has(id)); return logs.get(id)!; },
    receipt: async artifact => { assert.ok(receipts.has(artifact.id)); return receipts.get(artifact.id)!; },
    commit: async () => commit, blob: async path => path === WORKFLOW_PATH ? target.workflowBlob : target.lockBlob,
  };
  return { github, jobs, artifacts, receipts, logs, attemptReads };
}
test('proves precisely four unit and eight crash jobs even when unrelated CI fails', async () => {
  const setup = fixture();
  setup.jobs.push({ ...setup.jobs[0]!, id: 500, name: 'observer-mount-tests', conclusion: 'failure', steps: [] });
  const result = await findReusableProof(target, setup.github);
  assert.equal(result.decision, ReuseDecision.Reuse);
  assert.equal(result.attempt, 1);
  assert.equal(result.jobIds?.length, 12);
});
test('a cancelled later rerun cannot replace the completed earlier attempt', async () => {
  const setup = fixture();
  setup.github.runs = async () => [{ ...run, run_attempt: 2, status: 'completed' }];
  setup.github.attempt = async (_id, attempt) => { setup.attemptReads.push(attempt); return { ...run, run_attempt: attempt }; };
  const originalJobs = setup.github.jobs;
  setup.github.jobs = async (id, attempt) => attempt === 2 ? [] : originalJobs(id, attempt);
  const result = await findReusableProof(target, setup.github);
  assert.equal(result.decision, ReuseDecision.Reuse);
  assert.equal(result.attempt, 1);
  assert.deepEqual(setup.attemptReads, [2, 1, 1]);
});
test('mixed-attempt, missing, duplicate, skipped and continue-on-error lane results fail closed', async () => {
  for (const mutate of [
    (setup: ReturnType<typeof fixture>) => { setup.jobs[0]!.run_attempt = 2; },
    (setup: ReturnType<typeof fixture>) => { setup.jobs.pop(); },
    (setup: ReturnType<typeof fixture>) => { setup.jobs.push({ ...setup.jobs[0]! }); },
    (setup: ReturnType<typeof fixture>) => { setup.jobs[0]!.steps[4]!.conclusion = 'failure'; },
    (setup: ReturnType<typeof fixture>) => { setup.jobs[0]!.steps[4]!.status = 'skipped'; },
    (setup: ReturnType<typeof fixture>) => { setup.jobs[0]!.conclusion = 'cancelled'; },
    (setup: ReturnType<typeof fixture>) => { setup.artifacts.pop(); },
    (setup: ReturnType<typeof fixture>) => { setup.artifacts.push({ ...setup.artifacts[0]!, id: 999 }); },
  ]) {
    const setup = fixture(); mutate(setup);
    assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full);
  }
});
test('artifact tree claim cannot override one authoritative wrong checkout or Git tree', async () => {
  for (const forge of ['log', 'commit', 'receipt', 'workflow', 'lock']) {
    const setup = fixture();
    if (forge === 'log') setup.logs.set(100, setup.logs.get(100)!.replace(`.200Z ${checkout}`, `.200Z ${hash('8')}`));
    if (forge === 'commit') setup.github.commit = async () => ({ ...commit, tree: { sha: hash('8') } });
    if (forge === 'receipt') setup.receipts.set(100, { ...setup.receipts.get(100)!, checkoutSha: hash('8') });
    if (forge === 'workflow') setup.github.blob = async () => hash('8');
    if (forge === 'lock') setup.receipts.set(100, { ...setup.receipts.get(100)!, lockBlob: hash('8') });
    assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full, forge);
  }
});
test('foreign repository/event/workflow/PR links and stale proof are rejected', async () => {
  for (const changes of [
    { event: 'push' }, { repository: { id: 11, full_name: 'foreign/repo' } },
    { head_repository: { id: 11, full_name: 'foreign/repo' } }, { workflow_id: 21 },
    { path: '.github/workflows/other.yml' }, { head_sha: hash('8') },
    { pull_requests: [{ number: 43, base: { repo: repository } }] },
    { created_at: new Date(target.now - TTL_MS - 1).toISOString() },
  ]) {
    const setup = fixture(); setup.github.attempt = async () => ({ ...run, ...changes });
    assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full);
  }
  const setup = fixture(); setup.github.pull = async () => ({ ...pr, head: { ...pr.head, repo: { id: 11, full_name: 'fork/repo' } } });
  assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full);
});
test('empty run PR links require a unique authoritative head commit association', async () => {
  const setup = fixture();
  setup.github.associatedPulls = async sha => sha === target.sha ? [pr] : [pr, { ...pr, number: 43 }];
  assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full);
});
test('runner/toolchain epoch changes, unknown fingerprint and API failure execute full gates', async () => {
  for (const changes of [{ imageDigest: '' }, { configRevision: '' }, { nodeVersion: 'v22.23.4' },
    { resticBinaryHash: digest('6') }, { runnerLabel: 'another-pool' }, { kernel: 'new-kernel' }]) {
    const setup = fixture();
    assert.equal((await findReusableProof({ ...target, fingerprint: { ...fingerprint, ...changes } }, setup.github)).decision, ReuseDecision.Full);
  }
  const setup = fixture(); setup.github.jobs = async () => { throw new Error('Partial page or API unavailable'); };
  assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full);
});
test('late/ambiguous capture or forged checkout log after tests never grants proof', async () => {
  const setup = fixture();
  setup.jobs[0]!.steps[2]!.number = 5;
  assert.equal((await findReusableProof(target, setup.github)).decision, ReuseDecision.Full);
  const clean = fixture();
  const forged = clean.logs.get(100)!.replace('12:00:10.100Z', '12:03:10.100Z').replace('12:00:10.200Z', '12:03:10.200Z');
  assert.throws(() => observeCheckout(clean.jobs[0]!, forged), /checkout observation/);
  clean.logs.set(100, `${clean.logs.get(100)}\n2026-10-09T12:00:10.300Z [command]/usr/bin/git log -1 --format=%H\n2026-10-09T12:00:10.400Z ${checkout}`);
  assert.equal((await findReusableProof(target, clean.github)).decision, ReuseDecision.Full);
});
