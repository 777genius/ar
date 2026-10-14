import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { withLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";

/** A durable recovery guard outlives the maintenance process. Both ingress and
 * owned execution take a lease and recheck it before any operation effect. */
export async function withHostedMimoWorkstreamActivity<T>(stateRoot: string, effect: () => Promise<T>): Promise<T> {
  const open = () => { if (existsSync(join(stateRoot, ".controller-recovery.json"))) throw new Error("mimo_project_bridge_recovery_pending"); };
  open();
  const identity = lstatSync(stateRoot);
  return withLocalControllerActivityLease({ controllerJobRootDir: stateRoot, owner: "mimo-project-bridge", effect: async () => {
    const current = lstatSync(stateRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error("mimo_project_bridge_recovery_pending");
    open(); return effect();
  } });
}
