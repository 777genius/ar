import { isAbsolute, join, resolve } from 'node:path';
export const MANAGED_LAYOUT_ENV = 'SUBSCRIPTION_RUNTIME_MANAGED_LAYOUT';
export const MANAGED_MARKER_ENV = 'SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH';
export const MANAGED_JOB_LAYOUT_SCHEMA_VERSION = 1 as const;
export interface ManagedJobLayout {
  readonly storageRoot: string;
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
export function deriveManagedJobLayout(storageRoot: string, jobId: string): ManagedJobLayout {
  if (!isAbsolute(storageRoot) || storageRoot !== resolve(storageRoot) || storageRoot === '/') throw new Error('Invalid managed storageRoot');
  if (jobId !== jobId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId)) throw new Error('Invalid managed jobId');
  const jobRoot = join(storageRoot, 'jobs', jobId);
  return Object.freeze({ storageRoot, jobId, jobRoot,
    workspace: join(jobRoot, 'workspace'), state: join(jobRoot, 'state'), logs: join(jobRoot, 'logs'),
    payloadLogs: join(jobRoot, 'payload-logs'), output: join(jobRoot, 'output'),
    home: join(jobRoot, 'home'), tmp: join(jobRoot, 'tmp') });
}
/** Data validation only. The root-owned launcher is the filesystem authority. */
export function parseManagedJobLayout(text: string): ManagedJobLayout {
  if (Buffer.byteLength(text) > 16384) throw new Error('Invalid managed layout');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed layout');
  const fields = value as Record<string, unknown>;
  if (typeof fields.storageRoot !== 'string' || typeof fields.jobId !== 'string') throw new Error('Invalid managed layout');
  const layout = deriveManagedJobLayout(fields.storageRoot, fields.jobId);
  if (Object.keys(fields).length !== Object.keys(layout).length || Object.entries(layout).some(([key, expected]) => fields[key] !== expected)) throw new Error('Invalid managed layout');
  return layout;
}
