import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { arch, release } from 'node:os';
import { delimiter, join } from 'node:path';
import { demand, ProofFamily, WORKFLOW_PATH, type Fingerprint, type Receipt } from './protocol.mts';
const command = (file: string, args: string[]): string => execFileSync(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }).trim();
export const git = (args: string[]): string => command('git', args);
function binaryHash(file: string): string {
  return createHash('sha256').update(readFileSync(realpathSync(file))).digest('hex');
}
function executable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, name);
    try { return realpathSync(path); } catch { /* next PATH entry */ }
  }
  throw new Error(`Missing tool: ${name}`);
}
export function fingerprint(withRestic: boolean, expectedProducer = false): Fingerprint {
  const runnerLabel = process.env.CI_PROOF_RUNNER_LABEL ?? '';
  const imageDigest = expectedProducer ? process.env.CI_PROOF_RUNNER_IMAGE_DIGEST ?? '' : process.env.CI_RUNNER_IMAGE_DIGEST ?? '';
  const configRevision = expectedProducer ? process.env.CI_PROOF_RUNNER_CONFIG_REV ?? '' : process.env.CI_RUNNER_CONFIG_REV ?? '';
  demand(/^[A-Za-z0-9._-]+$/.test(runnerLabel), 'Invalid runner label');
  // Unknown image/config means no reuse; capture still records the unknown
  // fields so PR tests remain usable if the deployment has not rolled out yet.
  return { runnerLabel, imageDigest, configRevision, os: process.platform,
    architecture: arch(), kernel: release(),
    osReleaseHash: createHash('sha256').update(readFileSync('/etc/os-release')).digest('hex'),
    nodeVersion: process.version, nodeBinaryHash: binaryHash(process.execPath),
    npmVersion: command('npm', ['--version']), gitVersion: command('git', ['--version']),
    resticVersion: withRestic ? command('restic', ['version']) : '',
    resticBinaryHash: withRestic ? binaryHash(executable('restic')) : '' };
}
export function capture(family: ProofFamily, lane: number): Receipt {
  const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  demand([repositoryId, runId, attempt].every(value => Number.isSafeInteger(value) && value > 0), 'Invalid GitHub identity');
  demand(Number.isInteger(lane) && (family === ProofFamily.Unit ? lane >= 1 && lane <= 4 : lane >= 0 && lane <= 7), 'Invalid lane');
  return { version: 1, repositoryId, repository: process.env.GITHUB_REPOSITORY ?? '', runId, attempt, family, lane,
    checkoutSha: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    workflowBlob: git(['rev-parse', `HEAD:${WORKFLOW_PATH}`]), lockBlob: git(['rev-parse', 'HEAD:package-lock.json']),
    fingerprint: fingerprint(family === ProofFamily.Unit) };
}
