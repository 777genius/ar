import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobManifestPath,
  codexGoalJobToArgs,
  codexGoalJobManifestSchemaVersion,
  createCodexGoalJob,
  listCodexGoalJobs,
  readCodexGoalJob,
  summarizeCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifestInput,
} from "../codex-goal-jobs";
import { upsertCodexGoalLaunchManifest } from "../codex-goal-launch-manifest";
import { loadProjectControlController } from
  "../codex-goal-mcp-project-control-deps";
import {
  localProjectControlEvidenceCustodySupported,
  LocalProjectControlEvidenceCustody,
} from
  "../../worker-local/project-control-evidence-custody-local-adapter";

describe("codex goal job registry", () => {
  it("creates, lists, reads, updates and summarizes versioned job manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));
    const registryRootDir = join(root, "registry");
    const manifestInput = jobManifest(root);

    try {
      const created = await createCodexGoalJob({
        registryRootDir,
        manifest: manifestInput,
        now: new Date("2026-06-01T00:00:00.000Z"),
      });
      const manifestPath = codexGoalJobManifestPath({
        registryRootDir,
        jobId: manifestInput.jobId,
      });

      expect(created).toMatchObject({
        schemaVersion: codexGoalJobManifestSchemaVersion,
        jobId: "job-a",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      expect(summarizeCodexGoalJob(created, registryRootDir)).toMatchObject({
        jobId: "job-a",
        manifestPath,
        accountNames: ["account-a", "account-b"],
      });

      const listed = await listCodexGoalJobs({ registryRootDir });
      expect(listed.map((job) => job.jobId)).toEqual(["job-a"]);
      await expect(readCodexGoalJob({
        registryRootDir,
        jobId: "job-a",
      })).resolves.toEqual(created);

      const updated = await updateCodexGoalJob({
        registryRootDir,
        jobId: "job-a",
        patch: {
          description: "updated",
          tags: ["cat1", "recall"],
          taskTimeoutMs: 42_000,
        },
        now: new Date("2026-06-01T00:10:00.000Z"),
      });

      expect(updated.description).toBe("updated");
      expect(updated.tags).toEqual(["cat1", "recall"]);
      expect(updated.taskTimeoutMs).toBe(42_000);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBe("2026-06-01T00:10:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts a manifest to launch-compatible args without schema metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      const manifest = await createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: jobManifest(root),
      });
      const args = codexGoalJobToArgs(manifest);

      expect(args).toMatchObject({
        jobRootDir: manifest.jobRootDir,
        authRootDir: manifest.authRootDir,
        workspacePath: manifest.workspacePath,
        promptPath: manifest.promptPath,
        codexGoalObjective: "Short objective with docs links.",
        taskId: "task-a",
        accounts: ["account-a", "account-b"],
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
        workerReportMode: "structured-output",
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspace")],
          jobIdPrefixes: ["infinity-context-"],
        },
        networkAccess: NetworkAccessMode.Restricted,
      });
      expect(args).not.toHaveProperty("schemaVersion");
      expect(args).not.toHaveProperty("createdAt");
      expect(args).not.toHaveProperty("updatedAt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe job ids and empty account lists", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          jobId: "../bad",
        },
      })).rejects.toThrow("codex_goal_job_id_invalid");

      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          accounts: [],
        },
      })).rejects.toThrow("codex_goal_job_accounts_required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects legacy builtin launch discriminator fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          projectPreStartAdmission: {
            schemaVersion: 1,
            mode: "serial-builtin",
            contractSchema: "worker-start-v1",
            contractPath: join(root, "contract.json"),
            statePath: join(root, "state.json"),
            receiptPath: join(root, "receipt.json"),
          },
        } as unknown as CodexGoalJobManifestInput,
      })).rejects.toThrow(
        "codex_goal_job_projectPreStartAdmission_unexpected_field:contractSchema",
      );

      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          projectAccessScope: {
            ...jobManifest(root).projectAccessScope,
            preStartAdmission: {
              required: true,
              mode: "serial-builtin",
              contractSchema: "worker-start-v1",
            },
          },
        } as unknown as CodexGoalJobManifestInput,
      })).rejects.toThrow(
        "projectAccessScope.preStartAdmission.unexpected_field:contractSchema",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the legacy builtin discriminator when reading stored jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));
    const registryRootDir = join(root, "registry");
    try {
      const created = await createCodexGoalJob({
        registryRootDir,
        manifest: {
          ...jobManifest(root),
          projectPreStartAdmission: {
            schemaVersion: 1,
            mode: "serial-builtin",
            contractPath: join(root, "contract.json"),
            statePath: join(root, "state.json"),
            receiptPath: join(root, "receipt.json"),
          },
        },
      });
      const path = codexGoalJobManifestPath({
        registryRootDir,
        jobId: created.jobId,
      });
      const stored = JSON.parse(await readFile(path, "utf8")) as
        Record<string, unknown>;
      stored.projectPreStartAdmission = {
        ...(stored.projectPreStartAdmission as Record<string, unknown>),
        contractSchema: "worker-start-v1",
      };
      stored.projectAccessScope = {
        ...(stored.projectAccessScope as Record<string, unknown>),
        preStartAdmission: {
          required: true,
          mode: "serial-builtin",
          contractSchema: "worker-start-v1",
        },
      };
      await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);

      const read = await readCodexGoalJob({
        registryRootDir,
        jobId: created.jobId,
      });
      expect(read.projectPreStartAdmission).toEqual({
        schemaVersion: 1,
        mode: "serial-builtin",
        contractPath: join(root, "contract.json"),
        statePath: join(root, "state.json"),
        receiptPath: join(root, "receipt.json"),
      });
      expect(read.projectAccessScope?.preStartAdmission).toEqual({
        required: true,
        mode: "serial-builtin",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported codex goal control mode combinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      const { editMode: _editMode, ...legacyManifest } = jobManifest(root);
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...legacyManifest,
          permissionMode: "danger-full-access" as never,
        } as unknown as CodexGoalJobManifestInput,
      })).rejects.toThrow(/Use providerSandboxMode/);

      const created = await createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: jobManifest(root),
      });
      await expect(updateCodexGoalJob({
        registryRootDir: join(root, "registry"),
        jobId: created.jobId,
        patch: {
          editMode: "read-only",
          providerSandboxMode: "danger-full-access",
        },
      })).rejects.toThrow(/requires editMode "allow-edits"/);

      const {
        accessBoundary: _accessBoundary,
        projectAccessScope: _projectAccessScope,
        ...manifestWithoutAccessBoundary
      } = jobManifest(root);
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...manifestWithoutAccessBoundary,
          jobId: "job-raw-danger",
          providerSandboxMode: "danger-full-access",
        },
      })).rejects.toThrow(/codex_goal_danger_full_access_requires_access_boundary/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects access-boundary manifests that cannot be enforced", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      const { projectAccessScope: _scope, ...manifestWithoutScope } =
        jobManifest(root);
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: manifestWithoutScope,
      })).rejects.toThrow(/codex_goal_access_boundary_blocked:missing_project_scope/);

      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          jobId: "job-danger",
          accessBoundary: AccessBoundary.DangerFullAccess,
          allowDangerFullAccess: false,
        },
      })).rejects.toThrow(/codex_goal_access_boundary_blocked/);

      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          jobId: "job-outside-workspace",
          workspacePath: join(root, "other-project"),
        },
      })).rejects.toThrow(/codex_goal_job_workspacePath_denied:path_outside_scope/);

      const outsideWorkspace = join(root, "outside-workspace");
      const workspaceLink = join(root, "workspace-link");
      await mkdir(outsideWorkspace, { recursive: true });
      await symlink(outsideWorkspace, workspaceLink, "dir");
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          jobId: "job-symlink-workspace",
          workspacePath: workspaceLink,
          projectAccessScope: {
            projectId: "infinity-context",
            workspaceRoots: [workspaceLink],
            jobIdPrefixes: ["infinity-context-"],
          },
        },
      })).rejects.toThrow(/codex_goal_job_workspacePath_denied:path_outside_scope/);

      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          jobId: "job-account-denied",
          projectAccessScope: {
            projectId: "infinity-context",
            workspaceRoots: [join(root, "workspace")],
            jobIdPrefixes: ["infinity-context-"],
            allowedAccountIds: ["account-a"],
          },
        },
      })).rejects.toThrow(/codex_goal_job_account_denied:account_denied/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "allows brokered project-scoped control manifests but rejects missing scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));
    const workspace = join(root, "workspace");
    const ledgerRoot = join(workspace, "custody", "ledger");
    const evidenceRoot = join(workspace, "custody", "archives");
    await mkdir(workspace);
    const projectControlManifest = {
      ...jobManifest(root),
      jobId: "infinity-context-project-control",
      tmuxSession: "infinity-context-project-control",
      accessBoundary: AccessBoundary.ProjectScopedControl,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: {
        projectId: "infinity-context",
        registryRoot: join(root, "registry"),
        workspaceRoots: [workspace],
        worktreeRoots: [join(root, "worktrees")],
        consumedOutputLedgerRoots: [ledgerRoot],
        consumedOutputEvidenceRoots: [evidenceRoot],
        jobIdPrefixes: ["infinity-context-"],
        tmuxSessionPrefixes: ["infinity-context-"],
        allowedBranches: ["main"],
        allowedGitRemotes: ["origin"],
        allowedAccountIds: ["account-a", "account-b"],
      },
    } satisfies CodexGoalJobManifestInput;

    try {
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: projectControlManifest,
      })).resolves.toMatchObject({
        jobId: "infinity-context-project-control",
        accessBoundary: AccessBoundary.ProjectScopedControl,
      });
      await expect(lstat(ledgerRoot)).resolves.toMatchObject({});
      await expect(lstat(evidenceRoot)).resolves.toMatchObject({});

      const { projectAccessScope: _scope, ...missingScope } =
        projectControlManifest;
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...missingScope,
          jobId: "project-control-no-scope",
        },
      })).rejects.toThrow(/codex_goal_access_boundary_blocked:missing_project_scope/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    });

  it.runIf(!localProjectControlEvidenceCustodySupported)(
    "reports the explicit unsupported-platform error for project-control custody",
    async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        "subscription-runtime-jobs-unsupported-custody-",
      ));
      const workspace = join(root, "workspace");
      const registryRootDir = join(root, "registry");
      await mkdir(workspace);
      try {
        await expect(createCodexGoalJob({
          registryRootDir,
          manifest: {
            ...jobManifest(root),
            jobId: "infinity-context-unsupported-custody",
            tmuxSession: "infinity-context-unsupported-custody",
            accessBoundary: AccessBoundary.ProjectScopedControl,
            projectAccessScope: {
              projectId: "infinity-context",
              registryRoot: registryRootDir,
              workspaceRoots: [workspace],
              consumedOutputLedgerRoots: [
                join(workspace, "custody", "ledger"),
              ],
              consumedOutputEvidenceRoots: [
                join(workspace, "custody", "archives"),
              ],
              jobIdPrefixes: ["infinity-context-"],
              tmuxSessionPrefixes: ["infinity-context-"],
              allowedAccountIds: ["account-a", "account-b"],
            },
          },
        })).rejects.toThrow(
          "project_control_evidence_custody_platform_unsupported",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "revalidates custody immediately before initial controller publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-custody-drift-"));
    const workspace = join(root, "workspace");
    const ledgerRoot = join(workspace, "custody", "ledger");
    const evidenceRoot = join(workspace, "custody", "archives");
    const registryRootDir = join(root, "registry");
    await mkdir(workspace);
    let validations = 0;
    const custody = new LocalProjectControlEvidenceCustody(async (point) => {
      if (point !== "before_custody_manifest_publication_revalidation" ||
        ++validations !== 2) return;
      await rename(ledgerRoot, join(workspace, "custody", "moved-ledger"));
      await mkdir(ledgerRoot);
    });
    try {
      await expect(createCodexGoalJob({
        registryRootDir,
        evidenceCustody: custody,
        manifest: {
          ...jobManifest(root),
          jobId: "infinity-context-project-control-drift",
          tmuxSession: "infinity-context-project-control-drift",
          accessBoundary: AccessBoundary.ProjectScopedControl,
          projectAccessScope: {
            projectId: "infinity-context",
            registryRoot: registryRootDir,
            workspaceRoots: [workspace],
            consumedOutputLedgerRoots: [ledgerRoot],
            consumedOutputEvidenceRoots: [evidenceRoot],
            jobIdPrefixes: ["infinity-context-"],
            tmuxSessionPrefixes: ["infinity-context-"],
            allowedAccountIds: ["account-a", "account-b"],
          },
        },
      })).rejects.toThrow("evidence_custody_bootstrap_identity_drift");
      await expect(readFile(codexGoalJobManifestPath({
        registryRootDir,
        jobId: "infinity-context-project-control-drift",
      }))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    });

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "materializes custody before overwrite and upsert project-control transitions",
    async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-existing-"));
    const registryRootDir = join(root, "registry");
    const workspace = join(root, "workspace");
    const ledgerRoot = join(workspace, "custody", "ledger");
    const evidenceRoot = join(workspace, "custody", "archives");
    const upsertWorkspace = join(root, "upsert-workspace");
    const upsertLedgerRoot = join(upsertWorkspace, "custody", "ledger");
    const upsertEvidenceRoot = join(upsertWorkspace, "custody", "archives");
    await Promise.all([mkdir(workspace), mkdir(upsertWorkspace)]);
    const jobId = "infinity-context-existing";
    const upsertJobId = "infinity-context-existing-upsert";
    const existing = {
      ...jobManifest(root),
      jobId,
      tmuxSession: jobId,
    } satisfies CodexGoalJobManifestInput;
    const upsertExisting = {
      ...existing,
      jobId: upsertJobId,
      tmuxSession: upsertJobId,
      workspacePath: upsertWorkspace,
      cwd: upsertWorkspace,
      projectAccessScope: {
        projectId: "infinity-context",
        workspaceRoots: [upsertWorkspace],
        jobIdPrefixes: ["infinity-context-"],
      },
    } satisfies CodexGoalJobManifestInput;
    const control = {
      ...existing,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        projectId: "infinity-context",
        readRoots: [root],
        registryRoot: registryRootDir,
        workspaceRoots: [workspace],
        consumedOutputLedgerRoots: [ledgerRoot],
        consumedOutputEvidenceRoots: [evidenceRoot],
        jobIdPrefixes: ["infinity-context-"],
        tmuxSessionPrefixes: ["infinity-context-"],
        allowedAccountIds: ["account-a", "account-b"],
      },
    } satisfies CodexGoalJobManifestInput;
    const upsertControl = {
      ...upsertExisting,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        ...control.projectAccessScope,
        workspaceRoots: [upsertWorkspace],
        consumedOutputLedgerRoots: [upsertLedgerRoot],
        consumedOutputEvidenceRoots: [upsertEvidenceRoot],
      },
    } satisfies CodexGoalJobManifestInput;
    let custodyCalls = 0;
    const localCustody = new LocalProjectControlEvidenceCustody();
    const custody = new Proxy(localCustody, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          custodyCalls += 1;
          return Reflect.apply(value, target, args);
        };
      },
    }) as ProjectControlEvidenceCustodyPort;

    try {
      await createCodexGoalJob({ registryRootDir, manifest: existing });
      await createCodexGoalJob({ registryRootDir, manifest: upsertExisting });
      await expect(createCodexGoalJob({
        registryRootDir,
        manifest: control,
        evidenceCustody: custody,
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(custodyCalls).toBe(0);
      await expect(lstat(ledgerRoot)).rejects.toMatchObject({ code: "ENOENT" });

      await createCodexGoalJob({
        registryRootDir,
        manifest: control,
        overwrite: true,
        evidenceCustody: custody,
      });
      expect(custodyCalls).toBeGreaterThan(0);
      await expect(lstat(ledgerRoot)).resolves.toMatchObject({});
      await expect(lstat(evidenceRoot)).resolves.toMatchObject({});
      await expect(loadProjectControlController({
        registryRootDir,
        controllerJobId: jobId,
      })).resolves.toMatchObject({
        controller: { jobId },
      });

      custodyCalls = 0;
      await upsertCodexGoalLaunchManifest({
        registryRootDir,
        evidenceCustody: custody,
        launch: {
          config: {
            jobId: upsertJobId,
            jobRootDir: upsertControl.jobRootDir,
            authRootDir: upsertControl.authRootDir!,
            workspacePath: upsertControl.workspacePath,
            promptPath: upsertControl.promptPath,
            taskId: upsertControl.taskId,
            accounts: upsertControl.accounts.map((name) => ({ name })),
            accessBoundary: upsertControl.accessBoundary,
            projectAccessScope: upsertControl.projectAccessScope,
            networkAccess: upsertControl.networkAccess!,
          },
          tmuxSession: upsertControl.tmuxSession,
          cwd: upsertControl.cwd!,
          logPath: upsertControl.logPath!,
          cliCommand: ["codex"],
        },
      });
      expect(custodyCalls).toBeGreaterThan(0);
      await expect(lstat(upsertLedgerRoot)).resolves.toMatchObject({});
      await expect(lstat(upsertEvidenceRoot)).resolves.toMatchObject({});
      await expect(loadProjectControlController({
        registryRootDir,
        controllerJobId: upsertJobId,
      })).resolves.toMatchObject({
        controller: { jobId: upsertJobId },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    },
  );
});

function jobManifest(root: string): CodexGoalJobManifestInput {
  return {
    jobId: "job-a",
    description: "sandbox job",
    tags: ["locomo"],
    jobRootDir: join(root, "job"),
    authRootDir: join(root, "auth"),
    stateRootDir: join(root, "state"),
    workspacePath: join(root, "workspace"),
    promptPath: join(root, "job", "prompt.md"),
    codexGoalObjective: "Short objective with docs links.",
    taskId: "task-a",
    accounts: ["account-a", "account-b"],
    outputPath: join(root, "job", "task-a.latest-result.json"),
    codexBinaryPath: "codex",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    taskTimeoutMs: 72 * 60 * 60 * 1000,
    appServerStartupTimeoutMs: 45_000,
    maxAccountCycles: 3,
    editMode: "allow-edits",
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    projectAccessScope: {
      projectId: "infinity-context",
      workspaceRoots: [join(root, "workspace")],
      jobIdPrefixes: ["infinity-context-"],
    },
    networkAccess: NetworkAccessMode.Restricted,
    allowDuplicateAccountIdentities: false,
    requireGitWorkspace: true,
    prewarmOnStart: false,
    workerReportMode: "structured-output",
    tmuxSession: "job-a",
    cwd: root,
    logPath: join(root, "job", "task-a.log"),
    outputFormat: "json",
  };
}
