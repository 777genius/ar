import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demand, type Artifact, type GitCommit, type Job, type PullRequest, type Receipt, type Run } from './protocol.mts';
export interface ProofGitHub {
  associatedPulls(sha: string): Promise<PullRequest[]>;
  pull(number: number): Promise<PullRequest>;
  runs(workflowId: number, head: string): Promise<Run[]>;
  attempt(id: number, attempt: number): Promise<Run>;
  jobs(id: number, attempt: number): Promise<Job[]>;
  artifacts(id: number): Promise<Artifact[]>;
  log(id: number): Promise<string>;
  receipt(artifact: Artifact): Promise<Receipt>;
  commit(sha: string): Promise<GitCommit>;
  blob(path: string, ref: string): Promise<string>;
}
export class GitHubReader implements ProofGitHub {
  readonly base: string;
  readonly token: string;
  constructor(repository: string, token: string) {
    demand(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && token.length > 0, 'Invalid GitHub reader context');
    this.base = `https://api.github.com/repos/${repository}`;
    this.token = token;
  }
  private async bytes(path: string, limit: number): Promise<Buffer> {
    let response = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(10000), redirect: 'manual',
    });
    if (response.status === 302) {
      const location = new URL(response.headers.get('location') ?? '');
      demand(location.protocol === 'https:' && (location.hostname.endsWith('.blob.core.windows.net')
        || location.hostname.endsWith('.githubusercontent.com') || location.hostname.endsWith('.actions.githubusercontent.com')),
      'Untrusted artifact or log redirect');
      // Never forward the repository token to signed object-storage URLs.
      response = await fetch(location, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    }
    demand(response.ok && response.body, `GitHub read failed: ${response.status}`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      demand(length <= limit, 'GitHub response exceeded bound');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  private async json<T>(path: string): Promise<T> { return JSON.parse((await this.bytes(path, 2_000_000)).toString('utf8')) as T; }
  private async page<T>(path: string, key: string, pages = 3): Promise<T[]> {
    const result: T[] = [];
    let total: number | undefined;
    for (let page = 1; page <= pages; page++) {
      const body = await this.json<Record<string, unknown>>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      demand(Array.isArray(body[key]) && Number.isSafeInteger(body.total_count), 'Malformed paginated GitHub result');
      total ??= body.total_count as number;
      demand(total >= 0 && total === body.total_count && total <= pages * 100, 'Incomplete or unstable GitHub pagination');
      const items = body[key] as T[];
      demand(items.length <= 100, 'Oversized GitHub page');
      result.push(...items);
      if (result.length === total) return result;
      demand(result.length < total && items.length === 100, 'Partial GitHub page');
    }
    throw new Error('Incomplete GitHub scan');
  }
  async associatedPulls(sha: string): Promise<PullRequest[]> {
    const pulls = await this.json<PullRequest[]>(`/commits/${sha}/pulls?per_page=100`);
    demand(Array.isArray(pulls) && pulls.length < 100, 'Incomplete associated-PR scan');
    return pulls;
  }
  async pull(number: number): Promise<PullRequest> { return this.json(`/pulls/${number}`); }
  async runs(workflowId: number, head: string): Promise<Run[]> {
    return this.page(`/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${head}&exclude_pull_requests=false`, 'workflow_runs', 2);
  }
  async attempt(id: number, attempt: number): Promise<Run> { return this.json(`/actions/runs/${id}/attempts/${attempt}?exclude_pull_requests=false`); }
  async jobs(id: number, attempt: number): Promise<Job[]> { return this.page(`/actions/runs/${id}/attempts/${attempt}/jobs`, 'jobs'); }
  async artifacts(id: number): Promise<Artifact[]> { return this.page(`/actions/runs/${id}/artifacts`, 'artifacts'); }
  async log(id: number): Promise<string> { return (await this.bytes(`/actions/jobs/${id}/logs`, 24_000_000)).toString('utf8'); }
  async commit(sha: string): Promise<GitCommit> { return this.json(`/git/commits/${sha}`); }
  async blob(path: string, ref: string): Promise<string> {
    const value = await this.json<{ type: string; sha: string }>(`/contents/${path}?ref=${ref}`);
    demand(value.type === 'file' && /^[a-f0-9]{40}$/.test(value.sha), 'Missing source blob');
    return value.sha;
  }
  async receipt(artifact: Artifact): Promise<Receipt> {
    demand(artifact.size_in_bytes > 0 && artifact.size_in_bytes < 65536 && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), 'Invalid proof artifact bounds/digest');
    const zip = await this.bytes(`/actions/artifacts/${artifact.id}/zip`, 65536);
    demand(`sha256:${createHash('sha256').update(zip).digest('hex')}` === artifact.digest, 'Proof artifact digest mismatch');
    const directory = await mkdtemp(join(tmpdir(), 'ci-proof-read-'));
    const path = join(directory, 'proof.zip');
    try {
      await writeFile(path, zip, { mode: 0o600 });
      const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).trim();
      demand(entries === 'receipt.json', 'Unexpected proof ZIP entries');
      // Read one bounded member to stdout; no artifact paths are extracted.
      const receipt = execFileSync('unzip', ['-p', path, 'receipt.json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
      return JSON.parse(receipt) as Receipt;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
