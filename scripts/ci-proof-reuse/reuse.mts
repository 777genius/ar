import { artifactName, demand, LANES, observeCheckout, observeReceipt, ProofRejected, ReuseDecision, selectJobs,
  validateReceipt, validateRun, validateToolchainLog, WORKFLOW_PATH,
  type PullRequest, type Run, type Target } from './protocol.mts';
import type { ProofGitHub } from './github.mts';
export interface Result { decision: ReuseDecision; reason: string; runId?: number; attempt?: number; jobIds?: number[] }
const full = (reason: string): Result => ({ decision: ReuseDecision.Full, reason });
async function verify(target: Target, pr: PullRequest, run: Run, github: ProofGitHub): Promise<Result> {
  validateRun(target, pr, run);
  if (run.pull_requests.length === 0) {
    const headAssociations = await github.associatedPulls(run.head_sha);
    demand(headAssociations.length === 1 && headAssociations[0]!.number === pr.number
      && headAssociations[0]!.head.sha === run.head_sha && headAssociations[0]!.head.ref === run.head_branch
      && headAssociations[0]!.head.repo?.id === target.repositoryId
      && headAssociations[0]!.base.repo.id === target.repositoryId,
      'No unique authoritative source PR association');
  }
  const jobs = selectJobs(target, run, await github.jobs(run.id, run.run_attempt));
  const artifacts = await github.artifacts(run.id);
  demand(new Set(artifacts.map(artifact => artifact.id)).size === artifacts.length, 'Duplicate artifact IDs');
  const commits = new Map<string, ReturnType<ProofGitHub['commit']>>();
  const blobs = new Map<string, Promise<string>>();
  const sourceBlob = (path: string, ref: string): Promise<string> => {
    const key = `${ref}:${path}`;
    if (!blobs.has(key)) blobs.set(key, github.blob(path, ref));
    return blobs.get(key)!;
  };
  // Bound log/archive downloads to four lanes at once.
  for (let offset = 0; offset < LANES.length; offset += 4) {
    await Promise.all(LANES.slice(offset, offset + 4).map(async lane => {
      const job = jobs.find(job => job.name === lane.name)!;
      const matching = artifacts.filter(artifact => artifact.name === artifactName(run.run_attempt, lane));
      demand(matching.length === 1, 'Missing or duplicate proof artifact');
      const artifact = matching[0]!;
      demand(!artifact.expired && artifact.workflow_run.id === run.id && artifact.workflow_run.head_sha === run.head_sha,
        'Untrusted artifact run binding');
      const [log, receipt] = await Promise.all([github.log(job.id), github.receipt(artifact)]);
      const logged = observeReceipt(job, log);
      const checkout = observeCheckout(job, log);
      if (!commits.has(checkout)) commits.set(checkout, github.commit(checkout));
      const commit = await commits.get(checkout)!;
      validateReceipt(target, run, lane, receipt, logged, checkout, commit);
      validateToolchainLog(job, log, receipt);
      const [testedWorkflow, headWorkflow, testedLock] = await Promise.all([
        sourceBlob(WORKFLOW_PATH, checkout), sourceBlob(WORKFLOW_PATH, run.head_sha), sourceBlob('package-lock.json', checkout),
      ]);
      demand(testedWorkflow === target.workflowBlob && headWorkflow === target.workflowBlob && testedLock === target.lockBlob,
        'Authoritative source workflow/lock mismatch');
    }));
  }
  demand(commits.size === 1, 'Lanes checked out different merge commits');
  // Revalidate the source and target association after all downloads. A later
  // cancelled rerun does not rewrite the completed attempt we actually proved.
  const [livePr, liveRun] = await Promise.all([github.pull(pr.number), github.attempt(run.id, run.run_attempt)]);
  validateRun(target, livePr, liveRun);
  demand(liveRun.id === run.id && liveRun.run_attempt === run.run_attempt && liveRun.head_sha === run.head_sha, 'Source attempt changed');
  return { decision: ReuseDecision.Reuse, reason: 'Verified all four unit shards and eight crash lanes on the exact main tree',
    runId: run.id, attempt: run.run_attempt, jobIds: jobs.map(job => job.id).sort((a, b) => a - b) };
}
export async function findReusableProof(target: Target, github: ProofGitHub): Promise<Result> {
  try {
    demand(/^sha256:[a-f0-9]{64}$/.test(target.fingerprint.imageDigest)
      && /^[a-f0-9]{64}$/.test(target.fingerprint.configRevision), 'Unknown runner image/config; run full gates');
    const associated = await github.associatedPulls(target.sha);
    const matching = associated.filter(pr => pr.merge_commit_sha === target.sha && pr.merged_at
      && pr.head.repo?.id === target.repositoryId && pr.base.repo.id === target.repositoryId && pr.base.ref === 'main');
    demand(matching.length === 1, 'No unique trusted merged PR for current main commit');
    const pr = await github.pull(matching[0]!.number);
    const candidates = await github.runs(target.workflowId, pr.head.sha);
    demand(candidates.length <= 10 && new Set(candidates.map(run => run.id)).size === candidates.length, 'Run scan ambiguous or over bound');
    let reason = 'No completed PR attempt has all required proofs';
    for (const candidate of candidates) {
      demand(Number.isSafeInteger(candidate.run_attempt) && candidate.run_attempt > 0 && candidate.run_attempt <= 3, 'Attempt scan exceeded bound');
      for (let attempt = candidate.run_attempt; attempt >= 1; attempt--) {
        try {
          const run = await github.attempt(candidate.id, attempt);
          demand(run.id === candidate.id && run.run_attempt === attempt, 'Wrong attempt returned');
          return await verify(target, pr, run, github);
        } catch (error) {
          if (!(error instanceof ProofRejected)) throw error;
          reason = error instanceof Error ? error.message : 'Unknown verification failure';
        }
      }
    }
    return full(reason);
  } catch (error) {
    return full(error instanceof Error ? error.message : 'Unknown proof lookup failure');
  }
}
