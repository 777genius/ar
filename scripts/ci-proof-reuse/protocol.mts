export enum ProofFamily { Unit = 'unit', Crash = 'crash' }
export enum ReuseDecision { Full = 'full', Reuse = 'reuse' }
export enum WorkflowEvent { PullRequest = 'pull_request', Push = 'push' }
export const WORKFLOW_PATH = '.github/workflows/ci.yml';
export const CHECKOUT_ACTION = '11d5960a326750d5838078e36cf38b85af677262';
export const SETUP_NODE_ACTION = '49933ea5288caeca8642d1e84afbd3f7d6820020';
export const CAPTURE_STEP = 'Capture CI proof identity before source execution';
export const UPLOAD_STEP = 'Publish successful CI lane proof';
export const IDENTITY_MARKER = 'CI_PROOF_IDENTITY=';
export const TTL_MS = 24 * 60 * 60 * 1000;
export interface Fingerprint {
  runnerLabel: string;
  imageDigest: string;
  configRevision: string;
  os: string;
  architecture: string;
  kernel: string;
  osReleaseHash: string;
  nodeVersion: string;
  nodeBinaryHash: string;
  npmVersion: string;
  gitVersion: string;
  resticVersion: string;
  resticBinaryHash: string;
}
export interface Receipt {
  version: 1;
  repositoryId: number;
  repository: string;
  runId: number;
  attempt: number;
  family: ProofFamily;
  lane: number;
  checkoutSha: string;
  tree: string;
  workflowBlob: string;
  lockBlob: string;
  fingerprint: Fingerprint;
}
export interface Step {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string;
}
export interface Job {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  labels: string[];
  started_at: string;
  completed_at: string;
  steps: Step[];
}
export interface Repository { id: number; full_name: string }
export interface PullRequest {
  number: number;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: Repository | null };
  base: { ref: string; repo: Repository };
}
export interface Run {
  id: number;
  run_attempt: number;
  event: string;
  status: string;
  path: string;
  workflow_id: number;
  repository: Repository;
  head_repository: Repository;
  head_sha: string;
  head_branch: string;
  created_at: string;
  pull_requests: { number: number; base: { repo: Repository } }[];
}
export interface GitCommit { sha: string; tree: { sha: string }; parents: { sha: string }[] }
export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  digest: string;
  workflow_run: { id: number; head_sha: string };
}
export interface Target {
  repositoryId: number;
  repository: string;
  sha: string;
  tree: string;
  workflowId: number;
  workflowBlob: string;
  lockBlob: string;
  fingerprint: Fingerprint;
  now: number;
}
export interface Lane { family: ProofFamily; lane: number; name: string; testStep: string }
export const LANES: readonly Lane[] = [
  ...Array.from({ length: 4 }, (_, index) => ({ family: ProofFamily.Unit, lane: index + 1,
    name: `Unit tests (${index + 1}/4)`, testStep: 'Run unit shard in a private TEST home' })),
  ...Array.from({ length: 8 }, (_, lane) => ({ family: ProofFamily.Crash, lane,
    name: `crash-boundary-shards (${lane})`, testStep: `Certify crash-boundary shards in lane ${lane}` })),
];
export class ProofRejected extends Error {}
export function demand(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ProofRejected(reason);
}
export function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value); }
export function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function artifactName(attempt: number, lane: Lane): string { return `ci-proof-v1-${attempt}-${lane.family}-${lane.lane}`; }
export function uniqueStep(job: Job, name: string): Step {
  const found = job.steps.filter(step => step.name === name);
  demand(found.length === 1, `Missing or ambiguous step: ${name}`);
  const step = found[0]!;
  demand(step.status === 'completed' && step.conclusion === 'success', `Step did not succeed: ${name}`);
  demand(Number.isFinite(Date.parse(step.started_at)) && Number.isFinite(Date.parse(step.completed_at))
    && Date.parse(step.completed_at) >= Date.parse(step.started_at), 'Missing or reversed step times');
  return step;
}
function logLines(log: string, step: Step): string[] {
  const start = Date.parse(step.started_at) - 1000;
  const end = Date.parse(step.completed_at) + 1000;
  return log.replace(/^\uFEFF/, '').split('\n').flatMap(line => {
    const found = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)$/.exec(line);
    if (!found || Date.parse(found[1]!) < start || Date.parse(found[1]!) > end) return [];
    return [found[2]!];
  });
}
export function observeCheckout(job: Job, log: string): string {
  const checkout = uniqueStep(job, `Run actions/checkout@${CHECKOUT_ACTION}`);
  const lines = logLines(log, checkout);
  const observations = lines.flatMap((line, index) => line === '[command]/usr/bin/git log -1 --format=%H'
    && sha(lines[index + 1]) ? [lines[index + 1]!] : []);
  demand(observations.length === 1, 'Missing or ambiguous authoritative checkout observation');
  // This is the checkout action's observation, before ANY source-controlled run.
  demand(job.steps.every(step => step.number <= checkout.number || Date.parse(step.started_at) >= Date.parse(checkout.started_at)), 'Invalid checkout ordering');
  return observations[0]!;
}
export function observeReceipt(job: Job, log: string): Receipt {
  const capture = uniqueStep(job, CAPTURE_STEP);
  const install = job.steps.filter(step => step.name.includes('npm ci'));
  const builds = job.steps.filter(step => step.name.startsWith('Run npm run build'));
  demand(install.length === 1 && [...install, ...builds].every(step => step.number > capture.number), 'Identity captured after source execution');
  const markers = logLines(log, capture).filter(line => line.startsWith(IDENTITY_MARKER));
  demand(markers.length === 1, 'Missing or ambiguous pre-source identity');
  return JSON.parse(markers[0]!.slice(IDENTITY_MARKER.length)) as Receipt;
}
export function validateRun(target: Target, pr: PullRequest, run: Run): void {
  demand(pr.state === 'closed' && pr.merged_at && pr.merge_commit_sha === target.sha, 'PR does not identify this merged main commit');
  demand(pr.base.ref === 'main' && pr.base.repo.id === target.repositoryId
    && pr.head.repo?.id === target.repositoryId, 'Foreign repository or base branch');
  demand(run.event === WorkflowEvent.PullRequest && run.status === 'completed'
    && run.repository.id === target.repositoryId && run.head_repository.id === target.repositoryId
    && run.repository.full_name === target.repository && run.workflow_id === target.workflowId
    && run.path === WORKFLOW_PATH && run.head_sha === pr.head.sha && run.head_branch === pr.head.ref
    && positive(run.id) && positive(run.run_attempt), 'Untrusted workflow attempt');
  demand(run.pull_requests.length === 0 || (run.pull_requests.length === 1
    && run.pull_requests[0]!.number === pr.number
    && run.pull_requests[0]!.base.repo.id === target.repositoryId), 'Conflicting run PR association');
  const created = Date.parse(run.created_at);
  demand(Number.isFinite(created) && target.now >= created && target.now - created <= TTL_MS, 'Proof expired');
}
export function selectJobs(target: Target, run: Run, jobs: Job[]): Job[] {
  demand(new Set(jobs.map(job => job.id)).size === jobs.length, 'Duplicate job IDs');
  const matched = jobs.filter(job => LANES.some(lane => lane.name === job.name));
  demand(matched.length === LANES.length && new Set(matched.map(job => job.name)).size === LANES.length, 'Incomplete or duplicate lane proofs');
  for (const job of matched) {
    demand(positive(job.id) && job.run_id === run.id && job.run_attempt === run.run_attempt
      && job.head_sha === run.head_sha && job.status === 'completed' && job.conclusion === 'success', 'Lane from wrong or unsuccessful attempt');
    demand(job.labels.length === 1 && job.labels[0] === target.fingerprint.runnerLabel, 'Runner configuration mismatch');
    const finished = Date.parse(job.completed_at);
    demand(Number.isFinite(finished) && target.now >= finished && target.now - finished <= TTL_MS, 'Lane proof expired');
    const capture = uniqueStep(job, CAPTURE_STEP);
    uniqueStep(job, UPLOAD_STEP);
    const test = uniqueStep(job, LANES.find(lane => lane.name === job.name)!.testStep);
    demand(capture.number < test.number, 'Proof identity captured after tests');
  }
  return matched;
}
export function validateReceipt(target: Target, run: Run, lane: Lane, receipt: Receipt, logged: Receipt, checkout: string, commit: GitCommit): void {
  demand(JSON.stringify(receipt) === JSON.stringify(logged), 'Artifact differs from pre-source identity');
  demand(receipt.version === 1 && receipt.repositoryId === target.repositoryId && receipt.repository === target.repository
    && receipt.runId === run.id && receipt.attempt === run.run_attempt && receipt.family === lane.family
    && receipt.lane === lane.lane, 'Forged or mismatched receipt identity');
  demand(sha(checkout) && receipt.checkoutSha === checkout && commit.sha === checkout
    && commit.parents.length === 2 && commit.parents[1]!.sha === run.head_sha
    && commit.tree.sha === target.tree && receipt.tree === target.tree, 'Tested merge tree mismatch');
  demand(receipt.workflowBlob === target.workflowBlob && receipt.lockBlob === target.lockBlob, 'Workflow or lock mismatch');
  const expected = { ...target.fingerprint };
  if (lane.family === ProofFamily.Crash) { expected.resticVersion = ''; expected.resticBinaryHash = ''; }
  demand(JSON.stringify(receipt.fingerprint) === JSON.stringify(expected), 'Toolchain or runner fingerprint mismatch');
  demand(/^sha256:[a-f0-9]{64}$/.test(expected.imageDigest) && /^[a-f0-9]{64}$/.test(expected.configRevision)
    && expected.runnerLabel.length > 0 && /^v22\./.test(expected.nodeVersion), 'Missing trusted runner fingerprint');
}
export function validateToolchainLog(job: Job, log: string, receipt: Receipt): void {
  const setup = uniqueStep(job, `Run actions/setup-node@${SETUP_NODE_ACTION}`);
  const nodes = logLines(log, setup).filter(line => line.startsWith('node: '));
  const npm = logLines(log, setup).filter(line => line.startsWith('npm: '));
  demand(nodes.length === 1 && nodes[0] === `node: ${receipt.fingerprint.nodeVersion}`
    && npm.length === 1 && npm[0] === `npm: ${receipt.fingerprint.npmVersion}`, 'Independent Node/npm observation mismatch');
  demand(log.includes(`Download action repository 'actions/checkout@${CHECKOUT_ACTION}' (SHA:${CHECKOUT_ACTION})`)
    && log.includes(`Download action repository 'actions/setup-node@${SETUP_NODE_ACTION}' (SHA:${SETUP_NODE_ACTION})`), 'Action resolution mismatch');
}
