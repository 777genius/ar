import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { acquireLocalControllerActivityLease, releaseLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";

const fenceRetryMs = 250;
/** A durable recovery guard outlives the maintenance process. Both ingress and
 * owned execution take a lease and recheck it before any operation effect.
 * Only the lease acquisition may wait for a maintenance fence, and only when
 * the caller has already persisted an operation that must publish a result. */
export async function withHostedMimoWorkstreamActivity<T>(stateRoot: string, effect: () => Promise<T>,
  options: Readonly<{ fenceWaitMs: number }> = { fenceWaitMs: 0 }): Promise<T> {
  const open = () => { if (existsSync(join(stateRoot, ".controller-recovery.json"))) throw new Error("mimo_project_bridge_recovery_pending"); };
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
