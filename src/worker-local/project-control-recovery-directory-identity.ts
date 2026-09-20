import type { ProjectControlRecoveryDirectoryIdentity, ProjectControlRecoveryDirectories } from "@vioxen/subscription-runtime/worker-core";
import { openAbsoluteDirectoryNoSymlinks, projectControlCustodyMaterializationPaths } from "./project-control-evidence-custody-materialization";

export async function recoveryDirectoryIdentities(
  paths: readonly string[],
): Promise<readonly ProjectControlRecoveryDirectoryIdentity[]> {
  const identities: ProjectControlRecoveryDirectoryIdentity[] = [];
  for (const path of new Set(paths)) {
    const handle = await openAbsoluteDirectoryNoSymlinks(path);
    try {
      const stat = await handle.stat();
      identities.push({ path, device: stat.dev, inode: stat.ino });
    } finally { await handle.close(); }
  }
  return identities;
}

export async function revalidateRecoveryDirectoryIdentities(
  expected: readonly ProjectControlRecoveryDirectoryIdentity[],
): Promise<void> {
  for (const identity of expected) {
    const [current] = await recoveryDirectoryIdentities([identity.path]);
    if (!current || current.device !== identity.device || current.inode !== identity.inode) {
      throw new Error("project_control_recovery_directory_identity_drift");
    }
  }
}

export const localProjectControlRecoveryDirectories: ProjectControlRecoveryDirectories = {
  paths: projectControlCustodyMaterializationPaths,
  identities: recoveryDirectoryIdentities,
  revalidate: revalidateRecoveryDirectoryIdentities,
};
