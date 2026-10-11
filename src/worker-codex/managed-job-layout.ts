import { deriveRuntimeJobLayout, type RuntimeJobLayout } from '../core/runtime-storage-paths';
export const MANAGED_MARKER_ENV = 'SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH';
export const MANAGED_JOB_ROOT_ENV = 'SUBSCRIPTION_RUNTIME_JOB_ROOT';
export const MANAGED_JOB_ID_ENV = 'SUBSCRIPTION_RUNTIME_JOB_ID';
export type ManagedJobLayout = RuntimeJobLayout;
/** Convenience paths only. The launcher owns the filesystem security boundary. */
export function deriveManagedJobLayout(jobRoot: string, jobId: string): ManagedJobLayout {
  try {
    return deriveRuntimeJobLayout(jobRoot, jobId);
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid runtime jobRoot') throw new Error('Invalid managed jobRoot');
    if (error instanceof Error && error.message === 'Invalid runtime jobId') throw new Error('Invalid managed jobId');
    throw error;
  }
}
