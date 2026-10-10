import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, fingerprint, git } from './identity.mts';
import { GitHubReader } from './github.mts';
import { findReusableProof, type Result } from './reuse.mts';
import { demand, IDENTITY_MARKER, ProofFamily, ReuseDecision, WORKFLOW_PATH } from './protocol.mts';
async function output(result: Result): Promise<void> {
  const reused = result.decision === ReuseDecision.Reuse;
  const values = `reuse_unit=${reused}\nreuse_crash=${reused}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, values);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `CI proof decision: **${result.decision}**. ${result.reason}\n${reused ? `Source run ${result.runId}, attempt ${result.attempt}; job IDs: ${result.jobIds?.join(', ')}.\n` : ''}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
export async function main(): Promise<void> {
  if (process.argv[2] === 'capture') {
    const family = process.env.CI_PROOF_FAMILY;
    demand(family === ProofFamily.Unit || family === ProofFamily.Crash, 'Unknown proof family');
    const receipt = capture(family, Number(process.env.CI_PROOF_LANE));
    const path = process.env.CI_PROOF_RECEIPT_PATH;
    demand(path && resolve(path) === path && path.startsWith(`${process.env.RUNNER_TEMP}/ci-proof-`), 'Invalid owned receipt path');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${IDENTITY_MARKER}${JSON.stringify(receipt)}\n`);
    return;
  }
  demand(process.argv[2] === 'detect', 'Expected capture or detect');
  try {
    demand(process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main', 'Only trusted main pushes can reuse');
    const sha = git(['rev-parse', 'HEAD']);
    demand(sha === process.env.GITHUB_SHA, 'Detector checkout differs from trusted main push');
    const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
    const runId = Number(process.env.GITHUB_RUN_ID);
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    demand([repositoryId, runId, attempt].every(value => Number.isSafeInteger(value) && value > 0), 'Missing GitHub identity');
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    const github = new GitHubReader(repository, process.env.GITHUB_TOKEN ?? '');
    const current = await github.attempt(runId, attempt);
    demand(current.event === 'push' && current.repository.id === repositoryId && current.path === WORKFLOW_PATH
      && current.id === runId && current.run_attempt === attempt && current.head_sha === sha, 'Untrusted detector workflow context');
    const result = await findReusableProof({ repositoryId, repository, sha, tree: git(['rev-parse', 'HEAD^{tree}']),
      workflowId: current.workflow_id, workflowBlob: git(['rev-parse', `HEAD:${WORKFLOW_PATH}`]),
      lockBlob: git(['rev-parse', 'HEAD:package-lock.json']), fingerprint: fingerprint(true, true), now: Date.now() }, github);
    await output(result);
  } catch (error) {
    // API failures and unknown identities cost performance, never coverage.
    await output({ decision: ReuseDecision.Full, reason: error instanceof Error ? error.message : 'Unknown detector failure' });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
