import { isAbsolute, join, resolve } from 'node:path';
export const MANAGED_MARKER_ENV = 'SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH';
export const MANAGED_JOB_ROOT_ENV = 'SUBSCRIPTION_RUNTIME_JOB_ROOT';
export const MANAGED_JOB_ID_ENV = 'SUBSCRIPTION_RUNTIME_JOB_ID';
export interface ManagedJobLayout {
  readonly jobId: string;
  readonly jobRoot: string;
  readonly workspace: string;
  readonly state: string;
  readonly logs: string;
  readonly payloadLogs: string;
  readonly output: string;
  readonly home: string;
  readonly tmp: string;
}
/** Convenience paths only. The launcher owns the filesystem security boundary. */
export function deriveManagedJobLayout(jobRoot: string, jobId: string): ManagedJobLayout {
  if (!isAbsolute(jobRoot) || jobRoot !== resolve(jobRoot) || jobRoot === '/') throw new Error('Invalid managed jobRoot');
  if (jobId !== jobId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId)) throw new Error('Invalid managed jobId');
  return Object.freeze({ jobId, jobRoot,
    workspace: join(jobRoot, 'workspace'), state: join(jobRoot, 'state'), logs: join(jobRoot, 'logs'),
    payloadLogs: join(jobRoot, 'payload-logs'), output: join(jobRoot, 'output'),
    home: join(jobRoot, 'home'), tmp: join(jobRoot, 'tmp') });
}
