import { controllerHistoricalAttestationSchema } from "./application/project-control/codex-goal-controller-historical-attestation";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  acquireLocalControllerMaintenanceFence,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  AccessBoundary,
  createAccessPolicyService,
  type ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobManifestPath, readCodexGoalJob, type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import { codexGoalManifestRevision, withCodexGoalRegistryMutation } from
  "./codex-goal-job-manifest-revision";
import { controllerScopeLockIdentity } from "./codex-goal-mcp-project-control-ledger-epoch";
import { projectControlCanonicalWorkspacePath } from
  "./application/project-control/codex-goal-project-workspace-scope";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from
  "./codex-goal-project-workspace-lock";
import { durableReplaceJsonFile } from "./project-control-operation-file-store";
import { defaultProjectControlGitPort, type ProjectControlGitPort } from
  "./application/project-control/adapters/host-command-adapters";
import { assertControllerRelocationIdle } from
  "./application/project-control/codex-goal-controller-relocation-idle";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type { CodexGoalMcpProjectControlAdminDeps } from "./codex-goal-mcp-project-control-admin";
import { requiredRawString } from "./codex-goal-mcp-values";

type JsonObject = Readonly<Record<string, unknown>>;
export enum ControllerRelocationAuditPhase {
  Prepared = "prepared",
  Applied = "applied",
  HistoricalAttestation = "historical-attestation",
}
export type ControllerRelocationDeps = Pick<CodexGoalMcpProjectControlAdminDeps,
  "loadProjectControlController" | "evidenceCustody"> & {
  readonly assertNoHostedControllers: () => void;
  readonly git?: ProjectControlGitPort;
  readonly assertIdle?: typeof assertControllerRelocationIdle;
};

/** Host admin operation; deliberately absent from the controlled agent tool surface. */
export async function projectControlRelocateControllerWorkspaceView(
  args: ProjectControlMcpArgs,
  deps: ControllerRelocationDeps,
): Promise<JsonObject> {
  const attestation = args.historicalNeverRunAttestation === undefined ? undefined :
    controllerHistoricalAttestationSchema.parse(args.historicalNeverRunAttestation);
  if (attestation && args.confirmRelocate !== true) {
    throw new Error("controller_relocation_attestation_confirmation_required");
  }
  const loaded = await deps.loadProjectControlController(args);
  const { controller, scope } = loaded;
  if (controller.accessBoundary !== AccessBoundary.ProjectScopedControl) {
    throw new Error("controller_relocation_controller_required");
  }
  const registryRootDir = await realpath(loaded.registryRootDir);
  const manifestPath = codexGoalJobManifestPath({ registryRootDir, jobId: controller.jobId });
  const requested = requiredRawString(args.workspacePath, "workspacePath");
  if (![controller.jobRootDir, controller.workspacePath, requested].every(isAbsolute)) {
    throw new Error("controller_relocation_absolute_paths_required");
  }
  const beforeRevision = await codexGoalManifestRevision(manifestPath);
  if (JSON.stringify(await readCodexGoalJob({ registryRootDir, jobId: controller.jobId })) !==
    JSON.stringify(controller)) throw new Error("controller_relocation_manifest_cas_mismatch");
  if (args.confirmRelocate === true &&
    (requiredRawString(args.expectedManifestSha256, "expectedManifestSha256") !== beforeRevision ||
      requiredRawString(args.expectedWorkspacePath, "expectedWorkspacePath") !== controller.workspacePath)) {
    throw new Error("controller_relocation_manifest_cas_mismatch");
  }
  const oldPath = await projectControlCanonicalWorkspacePath(controller.workspacePath, scope);
  const newPath = await projectControlCanonicalWorkspacePath(requested, scope);
  if (oldPath === newPath) throw new Error("controller_relocation_different_workspace_required");
  const locks = projectControlWorkspaceLocks(registryRootDir);
  const controllerLock = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(registryRootDir, controller.jobId),
    owner: `controller-relocation:${controller.jobId}`,
  });
  try {
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: controller.jobRootDir, owner: `controller-relocation:${controller.jobId}`,
    });
    try {
      const maintenanceFenceAcquiredAt = new Date().toISOString();
      const paths = [oldPath, newPath].sort();
      const withWorkspace = async (index: number): Promise<JsonObject> => {
        const path = paths[index];
        if (path !== undefined) return await withValidatedProjectWorkspaceLock({
          locks, scope, requestedWorkspacePath: path,
          expectedCanonicalWorkspacePath: path,
          owner: `controller-relocation:${controller.jobId}`,
          effect: async () => await withWorkspace(index + 1),
        });
        return await withCodexGoalRegistryMutation({ registryRootDir, effect: async () => {
          const revalidate = async () => {
            if (attestation) {
              const expected = {
                controllerJobId: controller.jobId, controllerCreatedAt: controller.createdAt,
                manifestSha256: beforeRevision, scopeSha256: sha(JSON.stringify(scope)),
                registryRootDir, jobRootDir: await realpath(controller.jobRootDir),
                sourceWorkspacePath: oldPath, destinationWorkspacePath: newPath,
              };
              if (Object.entries(expected).some(([key, value]) => attestation[key as keyof typeof attestation] !== value) ||
                Date.parse(attestation.assertedAt) < Date.parse(controller.createdAt) ||
                Date.parse(attestation.assertedAt) > Date.parse(maintenanceFenceAcquiredAt)) {
                throw new Error("controller_relocation_attestation_identity_mismatch");
              }
            }
            if (await codexGoalManifestRevision(manifestPath) !== beforeRevision ||
              await projectControlCanonicalWorkspacePath(controller.workspacePath, scope) !== oldPath ||
              await projectControlCanonicalWorkspacePath(requested, scope) !== newPath) {
              throw new Error("controller_relocation_manifest_cas_mismatch");
            }
            deps.assertNoHostedControllers();
            await assertCleanDestination(newPath, scope, deps.git ?? defaultProjectControlGitPort, [
              registryRootDir, controller.jobRootDir,
              ...controller.authRootDir ? [controller.authRootDir] : [],
              ...controller.stateRootDir ? [controller.stateRootDir] : [],
            ]);
            const manifests = await readRelocationRegistry(registryRootDir);
            for (const manifest of manifests) {
              if (await realpath(manifest.workspacePath).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              }) === newPath) throw new Error("controller_relocation_destination_collision");
            }
            await (deps.assertIdle ?? assertControllerRelocationIdle)({
              controller, registryRootDir, workspacePaths: [oldPath, newPath], manifests,
              ...(attestation ? { attestedNeverRunControllerJobId: controller.jobId } : {}),
            });
            if (await codexGoalManifestRevision(manifestPath) !== beforeRevision ||
              await projectControlCanonicalWorkspacePath(controller.workspacePath, scope) !== oldPath ||
              await projectControlCanonicalWorkspacePath(requested, scope) !== newPath) {
              throw new Error("controller_relocation_manifest_cas_mismatch");
            }
          };
          await revalidate();
          const plan = {
            controllerJobId: controller.jobId, taskId: controller.taskId,
            projectId: scope.projectId, registryRootDir,
            oldWorkspacePath: controller.workspacePath, oldCanonicalWorkspacePath: oldPath,
            workspacePath: newPath, expectedManifestSha256: beforeRevision,
            scopeSha256: sha(JSON.stringify(scope)),
          };
          if (args.confirmRelocate !== true) return {
            ok: false, reason: "confirm_relocate_required", plan,
          };
          const custody = deps.evidenceCustody;
          if (!custody) throw new Error("controller_relocation_audit_custody_required");
          const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("controller_relocation_invalid_manifest");
          }
          const after = { ...raw, workspacePath: newPath, updatedAt: new Date().toISOString() };
          const afterRevision = sha(`${JSON.stringify(after, null, 2)}\n`);
          const audit = { schemaVersion: 1, operationId: randomUUID(), ...plan,
            before: { jobId: controller.jobId, taskId: controller.taskId,
              workspacePath: controller.workspacePath, manifestSha256: beforeRevision },
            after: { jobId: controller.jobId, taskId: controller.taskId,
              workspacePath: newPath, manifestSha256: afterRevision },
          };
          if (attestation) {
            await publishAudit(custody, controller.jobRootDir,
              { ...audit, attestation, maintenanceFenceAcquiredAt }, ControllerRelocationAuditPhase.HistoricalAttestation);
          }
          const preparedAuditPath = await publishAudit(custody, controller.jobRootDir,
            audit, ControllerRelocationAuditPhase.Prepared);
          // Audit I/O is an await boundary: repeat all volatile safety evidence.
          await revalidate();
          await durableReplaceJsonFile({ path: manifestPath, value: after });
          try {
            const appliedAuditPath = await publishAudit(custody, controller.jobRootDir,
              audit, ControllerRelocationAuditPhase.Applied);
            return { ok: true, applied: true, plan, manifestSha256: afterRevision,
              preparedAuditPath, appliedAuditPath };
          } catch {
            // The durable prepared receipt already binds both exact revisions.
            // Never disguise a committed relocation as an unapplied retry.
            return { ok: false, applied: true, reason: "controller_relocation_applied_audit_pending",
              plan, manifestSha256: afterRevision, preparedAuditPath };
          }
        } });
      };
      return await withWorkspace(0);
    } finally { await releaseLocalControllerMaintenanceFence(fence); }
  } finally { await locks.release(controllerLock); }
}

async function readRelocationRegistry(registryRootDir: string): Promise<CodexGoalJobManifest[]> {
  const result: CodexGoalJobManifest[] = [];
  for (const entry of await readdir(registryRootDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) throw new Error("controller_relocation_registry_entry_unknown");
    // Unlike listJobs, malformed or unreadable registrations must fail closed.
    const manifest = await readCodexGoalJob({ registryRootDir, jobId: entry.name });
    if (!isAbsolute(manifest.workspacePath) || !isAbsolute(manifest.jobRootDir)) {
      throw new Error("controller_relocation_registry_identity_unknown");
    }
    result.push(manifest);
  }
  return result;
}

async function assertCleanDestination(
  path: string,
  scope: Awaited<ReturnType<ControllerRelocationDeps["loadProjectControlController"]>>["scope"],
  git: ProjectControlGitPort,
  protectedRoots: readonly string[],
): Promise<void> {
  const policy = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope });
  if (!policy.canWritePath({ path, realPath: path }).allowed) {
    throw new Error("controller_relocation_destination_denied");
  }
  for (const denied of [...protectedRoots, ...scope.deniedRoots ?? [], ...scope.authRoot ? [scope.authRoot] : [],
    ...scope.registryRoot ? [scope.registryRoot] : []]) {
    const canonical = await realpath(denied).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return resolve(denied);
      throw error;
    });
    if (path === canonical || path.startsWith(`${canonical}/`)) {
      throw new Error("controller_relocation_destination_denied");
    }
  }
  if (!(await lstat(path)).isDirectory()) throw new Error("controller_relocation_destination_not_directory");
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const run = async (args: readonly string[]) => (await git.run({
    cwd: path, args: ["-c", "core.fsmonitor=false", ...args],
    timeoutMs: 10_000, maxBuffer: 1024 * 1024,
    env: { ...gitEnv, GIT_OPTIONAL_LOCKS: "0" },
  })).stdout.trim();
  if (await realpath(await run(["rev-parse", "--show-toplevel"])) !== path ||
    await run(["rev-parse", "--is-bare-repository"]) !== "false") {
    throw new Error("controller_relocation_git_root_required");
  }
  await run(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (await run(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]) !== "") {
    throw new Error("controller_relocation_destination_dirty");
  }
}

async function publishAudit(custody: ProjectControlEvidenceCustodyPort, root: string,
  audit: JsonObject & { readonly operationId: string }, phase: ControllerRelocationAuditPhase) {
  const body = `${JSON.stringify({ ...audit, phase, occurredAt: new Date().toISOString() }, null, 2)}\n`;
  return (await custody.publishImmutableBytes({ root,
    directories: ["controller-workspace-relocations", audit.operationId],
    fileName: `${phase}.json`, bytes: Buffer.from(body), expectedSha256: sha(body),
  })).path;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
