import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { acquireLocalControllerActivityLease, releaseLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";
import { assertNoWorkstreamRetirement } from "./job-retirement/job-retirement-records";

const fenceRetryMs = 250;
/** Why ingress refuses a workstream before any operation; the read-only form of the checks below. */
export enum HostedMimoWorkstreamClosure { RecoveryPending = "recovery_pending", RetirementPending = "retirement_pending", MaintenanceFence = "maintenance_fence_active" }
export const hostedMimoWorkstreamRecoveryPath = (stateRoot: string): string => join(stateRoot, ".controller-recovery.json");
export const hostedMimoWorkstreamFencePath = (stateRoot: string): string => join(stateRoot, ".controller-maintenance-fence.json");
/** Read-only: the first condition that makes the bridge refuse this workstream, if any. A maintenance fence is
 * transient and ingress may wait for it, so it is reported separately and last. */
export function observeHostedMimoWorkstreamClosure(stateRoot: string): HostedMimoWorkstreamClosure | undefined {
  if (existsSync(hostedMimoWorkstreamRecoveryPath(stateRoot))) return HostedMimoWorkstreamClosure.RecoveryPending;
  try { assertNoWorkstreamRetirement(stateRoot, HostedMimoWorkstreamClosure.RetirementPending); }
  catch (error) { if ((error as Error).message === HostedMimoWorkstreamClosure.RetirementPending) return HostedMimoWorkstreamClosure.RetirementPending; throw error; }
  return existsSync(hostedMimoWorkstreamFencePath(stateRoot)) ? HostedMimoWorkstreamClosure.MaintenanceFence : undefined;
}
/** A durable recovery or retirement guard outlives the maintenance process. Both ingress and
 * owned execution take a lease and recheck it before any operation effect.
 * Only the lease acquisition may wait for a maintenance fence, and only when
 * the caller has already persisted an operation that must publish a result. */
export async function withHostedMimoWorkstreamActivity<T>(stateRoot: string, effect: () => Promise<T>,
  options: Readonly<{ fenceWaitMs: number }> = { fenceWaitMs: 0 }): Promise<T> {
  const open = () => {
    if (existsSync(hostedMimoWorkstreamRecoveryPath(stateRoot))) throw new Error("mimo_project_bridge_recovery_pending");
    assertNoWorkstreamRetirement(stateRoot, "mimo_project_bridge_retirement_pending");
  };
  open();
  const identity = lstatSync(stateRoot);
  const deadline = Date.now() + options.fenceWaitMs;
  let lease: Awaited<ReturnType<typeof acquireLocalControllerActivityLease>>;
  for (;;) {
    try { lease = await acquireLocalControllerActivityLease({ controllerJobRootDir: stateRoot, owner: "mimo-project-bridge" }); break; }
    catch (error) {
      if ((error as Error).message !== "controller_maintenance_fence_active" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, fenceRetryMs));
    }
  }
  try {
    const current = lstatSync(stateRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error("mimo_project_bridge_recovery_pending");
    open(); return await effect();
  } finally { await releaseLocalControllerActivityLease(lease); }
}
