import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLocalControllerMaintenanceFence,
  LocalTerminalCheckpointAdmission,
  withLocalControllerActivityLease,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  publishCodexGoalLedgerScopeUnderMaintenance,
  withCodexGoalRegistryMutation,
  codexGoalManifestRevision,
  withCodexGoalManifestUpdate,
} from "../codex-goal-job-manifest-revision";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "TEST-controller-manifest-revision-"));
  roots.push(root);
  const registryRootDir = join(root, "registry");
  const jobRootDir = join(root, "runtime-job");
  await mkdir(registryRootDir);
  await mkdir(jobRootDir);
  const manifestPath = join(registryRootDir, "job.json");
  await writeFile(manifestPath, JSON.stringify({ jobRootDir,
    workspacePath: "old", unknownRetainedField: true }));
  return { registryRootDir, jobRootDir, manifestPath };
}

describe("controller manifest revision serialization", () => {
  // RED: an authority-only existing-root lock recreates a lost registry and
  // runs its effect, permitting fallback publication on a replacement root.
  it("does not recreate a lost registry in the trusted existing-root mode", async () => {
    const input = await fixture();
    await rm(input.registryRootDir, { recursive: true });
    let invoked = false;
    await expect(withCodexGoalRegistryMutation({ registryRootDir: input.registryRootDir,
      requireExistingRegistryRoot: true, effect: async () => { invoked = true; },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(invoked).toBe(false);
    await expect(lstat(input.registryRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects exact byte revision drift before invoking a writer", async () => {
    const input = await fixture();
    const expectedManifestSha256 = await codexGoalManifestRevision(input.manifestPath);
    await writeFile(input.manifestPath, '{"newer":true}\n');
    let invoked = false;
    await expect(withCodexGoalManifestUpdate({ ...input, expectedManifestSha256,
      effect: async () => { invoked = true; },
    })).rejects.toThrow("job_manifest_revision_mismatch");
    expect(invoked).toBe(false);
    expect(await readFile(input.manifestPath, "utf8")).toBe('{"newer":true}\n');
  });

  it("rejects updates during exclusive controller maintenance", async () => {
    const input = await fixture();
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: input.jobRootDir, owner: "TEST-relocation",
    });
    try {
      await expect(withCodexGoalManifestUpdate({ ...input,
        effect: async () => { throw new Error("must not execute"); },
      })).rejects.toThrow("controller_maintenance_fence_active");
    } finally { await releaseLocalControllerMaintenanceFence(fence); }
  });

  it("normalizes a legacy manifest root exactly like the stored manifest parser", async () => {
    const input = await fixture();
    await writeFile(input.manifestPath, JSON.stringify({ jobRootDir: `  ${input.jobRootDir}  ` }));
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: input.jobRootDir, owner: "TEST-normalized-root",
    });
    try {
      await expect(withCodexGoalManifestUpdate({ ...input,
        effect: async () => { throw new Error("must not execute"); },
      })).rejects.toThrow("controller_maintenance_fence_active");
    } finally { await releaseLocalControllerMaintenanceFence(fence); }
  });

  it("allows a broker activity lease to enclose an update without a nested deadlock", async () => {
    const input = await fixture();
    await withLocalControllerActivityLease({
      controllerJobRootDir: input.jobRootDir, owner: "TEST-broker",
      effect: async () => {
        expect(await withCodexGoalManifestUpdate({ ...input,
          effect: async () => "updated",
        })).toBe("updated");
      },
    });
  });

  it("rejects a concurrent writer and maintenance while an update is in flight", async () => {
    const input = await fixture();
    await withCodexGoalManifestUpdate({ ...input, effect: async () => {
      await expect(withCodexGoalManifestUpdate({ ...input,
        effect: async () => { throw new Error("must not execute"); },
      })).rejects.toThrow();
      await expect(acquireLocalControllerMaintenanceFence({
        controllerJobRootDir: input.jobRootDir, owner: "TEST-relocation",
      })).rejects.toThrow("controller_maintenance_activity_active");
    } });
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: input.jobRootDir, owner: "TEST-after-update",
    });
    await releaseLocalControllerMaintenanceFence(fence);
  });
});


describe("already-fenced ledger scope publication", () => {
  it("requires owned exact-root fence and raw CAS, retains records and keeps ordinary updates fenced", async () => {
    const input = await fixture();
    const original = { jobId: "TEST-controller", jobRootDir: input.jobRootDir,
      accessBoundary: "project_scoped_control", unknownRetainedField: { audit: "retained" },
      projectAccessScope: { consumedOutputLedgerRoots: ["old"], allowedGitRemotes: [] } };
    await writeFile(input.manifestPath, JSON.stringify(original));
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: input.jobRootDir, owner: "TEST-ledger",
    });
    const other = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: join(input.jobRootDir, "other"), owner: "TEST-other",
    });
    const publication = { ...input, fence, controllerJobId: original.jobId,
      expectedManifestSha256: await codexGoalManifestRevision(input.manifestPath),
      consumedOutputLedgerRoot: "new" };
    try {
      for (const badFence of [other, { ...fence, ownerToken: "wrong" }]) {
        await expect(publishCodexGoalLedgerScopeUnderMaintenance({ ...publication,
          fence: badFence })).rejects.toThrow("controller_maintenance_fence_owner_mismatch");
      }
      await expect(publishCodexGoalLedgerScopeUnderMaintenance({ ...publication,
        expectedManifestSha256: "drift" })).rejects.toThrow("job_manifest_revision_mismatch");
      await withCodexGoalRegistryMutation({ ...input, effect: async () => {
        await expect(publishCodexGoalLedgerScopeUnderMaintenance(publication)).rejects.toThrow();
      } });
      expect(JSON.parse(await readFile(input.manifestPath, "utf8"))).toEqual(original);
      await publishCodexGoalLedgerScopeUnderMaintenance(publication);
      const updated = JSON.parse(await readFile(input.manifestPath, "utf8"));
      expect(updated).toEqual({ ...original, updatedAt: expect.any(String),
        projectAccessScope: { ...original.projectAccessScope, consumedOutputLedgerRoots: ["new"] } });
      await expect(withCodexGoalManifestUpdate({ ...input,
        effect: async () => { throw new Error("must not execute"); },
      })).rejects.toThrow("controller_maintenance_fence_active");
      await expect(publishCodexGoalLedgerScopeUnderMaintenance(publication))
        .rejects.toThrow("job_manifest_revision_mismatch");
    } finally {
      await releaseLocalControllerMaintenanceFence(other);
      await releaseLocalControllerMaintenanceFence(fence);
    }
    await expect(publishCodexGoalLedgerScopeUnderMaintenance({ ...publication,
      expectedManifestSha256: await codexGoalManifestRevision(input.manifestPath),
    })).rejects.toThrow();
  });

  it("keeps ledger publication behind the job claim while maintenance is owned", async () => {
    const input = await fixture();
    const original = { jobId: "test-controller", jobRootDir: input.jobRootDir,
      accessBoundary: "project_scoped_control", projectAccessScope: { consumedOutputLedgerRoots: [] } };
    await writeFile(input.manifestPath, JSON.stringify(original));
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: input.jobRootDir, owner: "TEST-ledger",
    });
    const admission = new LocalTerminalCheckpointAdmission(input.jobRootDir);
    const claim = await admission.claim("test-ledger-checkpoint", {
      projectId: "test-project", workstreamId: "test-workstream", jobId: "test-controller",
      taskId: "test-task", executionGeneration: "test-generation", attemptNumber: 1,
      ownershipEpoch: 1, runtimeSha: "a".repeat(40), registryRevisionSha256: "b".repeat(64),
    });
    try {
      await expect(publishCodexGoalLedgerScopeUnderMaintenance({ ...input, fence,
        controllerJobId: original.jobId,
        expectedManifestSha256: await codexGoalManifestRevision(input.manifestPath),
        consumedOutputLedgerRoot: "new",
      })).rejects.toThrow("terminal_checkpoint_job_fenced");
      expect(JSON.parse(await readFile(input.manifestPath, "utf8"))).toEqual(original);
    } finally {
      await admission.release(claim, false);
      await releaseLocalControllerMaintenanceFence(fence);
    }
  });
});
