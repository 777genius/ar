import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";
import type { LocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { durableReplaceJsonFile } from "./project-control-operation-file-store";
import { projectControlWorkspaceLocks } from "./codex-goal-project-workspace-lock";

/** Fingerprint persisted bytes, including fields unknown to this version. */
export async function codexGoalManifestRevision(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Serializes registry publication and relocation collision checks together. */
export async function withCodexGoalRegistryMutation<T>(input: {
  readonly registryRootDir: string;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  await mkdir(input.registryRootDir, { recursive: true, mode: 0o700 });
  const registryRootDir = await realpath(input.registryRootDir);
  const locks = projectControlWorkspaceLocks(registryRootDir);
  const lease = await locks.acquire({
    workspacePath: join(registryRootDir, ".manifest-mutation"),
    owner: "job-registry-mutation",
  });
  try {
    return await input.effect();
  } finally {
    await locks.release(lease);
  }
}

export async function withCodexGoalManifestUpdate<T>(input: {
  readonly registryRootDir: string;
  readonly manifestPath: string;
  readonly expectedManifestSha256?: string;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  return await withCodexGoalRegistryMutation({
    registryRootDir: input.registryRootDir,
    effect: async () => {
      if (input.expectedManifestSha256 !== undefined &&
        await codexGoalManifestRevision(input.manifestPath) !== input.expectedManifestSha256) {
        throw new Error("job_manifest_revision_mismatch");
      }
      // Resolve the activity identity from the persisted manifest while holding
      // the registry mutex. Registry directories and runtime job roots differ.
      const manifest: unknown = JSON.parse(await readFile(input.manifestPath, "utf8"));
      if (!manifest || typeof manifest !== "object" ||
        !("jobRootDir" in manifest) || typeof manifest.jobRootDir !== "string" ||
        manifest.jobRootDir.trim().length === 0) {
        throw new Error("job_manifest_activity_identity_invalid");
      }
      // Activity leases are shared and can nest inside a broker activity lease.
      // Relocation owns the exclusive maintenance fence and publishes directly
      // under the registry mutex; it must not call this activity-taking helper.
      return await withLocalControllerActivityLease({
        controllerJobRootDir: manifest.jobRootDir.trim(),
        owner: "job-manifest-update",
        effect: input.effect,
      });
    },
  });
}

/** Ledger migration already owns exclusive maintenance; never release it to publish. */
export async function publishCodexGoalLedgerScopeUnderMaintenance(input: {
  readonly registryRootDir: string;
  readonly manifestPath: string;
  readonly expectedManifestSha256: string;
  readonly controllerJobId: string;
  readonly fence: LocalControllerMaintenanceFence;
  readonly consumedOutputLedgerRoot: string;
}): Promise<void> {
  await withCodexGoalRegistryMutation({
    registryRootDir: input.registryRootDir,
    effect: async () => {
      if (await codexGoalManifestRevision(input.manifestPath) !== input.expectedManifestSha256) {
        throw new Error("job_manifest_revision_mismatch");
      }
      const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
      if (manifest.accessBoundary !== AccessBoundary.ProjectScopedControl ||
        !manifest.projectAccessScope ||
        manifest.jobId !== input.controllerJobId ||
        typeof manifest.jobRootDir !== "string" || !manifest.jobRootDir.trim()) {
        throw new Error("job_manifest_activity_identity_invalid");
      }
      const expectedFencePath = join(resolve(manifest.jobRootDir.trim()),
        ".controller-maintenance-fence.json");
      if (await realpath(input.fence.path) !== await realpath(expectedFencePath)) {
        throw new Error("controller_maintenance_fence_owner_mismatch");
      }
      const owner = JSON.parse(await readFile(expectedFencePath, "utf8"));
      if (!input.fence.ownerToken || owner.ownerToken !== input.fence.ownerToken ||
        owner.pid !== process.pid) {
        throw new Error("controller_maintenance_fence_owner_mismatch");
      }
      await durableReplaceJsonFile({ path: input.manifestPath, value: {
        ...manifest, projectAccessScope: { ...manifest.projectAccessScope,
          consumedOutputLedgerRoots: [input.consumedOutputLedgerRoot] },
        updatedAt: new Date().toISOString(),
      } });
    },
  });
}
