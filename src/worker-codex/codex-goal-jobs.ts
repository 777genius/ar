import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { optionalWorkerMode } from "./project-control-worker-mode";
import { childConfigFromRecord } from "./child-execution-confinement";
import { createHash } from "node:crypto";
import { initializeControllerStateOrigin } from "./application/project-control/codex-goal-controller-state-location";
import { publishCodexGoalJobWithProtectedBirth, type ProtectedCodexGoalJobBirthPreparation } from "./protected-job-birth";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AccessBoundary,
  createAccessPolicyService,
  type NetworkAccessMode,
  type ProjectAccessScope,
  type ProjectControlCustodyBootstrapCertification,
  type ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from
  "../worker-local/project-control-evidence-custody-local-adapter";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { CodexGoalMimoAccountSlot } from "./codex-goal-mimo-account-slots";
import { optionalCodexGoalMimoAccountSlots } from "./codex-goal-mimo-account-slots";
import type { CodexGoalOutputFormat } from "./codex-goal-ops";
import {
  assertCodexGoalStoredAccessBoundaryAllowed,
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScope,
} from "./codex-goal-access-plan";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalEditMode,
  optionalCodexGoalProviderSandboxMode,
} from "./codex-goal-control-modes";
import { withCodexGoalManifestUpdate, withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { currentHostedOrdinaryWriterExtent, assertHostedOrdinaryRegistryPublication } from "../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { projectControlWorkspaceLockRoot } from "./codex-goal-project-workspace-lock";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { durableReplaceJsonFile } from "./project-control-operation-file-store";
import {
  CodexGoalAccountSelectionMode,
  assertAccountReplacementHasKnownOrigin,
  optionalCodexGoalAccountSelectionMode,
} from "./codex-goal-account-selection-mode";
export { CodexGoalAccountSelectionMode } from "./codex-goal-account-selection-mode";
import { optionalCodexGoalModelBackend } from "./codex-goal-model-backend";
import {
  assertJobId,
  isRecord,
  optionalBooleanProperty,
  optionalPositiveIntegerProperty,
  optionalString,
  optionalWorkerReportMode,
  readStringArray,
  requiredIsoDate,
  requiredString,
  resolvePath,
  uniqueManifestStrings,
} from "./codex-goal-job-manifest-parse-primitives";
export const codexGoalJobManifestSchemaVersion = 1;
export const codexGoalObjectiveMaxChars = 4000;
export type CodexGoalProjectPreStartAdmission =
  | {
      readonly schemaVersion: 1;
      readonly contractValidatorPath: string;
      readonly admissionValidatorPath: string;
      readonly contractPath: string;
      readonly statePath: string;
      readonly receiptPath: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: "serial-builtin";
      readonly contractPath: string;
      readonly statePath: string;
      readonly receiptPath: string;
    };

export type CodexGoalJobManifest = {
  readonly schemaVersion: typeof codexGoalJobManifestSchemaVersion;
  readonly jobId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly jobRootDir: string;
  readonly durableHandoffRootDir?: string;
  readonly authRootDir?: string;
  readonly stateRootDir?: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly codexGoalObjective?: string;
  readonly taskId: string;
  readonly accounts: readonly string[];
  readonly mimoAccounts?: readonly CodexGoalMimoAccountSlot[];
  readonly accountSelectionMode?: CodexGoalAccountSelectionMode;
  readonly outputPath?: string;
  readonly progressPath?: string;
  readonly progressHeartbeatMs?: number;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexGoalRunConfig["reasoningEffort"];
  readonly serviceTier?: CodexGoalRunConfig["serviceTier"];
  readonly executionEngine?: CodexGoalRunConfig["executionEngine"];
  readonly checkpointRequired?: boolean;
  /** Defaults to OpenAiChatGpt — an existing manifest with no modelBackend needs no migration. */
  readonly modelBackend?: CodexGoalRunConfig["modelBackend"];
  readonly taskTimeoutMs?: number;
  readonly appServerStartupTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly childLifetime?: CodexGoalRunConfig["childLifetime"];
  readonly maxGoalTurns?: number;
  readonly safeExecutionPolicy?: CodexGoalRunConfig["safeExecutionPolicy"];
  readonly editMode?: CodexGoalRunConfig["editMode"];
  readonly providerSandboxMode?: CodexGoalRunConfig["providerSandboxMode"];
  readonly accessBoundary?: AccessBoundary;
  readonly projectAccessScope?: ProjectAccessScope;
  readonly allowDangerFullAccess?: boolean;
  readonly networkAccess?: NetworkAccessMode;
  readonly workerMode?: CodexGoalRunConfig["workerMode"];
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly requireGitWorkspace?: boolean;
  readonly prewarmOnStart?: boolean;
  readonly workerReportMode?: CodexGoalRunConfig["workerReportMode"];
  readonly tmuxSession?: string;
  readonly cwd?: string;
  readonly logPath?: string;
  readonly outputFormat?: CodexGoalOutputFormat;
  readonly projectPreStartAdmission?: CodexGoalProjectPreStartAdmission;
};

export type CodexGoalJobManifestInput = Omit<
  CodexGoalJobManifest,
  "schemaVersion" | "createdAt" | "updatedAt"
> & {
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export type CodexGoalJobManifestPatch = Partial<
  Omit<CodexGoalJobManifestInput, "jobId" | "createdAt">
>;

export type CodexGoalJobSummary = {
  readonly jobId: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly taskId: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly tmuxSession?: string;
  readonly accountNames: readonly string[];
  readonly updatedAt: string;
  readonly manifestPath: string;
};

export type CodexGoalJobRegistryInput = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
};

export function defaultCodexGoalJobRegistryRoot(): string {
  return join(homedir(), ".cache", "subscription-runtime", "codex-goal-jobs");
}

export function defaultCodexGoalJobRoot(jobId: string): string {
  assertJobId(jobId);
  return join(homedir(), ".cache", "subscription-runtime", jobId);
}

export function resolveCodexGoalJobRegistryRoot(
  input: CodexGoalJobRegistryInput = {},
): string {
  return resolvePath(
    input.cwd ?? process.cwd(),
    input.registryRootDir ?? defaultCodexGoalJobRegistryRoot(),
  );
}

export function codexGoalJobManifestPath(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
}): string {
  assertJobId(input.jobId);
  return join(input.registryRootDir, input.jobId, "job.json");
}

export async function listCodexGoalJobs(
  input: CodexGoalJobRegistryInput = {},
): Promise<readonly CodexGoalJobSummary[]> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  let entries;
  try {
    entries = await readdir(registryRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const manifest = await readCodexGoalJob({
            registryRootDir,
            jobId: entry.name,
          });
          return summarizeCodexGoalJob(manifest, registryRootDir);
        } catch {
          return null;
        }
      }),
  );
  return summaries
    .filter((summary): summary is CodexGoalJobSummary => summary !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readCodexGoalJob(input: {
  readonly registryRootDir?: string;
  readonly jobId: string;
  readonly cwd?: string;
}): Promise<CodexGoalJobManifest> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  const path = codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId });
  return parseStoredCodexGoalJobManifest(
    JSON.parse(await readFile(path, "utf8")),
  );
}

export async function createCodexGoalJob(input: {
  readonly registryRootDir?: string;
  readonly manifest: CodexGoalJobManifestInput;
  readonly overwrite?: boolean;
  readonly cwd?: string;
  readonly now?: Date;
  readonly evidenceCustody?: ProjectControlEvidenceCustodyPort;
  readonly protectedBirthPreparation?: ProtectedCodexGoalJobBirthPreparation;
}): Promise<CodexGoalJobManifest> {
  const original = currentHostedOrdinaryWriterExtent();
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  const now = (input.now ?? new Date()).toISOString();
  const nativeWorker = input.manifest.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
    input.manifest.executionEngine === "app-server" && input.manifest.workerReportMode === "structured-output" &&
    input.manifest.childLifetime === undefined;
  const manifest = parseCodexGoalJobManifest({
    ...input.manifest,
    ...(!nativeWorker || input.manifest.durableHandoffRootDir !== undefined
      ? { durableHandoffRootDir: input.manifest.durableHandoffRootDir ?? join(registryRootDir, "durable-handoffs") } : {}),
    schemaVersion: codexGoalJobManifestSchemaVersion,
    createdAt: input.manifest.createdAt ?? now,
    updatedAt: input.manifest.updatedAt ?? now,
  });
  assertCodexGoalStoredAccessBoundaryAllowed(manifest);
  await assertCodexGoalJobManifestAccessConsistency(
    manifest,
    registryRootDir,
    { requireProjectControllerCreateAuthorization: true },
  );
  const path = codexGoalJobManifestPath({
    registryRootDir,
    jobId: manifest.jobId,
  });
  const existedBeforeAdmission = await pathExists(path);
  if (existedBeforeAdmission && !input.overwrite) {
    throw codexGoalJobManifestAlreadyExists(path);
  }
  if (existedBeforeAdmission) {
    const previous: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!previous || typeof previous !== "object" ||
        !("jobRootDir" in previous) || previous.jobRootDir !== manifest.jobRootDir) {
      throw new Error("job_manifest_activity_identity_invalid");
    }
  }
  const publish = () => withCodexGoalRegistryMutation({
    registryRootDir,
    effect: async assertPublicationCurrent => {
      assertPublicationCurrent([join(registryRootDir, manifest.jobId), path], manifest.jobRootDir);
      if ((await pathExists(path)) && !existedBeforeAdmission) {
        throw codexGoalJobManifestAlreadyExists(path);
      }
      if (existedBeforeAdmission) {
        const current: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!current || typeof current !== "object" ||
            !("jobRootDir" in current) || current.jobRootDir !== manifest.jobRootDir) {
          throw new Error("job_manifest_activity_identity_invalid");
        }
      }
      const publishManifest = async (freshJobRoot = false) => {
        if (!await pathExists(path) && manifest.accessBoundary === AccessBoundary.ProjectScopedControl) {
          await initializeControllerStateOrigin(manifest, freshJobRoot);
        }
        const custodyCertification = await bootstrapInitialProjectControlCustody(
          manifest,
          input.evidenceCustody ?? new LocalProjectControlEvidenceCustody(),
        );
        try {
          assertPublicationCurrent([join(registryRootDir, manifest.jobId)]);
          await mkdir(join(registryRootDir, manifest.jobId), {
            recursive: true,
            mode: 0o700,
          });
          await custodyCertification?.revalidate();
          assertPublicationCurrent([path]);
          await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: input.overwrite ? "w" : "wx",
          });
          return manifest;
        } finally {
          await custodyCertification?.close();
        }
      };
      return existedBeforeAdmission ? await publishManifest() : await publishCodexGoalJobWithProtectedBirth({
        job: manifest, manifestInput: input.manifest, manifestPath: path, publish: publishManifest,
        ...(input.protectedBirthPreparation ? { preparation: input.protectedBirthPreparation } : {}),
      });
    },
  });
  if (original && currentHostedOrdinaryWriterExtent()?.startId !== original.startId) throw new Error("hosted_ordinary_writer_extent_invalid");
  assertHostedOrdinaryRegistryPublication(registryRootDir, projectControlWorkspaceLockRoot(registryRootDir), [path], manifest.jobRootDir);
  // A new manifest has no checkpointable identity yet. Its registry mutex
  // protects initial publication; preserve the absent-root origin attestation.
  return existedBeforeAdmission
    ? new LocalTerminalCheckpointAdmission(manifest.jobRootDir).withWriter(publish)
    : publish();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT") return false;
    throw error;
  }
}

export async function updateCodexGoalJob(input: {
  readonly registryRootDir?: string;
  readonly jobId: string;
  readonly patch: CodexGoalJobManifestPatch;
  readonly cwd?: string;
  readonly now?: Date;
  readonly evidenceCustody?: ProjectControlEvidenceCustodyPort;
  /** Revision of persisted bytes, including unknown fields. */
  readonly expectedManifestSha256?: string;
  /** Revision of the parsed controller loaded by scope recovery. */
  readonly expectedParsedManifestSha256?: string;
  readonly beforeManifestPublication?: () => Promise<void>;
}): Promise<CodexGoalJobManifest> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  const lockedManifestPath = codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId });
  return await withCodexGoalManifestUpdate({
    registryRootDir,
    manifestPath: lockedManifestPath,
    ...(input.expectedManifestSha256 === undefined
      ? {} : { expectedManifestSha256: input.expectedManifestSha256 }),
    effect: async assertPublicationCurrent => {
      const existing = await readCodexGoalJob({
        registryRootDir,
        jobId: input.jobId,
      });
      const assertExpectedParsedManifest = (current: CodexGoalJobManifest) => {
        if (input.expectedParsedManifestSha256 !== undefined &&
          createHash("sha256").update(JSON.stringify(current)).digest("hex") !== input.expectedParsedManifestSha256) {
          throw new Error("project_control_controller_scope_cas_mismatch");
        }
      };
      assertExpectedParsedManifest(existing);
      assertAccountReplacementHasKnownOrigin({ existing, patch: input.patch });
      const manifest = parseCodexGoalJobManifest({
        ...existing,
        ...input.patch,
        jobId: existing.jobId,
        schemaVersion: codexGoalJobManifestSchemaVersion,
        createdAt: existing.createdAt,
        updatedAt: (input.now ?? new Date()).toISOString(),
      });
      // Admission is held for the persisted job root. Moving that identity
      // would publish a manifest under the wrong checkpoint fence.
      if (manifest.jobRootDir !== existing.jobRootDir) {
        throw new Error("job_manifest_activity_identity_invalid");
      }
      assertCodexGoalStoredAccessBoundaryAllowed(manifest);
      await assertCodexGoalJobManifestAccessConsistency(
        manifest,
        registryRootDir,
        {
          requireProjectControllerCreateAuthorization:
            existing.accessBoundary !== AccessBoundary.ProjectScopedControl,
        },
      );
      const manifestPath = codexGoalJobManifestPath({
        registryRootDir,
        jobId: input.jobId,
      });
      const custodyCertification = requiresProjectControlCustodyCertification(
          existing,
          manifest,
        )
        ? await bootstrapInitialProjectControlCustody(
            manifest,
            input.evidenceCustody ?? new LocalProjectControlEvidenceCustody(),
          )
        : undefined;
      try {
        await custodyCertification?.revalidate();
        await durableReplaceJsonFile({ path: manifestPath, value: manifest,
          assertPublicationCurrent,
          beforePublication: async () => {
            await input.beforeManifestPublication?.();
            assertExpectedParsedManifest(await readCodexGoalJob({ registryRootDir, jobId: input.jobId }));
          },
        });
        return manifest;
      } finally {
        await custodyCertification?.close();
      }
    },
  });
}

function requiresProjectControlCustodyCertification(
  existing: CodexGoalJobManifest,
  manifest: CodexGoalJobManifest,
): boolean {
  return manifest.accessBoundary === AccessBoundary.ProjectScopedControl &&
    existing.accessBoundary !== AccessBoundary.ProjectScopedControl;
}

function codexGoalJobManifestAlreadyExists(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `EEXIST: file already exists, open '${path}'`,
  ) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  error.path = path;
  error.syscall = "open";
  return error;
}

export function codexGoalJobToArgs(
  manifest: CodexGoalJobManifest,
): Readonly<Record<string, unknown>> {
  return {
    jobId: manifest.jobId,
    jobRootDir: manifest.jobRootDir,
    durableHandoffRootDir: manifest.durableHandoffRootDir,
    authRootDir: manifest.authRootDir,
    stateRootDir: manifest.stateRootDir,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    codexGoalObjective: manifest.codexGoalObjective,
    taskId: manifest.taskId,
    accounts: manifest.accounts,
    ...(manifest.mimoAccounts === undefined
      ? {}
      : { mimoAccounts: manifest.mimoAccounts }),
    outputPath: manifest.outputPath,
    progressPath: manifest.progressPath,
    progressHeartbeatMs: manifest.progressHeartbeatMs,
    codexBinaryPath: manifest.codexBinaryPath,
    model: manifest.model,
    reasoningEffort: manifest.reasoningEffort,
    serviceTier: manifest.serviceTier,
    executionEngine: manifest.executionEngine,
    checkpointRequired: manifest.checkpointRequired,
    modelBackend: manifest.modelBackend,
    taskTimeoutMs: manifest.taskTimeoutMs,
    appServerStartupTimeoutMs: manifest.appServerStartupTimeoutMs,
    staleLockMs: manifest.staleLockMs,
    maxAccountCycles: manifest.maxAccountCycles,
    ...childConfigFromRecord(manifest as unknown as Readonly<Record<string, unknown>>),
    editMode: manifest.editMode,
    providerSandboxMode: manifest.providerSandboxMode,
    accessBoundary: manifest.accessBoundary,
    projectAccessScope: manifest.projectAccessScope,
    allowDangerFullAccess: manifest.allowDangerFullAccess,
    networkAccess: manifest.networkAccess,
    workerMode: manifest.workerMode,
    allowDuplicateAccountIdentities: manifest.allowDuplicateAccountIdentities,
    requireGitWorkspace: manifest.requireGitWorkspace,
    prewarmOnStart: manifest.prewarmOnStart,
    workerReportMode: manifest.workerReportMode,
    tmuxSession: manifest.tmuxSession,
    cwd: manifest.cwd,
    logPath: manifest.logPath,
    outputFormat: manifest.outputFormat,
  };
}

export function summarizeCodexGoalJob(
  manifest: CodexGoalJobManifest,
  registryRootDir: string,
): CodexGoalJobSummary {
  return {
    jobId: manifest.jobId,
    ...(manifest.description ? { description: manifest.description } : {}),
    tags: manifest.tags ?? [],
    taskId: manifest.taskId,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
    accountNames: manifest.accounts,
    updatedAt: manifest.updatedAt,
    manifestPath: codexGoalJobManifestPath({
      registryRootDir,
      jobId: manifest.jobId,
    }),
  };
}

export function parseCodexGoalJobManifest(
  value: unknown,
): CodexGoalJobManifest {
  return parseCodexGoalJobManifestValue(value, {});
}

export function parseStoredCodexGoalJobManifest(
  value: unknown,
): CodexGoalJobManifest {
  return parseCodexGoalJobManifestValue(value, {
    allowLegacyBuiltinContractSchema: true,
  });
}

function parseCodexGoalJobManifestValue(
  value: unknown,
  options: { readonly allowLegacyBuiltinContractSchema?: boolean },
): CodexGoalJobManifest {
  if (!isRecord(value)) throw new Error("codex_goal_job_manifest_invalid");
  if (value.schemaVersion !== codexGoalJobManifestSchemaVersion) {
    throw new Error("codex_goal_job_manifest_version_unsupported");
  }
  const jobId = requiredString(value.jobId, "jobId");
  assertJobId(jobId);
  const accounts = readStringArray(value.accounts, "accounts");
  if (accounts.length === 0) throw new Error("codex_goal_job_accounts_required");
  const mimoAccounts = value.mimoAccounts === undefined
    ? undefined
    : optionalCodexGoalMimoAccountSlots(value.mimoAccounts).mimoAccounts;
  const editMode = optionalCodexGoalEditMode(
    optionalString(value.editMode) ?? optionalString(value.permissionMode),
    optionalString(value.editMode) === undefined &&
      optionalString(value.permissionMode) !== undefined
      ? "permissionMode"
      : "editMode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    optionalString(value.providerSandboxMode),
    "providerSandboxMode",
  );
  const accessBoundary = optionalCodexGoalAccessBoundary(value.accessBoundary);
  const projectAccessScope = parseCodexGoalProjectAccessScope(
    options.allowLegacyBuiltinContractSchema === true
      ? normalizeStoredCodexGoalProjectAccessScope(value.projectAccessScope)
      : value.projectAccessScope,
  );
  const networkAccess = optionalCodexGoalNetworkAccess(value.networkAccess);
  const workerMode = optionalWorkerMode(value.workerMode);
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "providerSandboxMode",
  });
  const manifest: CodexGoalJobManifest = {
    schemaVersion: codexGoalJobManifestSchemaVersion,
    jobId,
    createdAt: requiredIsoDate(value.createdAt, "createdAt"),
    updatedAt: requiredIsoDate(value.updatedAt, "updatedAt"),
    ...(optionalString(value.description) === undefined
      ? {}
      : { description: optionalString(value.description) as string }),
    ...(value.tags === undefined ? {} : { tags: readStringArray(value.tags, "tags") }),
    jobRootDir: requiredString(value.jobRootDir, "jobRootDir"),
    ...(optionalString(value.durableHandoffRootDir) === undefined
      ? {}
      : {
          durableHandoffRootDir: optionalString(
            value.durableHandoffRootDir,
          ) as string,
        }),
    ...(optionalString(value.authRootDir) === undefined
      ? {}
      : { authRootDir: optionalString(value.authRootDir) as string }),
    ...(optionalString(value.stateRootDir) === undefined
      ? {}
      : { stateRootDir: optionalString(value.stateRootDir) as string }),
    workspacePath: requiredString(value.workspacePath, "workspacePath"),
    promptPath: requiredString(value.promptPath, "promptPath"),
    ...(optionalString(value.codexGoalObjective) === undefined
      ? {}
      : { codexGoalObjective: optionalString(value.codexGoalObjective) as string }),
    taskId: requiredString(value.taskId, "taskId"),
    accounts,
    ...(mimoAccounts === undefined ? {} : { mimoAccounts }),
    ...optionalCodexGoalAccountSelectionMode(value.accountSelectionMode),
    ...(optionalString(value.outputPath) === undefined
      ? {}
      : { outputPath: optionalString(value.outputPath) as string }),
    ...(optionalString(value.progressPath) === undefined
      ? {}
      : { progressPath: optionalString(value.progressPath) as string }),
    ...optionalPositiveIntegerProperty(
      value.progressHeartbeatMs,
      "progressHeartbeatMs",
    ),
    ...(optionalString(value.codexBinaryPath) === undefined
      ? {}
      : { codexBinaryPath: optionalString(value.codexBinaryPath) as string }),
    ...(optionalString(value.model) === undefined
      ? {}
      : { model: optionalString(value.model) as string }),
    ...(optionalString(value.reasoningEffort) === undefined
      ? {}
      : {
          reasoningEffort: optionalString(value.reasoningEffort) as NonNullable<
            CodexGoalRunConfig["reasoningEffort"]
          >,
        }),
    ...(optionalString(value.serviceTier) === undefined
      ? {}
      : {
          serviceTier: optionalString(value.serviceTier) as NonNullable<
            CodexGoalRunConfig["serviceTier"]
          >,
        }),
    ...(optionalString(value.executionEngine) === undefined
      ? {}
      : {
          executionEngine: optionalString(value.executionEngine) as NonNullable<
            CodexGoalRunConfig["executionEngine"]
          >,
        }),
    ...(value.checkpointRequired === true ? { checkpointRequired: true } : {}),
    ...optionalCodexGoalModelBackend(value.modelBackend),
    ...optionalPositiveIntegerProperty(value.taskTimeoutMs, "taskTimeoutMs"),
    ...optionalPositiveIntegerProperty(
      value.appServerStartupTimeoutMs,
      "appServerStartupTimeoutMs",
    ),
    ...optionalPositiveIntegerProperty(value.staleLockMs, "staleLockMs"),
    ...optionalPositiveIntegerProperty(value.maxAccountCycles, "maxAccountCycles"),
    ...childConfigFromRecord(value),
    ...(editMode === undefined ? {} : { editMode }),
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    ...optionalBooleanProperty(value.allowDangerFullAccess, "allowDangerFullAccess"),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    ...(workerMode === undefined ? {} : { workerMode }),
    ...optionalBooleanProperty(
      value.allowDuplicateAccountIdentities,
      "allowDuplicateAccountIdentities",
    ),
    ...optionalBooleanProperty(value.requireGitWorkspace, "requireGitWorkspace"),
    ...optionalBooleanProperty(value.prewarmOnStart, "prewarmOnStart"),
    ...(optionalWorkerReportMode(value.workerReportMode) === undefined
      ? {}
      : {
          workerReportMode: optionalWorkerReportMode(
            value.workerReportMode,
          ) as NonNullable<CodexGoalRunConfig["workerReportMode"]>,
        }),
    ...(optionalString(value.tmuxSession) === undefined
      ? {}
      : { tmuxSession: optionalString(value.tmuxSession) as string }),
    ...(optionalString(value.cwd) === undefined
      ? {}
      : { cwd: optionalString(value.cwd) as string }),
    ...(optionalString(value.logPath) === undefined
      ? {}
      : { logPath: optionalString(value.logPath) as string }),
    ...(value.projectPreStartAdmission === undefined
      ? {}
      : {
          projectPreStartAdmission: parseProjectPreStartAdmissionManifest(
            value.projectPreStartAdmission,
            options,
          ),
        }),
    ...(optionalString(value.outputFormat) === undefined
      ? {}
      : {
          outputFormat: optionalString(value.outputFormat) as CodexGoalOutputFormat,
        }),
  };
  return manifest;
}

function normalizeStoredCodexGoalProjectAccessScope(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.preStartAdmission)) return value;
  const admission = value.preStartAdmission;
  if (admission.contractSchema === undefined) return value;
  if (
    admission.mode !== "serial-builtin" ||
    admission.contractSchema !== "worker-start-v1"
  ) {
    throw new Error(
      "codex_goal_job_projectAccessScope_preStartAdmission_contractSchema_invalid",
    );
  }
  const normalizedAdmission = { ...admission };
  delete normalizedAdmission.contractSchema;
  return {
    ...value,
    preStartAdmission: normalizedAdmission,
  };
}

function parseProjectPreStartAdmissionManifest(
  value: unknown,
  options: { readonly allowLegacyBuiltinContractSchema?: boolean },
): CodexGoalProjectPreStartAdmission {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("codex_goal_job_projectPreStartAdmission_invalid");
  }
  const contractPath = requiredString(
    value.contractPath,
    "projectPreStartAdmission.contractPath",
  );
  const statePath = requiredString(
    value.statePath,
    "projectPreStartAdmission.statePath",
  );
  const receiptPath = requiredString(
    value.receiptPath,
    "projectPreStartAdmission.receiptPath",
  );
  if (value.mode === "serial-builtin") {
    const allowedFields = new Set([
      "schemaVersion",
      "mode",
      "contractPath",
      "statePath",
      "receiptPath",
      ...(options.allowLegacyBuiltinContractSchema === true
        ? ["contractSchema"]
        : []),
    ]);
    for (const field of Object.keys(value)) {
      if (!allowedFields.has(field)) {
        throw new Error(
          `codex_goal_job_projectPreStartAdmission_unexpected_field:${field}`,
        );
      }
    }
    if (
      value.contractSchema !== undefined &&
      value.contractSchema !== "worker-start-v1"
    ) {
      throw new Error(
        "codex_goal_job_projectPreStartAdmission_contractSchema_invalid",
      );
    }
    return {
      schemaVersion: 1,
      mode: "serial-builtin",
      contractPath,
      statePath,
      receiptPath,
    };
  }
  return {
    schemaVersion: 1,
    contractValidatorPath: requiredString(
      value.contractValidatorPath,
      "projectPreStartAdmission.contractValidatorPath",
    ),
    admissionValidatorPath: requiredString(
      value.admissionValidatorPath,
      "projectPreStartAdmission.admissionValidatorPath",
    ),
    contractPath,
    statePath,
    receiptPath,
  };
}

async function assertCodexGoalJobManifestAccessConsistency(
  manifest: CodexGoalJobManifest,
  registryRootDir: string,
  options: {
    readonly requireProjectControllerCreateAuthorization: boolean;
  },
): Promise<void> {
  if (
    manifest.accessBoundary === undefined ||
    manifest.accessBoundary === AccessBoundary.DangerFullAccess ||
    manifest.projectAccessScope === undefined
  ) {
    return;
  }
  const scope = await scopeWithExistingCanonicalRoots(manifest.projectAccessScope);
  const policy = createAccessPolicyService({
    boundary: manifest.accessBoundary,
    scope,
  });
  const workspaceRealPath = await optionalRealPath(manifest.workspacePath);
  const workspacePathRequest = {
    path: manifest.workspacePath,
    ...(workspaceRealPath === undefined ? {} : { realPath: workspaceRealPath }),
  };
  const workspaceDecision =
    manifest.accessBoundary === AccessBoundary.ReadOnly
      ? policy.canReadPath(workspacePathRequest)
      : policy.canWritePath(workspacePathRequest);
  if (!workspaceDecision.allowed) {
    throw new Error(
      `codex_goal_job_workspacePath_denied:${workspaceDecision.reason}`,
    );
  }
  for (const accountId of manifest.accounts) {
    const accountDecision = policy.canUseAccount({ accountId });
    if (!accountDecision.allowed) {
      throw new Error(`codex_goal_job_account_denied:${accountDecision.reason}`);
    }
  }
  if (
    manifest.accessBoundary !== AccessBoundary.ProjectScopedControl ||
    !options.requireProjectControllerCreateAuthorization
  ) {
    // Child job and tmux prefixes do not identify an already-stored controller.
    if (
      manifest.accessBoundary === AccessBoundary.ProjectScopedControl &&
      manifest.projectAccessScope?.registryRoot &&
      resolve(manifest.projectAccessScope.registryRoot) !== resolve(registryRootDir)
    ) {
      throw new Error("codex_goal_job_create_denied:path_outside_scope");
    }
    return;
  }
  const createDecision = policy.canCreateJob({
    jobId: manifest.jobId,
    registryRoot: registryRootDir,
    workspacePath: manifest.workspacePath,
    ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
  });
  if (!createDecision.allowed) {
    throw new Error(`codex_goal_job_create_denied:${createDecision.reason}`);
  }
}

export async function bootstrapInitialProjectControlCustody(
  manifest: CodexGoalJobManifest,
  custody: ProjectControlEvidenceCustodyPort,
): Promise<ProjectControlCustodyBootstrapCertification | undefined> {
  const plan = await resolveInitialProjectControlCustodyPlan(manifest, custody);
  return plan ? await custody.materializeApprovedProjectControlCustody(plan) : undefined;
}

export async function resolveInitialProjectControlCustodyPlan(
  manifest: CodexGoalJobManifest,
  custody: ProjectControlEvidenceCustodyPort,
): Promise<Parameters<ProjectControlEvidenceCustodyPort["materializeApprovedProjectControlCustody"]>[0] | undefined> {
  if (manifest.accessBoundary !== AccessBoundary.ProjectScopedControl ||
    !manifest.projectAccessScope) return undefined;
  const scope = manifest.projectAccessScope;
  const ledgerRoots = scope.consumedOutputLedgerRoots ?? [];
  const evidenceRoots = scope.consumedOutputEvidenceRoots ?? [];
  if (ledgerRoots.length === 0 && evidenceRoots.length === 0) return undefined;
  for (const root of evidenceRoots) {
    if (!isAbsolute(root) || resolve(root) !== root || basename(root) !== "archives") {
      throw new Error("evidence_custody_bootstrap_evidence_basename_invalid");
    }
  }
  const configuredRoots = [...ledgerRoots, ...evidenceRoots];
  for (const root of configuredRoots) {
    if (!isAbsolute(root) || resolve(root) !== root) {
      throw new Error("evidence_custody_bootstrap_root_unsafe");
    }
  }
  const candidateInputs = uniqueManifestStrings([
    ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []),
    ...(scope.observedWorkspaceRoots ?? []),
    ...(scope.readRoots ?? []),
    ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
    ...(scope.registryRoot ? [scope.registryRoot] : []),
  ]);
  const candidates: string[] = [];
  for (const candidate of candidateInputs) {
    try {
      const canonical = await custody.canonicalDirectory(candidate);
      if (canonical !== resolve(candidate)) continue;
      if (configuredRoots.every((root) => pathStrictlyInside(canonical, root))) {
        candidates.push(canonical);
      }
    } catch (error) {
      if (error instanceof Error &&
        error.message ===
          "project_control_evidence_custody_platform_unsupported") {
        throw error;
      }
      // Only an already-existing, canonical project-owned root may be an anchor.
    }
  }
  const anchor = candidates.sort((left, right) => right.length - left.length)[0];
  if (!anchor) throw new Error("evidence_custody_bootstrap_anchor_unsafe");
  return {
    approvedAnchor: anchor,
    ledgerRoots,
    evidenceRoots,
    deniedRoots: scope.deniedRoots ?? [],
  };
}

function pathStrictlyInside(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) &&
    !isAbsolute(rest);
}

async function optionalRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function scopeWithExistingCanonicalRoots(
  scope: ProjectAccessScope,
): Promise<ProjectAccessScope> {
  const isolatedWorkspaceRoot = scope.isolatedWorkspaceRoot
    ? await existingCanonicalNonSymlinkRoot(scope.isolatedWorkspaceRoot)
    : undefined;
  const workspaceRootAliases = await existingCanonicalNonSymlinkRoots([
    ...(scope.workspaceRoots ?? []),
    ...(isolatedWorkspaceRoot ? [isolatedWorkspaceRoot] : []),
  ]);
  const worktreeRootAliases = await existingCanonicalNonSymlinkRoots(
    scope.worktreeRoots ?? [],
  );
  const readRootAliases = await existingCanonicalNonSymlinkRoots([
    ...(scope.readRoots ?? []),
    ...workspaceRootAliases,
    ...worktreeRootAliases,
  ]);
  return {
    ...scope,
    ...(readRootAliases.length === 0
      ? {}
      : { readRoots: uniqueManifestStrings([...(scope.readRoots ?? []), ...readRootAliases]) }),
    ...(workspaceRootAliases.length === 0
      ? {}
      : {
          workspaceRoots: uniqueManifestStrings([
            ...(scope.workspaceRoots ?? []),
            ...workspaceRootAliases,
          ]),
        }),
    ...(worktreeRootAliases.length === 0
      ? {}
      : {
          worktreeRoots: uniqueManifestStrings([
            ...(scope.worktreeRoots ?? []),
            ...worktreeRootAliases,
          ]),
        }),
  };
}

async function existingCanonicalNonSymlinkRoots(
  roots: readonly string[],
): Promise<readonly string[]> {
  const canonical = await Promise.all(roots.map(existingCanonicalNonSymlinkRoot));
  return uniqueManifestStrings(canonical.filter((root): root is string => root !== undefined));
}

async function existingCanonicalNonSymlinkRoot(
  root: string,
): Promise<string | undefined> {
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink()) return undefined;
    const canonical = await realpath(root);
    return canonical === root ? undefined : canonical;
  } catch {
    return undefined;
  }
}
