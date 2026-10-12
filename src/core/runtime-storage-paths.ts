import { isAbsolute, join, parse, resolve } from 'node:path';

export interface RuntimeStorageRoots {
  readonly rootDir: string;
  readonly jobsRootDir: string;
  readonly stateRootDir: string;
  readonly tmpRootDir: string;
}

export interface RuntimeJobLayout {
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

function validateRoot(rootDir: string, name: string): void {
  if (typeof rootDir !== 'string' || rootDir.includes('\0') || !isAbsolute(rootDir)
    || rootDir !== resolve(rootDir) || rootDir === parse(rootDir).root) {
    throw new Error(`Invalid runtime ${name}`);
  }
}

/** Convenience paths only. Does not establish storage or filesystem authority. */
export function deriveRuntimeStorageRoots(storageRootDir: string): RuntimeStorageRoots {
  validateRoot(storageRootDir, 'storageRootDir');
  return Object.freeze({
    rootDir: storageRootDir,
    jobsRootDir: join(storageRootDir, 'jobs'),
    stateRootDir: join(storageRootDir, 'state'),
    tmpRootDir: join(storageRootDir, 'tmp'),
  });
}

/** Takes an already selected job root, without appending or inferring a job id. */
export function deriveRuntimeJobLayout(jobRootDir: string, jobId: string): RuntimeJobLayout {
  validateRoot(jobRootDir, 'jobRoot');
  if (typeof jobId !== 'string' || jobId !== jobId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId)) {
    throw new Error('Invalid runtime jobId');
  }
  return Object.freeze({
    jobId,
    jobRoot: jobRootDir,
    workspace: join(jobRootDir, 'workspace'),
    state: join(jobRootDir, 'state'),
    logs: join(jobRootDir, 'logs'),
    payloadLogs: join(jobRootDir, 'payload-logs'),
    output: join(jobRootDir, 'output'),
    home: join(jobRootDir, 'home'),
    tmp: join(jobRootDir, 'tmp'),
  });
}
