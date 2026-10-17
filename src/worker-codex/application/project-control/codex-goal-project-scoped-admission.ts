import { isDeepStrictEqual } from "node:util";
import { isAbsolute, resolve } from "node:path";
import {
  ProjectDebtReason,
  ProjectDebtScope,
  ProjectOperation,
  type ProjectAccessScope,
  type ProjectAdmissionRequest,
  type ProjectAdmissionScopedContext,
  type ProjectAdmissionSnapshot,
  type ProjectAdmissionPhysicalRoot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import { historicalDebtIsPhysicallyUnrelated } from "./codex-goal-project-historical-debt-scope";
import { observeJobRetirement } from "../../job-retirement/job-retirement-records";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from "../../codex-goal-jobs";
import { optionalRealPathForAdmission, prospectiveAdmissionResourcePath, prospectiveAdmissionResourceBacking } from "./codex-goal-project-admission-paths";
import {
  admissionCreationTargetIdentity,
  admissionCreateJobTargetIdentity,
  admissionStartSelfIdentity,
  assertAdmissionRegistryComplete,
  type ProjectAdmissionTargetBinding,
} from "./codex-goal-project-admission-target";
import { pathInsideOrEqual } from "./codex-goal-project-utils";
import type { CodexProjectAdmissionDeps } from "./codex-goal-project-admission";

type WriterAuthority = "allocated" | "released" | "unknown";

export type WriterCensusEntry = {
  readonly manifest?: CodexGoalJobManifest;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly canonicalWorkspacePath?: string;
  readonly writableRoots?: readonly ProjectAdmissionPhysicalRoot[];
  readonly authority: WriterAuthority;
};

export type CodexProjectScopedAdmissionInput = {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly controllerJobId?: string;
  readonly request: ProjectAdmissionRequest;
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly targetBinding?: ProjectAdmissionTargetBinding;
  readonly deps: CodexProjectAdmissionDeps;
};

const MAX_BACKLOG_PREVIEW = 3;
/** A closed or retired job is proven terminal by its records, and its pins and
 * workspace may already be gone: it holds no writer. Doubt stays unknown. */
function retirementReleased(registryRootDir: string, jobId: string): boolean {
  try { return observeJobRetirement(registryRootDir, jobId) !== undefined; } catch { return false; }
}

export async function prepareCodexProjectScopedAdmission(
  input: CodexProjectScopedAdmissionInput,
): Promise<ProjectAdmissionScopedContext> {
  let summaries: readonly CodexGoalJobSummary[];
  try {
    summaries = await input.deps.listJobs({
      registryRootDir: input.registryRootDir,
    });
  } catch (error) {
    const safetyDebt: ProjectDebtItem[] = [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: resolve(input.registryRootDir),
      severity: "blocking",
      evidence: [
        `control registry listing failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }];
    return {
      target: {},
      safetyDebt,
      scope: "project",
      backlog: { count: 0, preview: [] },
    };
  }
  try {
    await assertAdmissionRegistryComplete({
      registryRootDir: input.registryRootDir,
      ...(input.controllerJobId === undefined ? {} : { controllerJobId: input.controllerJobId }),
      scope: input.scope,
      request: input.request,
      ...(input.targetBinding === undefined ? {} : { binding: input.targetBinding }),
      summaries,
    });
  } catch (error) {
    const safetyDebt: ProjectDebtItem[] = [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: resolve(input.registryRootDir),
      severity: "blocking",
      evidence: [
        `control registry census failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }];
    return {
      target: {},
      safetyDebt,
      scope: "project",
      backlog: { count: 0, preview: [] },
    };
  }
  const target = await targetIdentity(input, summaries);
  const census = await collectWriterCensus({
    ...input,
    summaries,
    target,
  });
  const overlaps = census.filter((entry) =>
    writerPotentiallyOverlapsTarget(entry, target)
  );
  const historicalDisjoint = new Set<ProjectDebtItem>();
  for (const item of input.snapshot.debt) {
    if (await historicalDebtIsPhysicallyUnrelated(item, target, census, input.request.jobId, async entry => {
      if (!input.deps.readJob || !input.deps.readWriterWritableRoots) return false;
      try {
        const current = await input.deps.readJob({ registryRootDir: input.registryRootDir, jobId: entry.jobId });
        if (!isDeepStrictEqual(current, entry.manifest)) return false;
        if (retirementReleased(input.registryRootDir, entry.jobId)) return entry.authority === "released";
        const observed = await input.deps.readWriterWritableRoots(current);
        return observed.status === entry.authority && (observed.status === "released" ||
          observed.status === "allocated" && isDeepStrictEqual(observed.roots, entry.writableRoots));
      } catch { return false; }
    })) historicalDisjoint.add(item);
  }
  // Owner/history reads may change a target or its future ancestor backing.
  // Reobserve through the same kernel-backed projection before returning proof.
  const currentBackings = await Promise.all((target.writableRoots ?? []).map(prospectiveAdmissionResourceBacking));
  const targetCurrent = currentBackings.every((roots) => roots !== undefined) &&
    isDeepStrictEqual(currentBackings.flat(), target.physicalWritableRoots);
  const safetyDebt: ProjectDebtItem[] = [
    ...input.snapshot.debt.filter((item) => !historicalDisjoint.has(item) &&
      isTargetSafetyDebt(item, input.request, target, overlaps, input.registryRootDir)
    ),
    // Allocated claims block before a provider has published any heartbeat.
    ...overlaps.map((entry) => writerDebt(entry, target)),
  ];
  const safetyKeys = new Set(safetyDebt.map(debtKey));
  const backlog = input.snapshot.debt.filter((item) => !safetyKeys.has(debtKey(item)));
  return {
    target: targetCurrent ? target : {},
    safetyDebt,
    scope: !targetCurrent ? "unknown" : safetyDebt.length > 0 ? "target" : backlog.length > 0 ? "unrelated_history" : "target",
    backlog: {
      count: backlog.length,
      preview: backlog.slice(0, MAX_BACKLOG_PREVIEW).map((item) => ({
        reason: item.reason,
        subject: item.subject.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240),
        severity: "info" as const,
        evidence: [],
      })),
    },
  };
}

async function targetIdentity(
  input: CodexProjectScopedAdmissionInput,
  summaries: readonly CodexGoalJobSummary[],
): Promise<ProjectAdmissionScopedContext["target"]> {
  const binding = input.targetBinding;
  let canonicalPath: string | undefined;
  if (binding?.start && input.request.operation === ProjectOperation.StartWorker) {
    const self = await admissionStartSelfIdentity({
      registryRootDir: input.registryRootDir,
      ...(input.controllerJobId === undefined ? {} : { controllerJobId: input.controllerJobId }),
      scope: input.scope,
      request: input.request,
      binding,
      summaries,
      overviewItems: await input.deps.buildOverviewItems([{
        registryRootDir: input.registryRootDir,
        jobId: binding.start.manifest.jobId,
        staleAfterMs: 10 * 60_000,
        tailLines: 0,
      }]),
    });
    canonicalPath = self?.workspacePath;
  } else if (binding?.createWorktree && input.request.operation === ProjectOperation.CreateWorktree) {
    canonicalPath = await admissionCreationTargetIdentity({
      registryRootDir: input.registryRootDir,
      ...(input.controllerJobId === undefined ? {} : { controllerJobId: input.controllerJobId }),
      scope: input.scope,
      request: input.request,
      binding,
    });
  }
  if (binding?.createManifest && input.request.operation === ProjectOperation.CreateJob) {
    canonicalPath = await admissionCreateJobTargetIdentity({
      registryRootDir: input.registryRootDir,
      ...(input.controllerJobId === undefined ? {} : { controllerJobId: input.controllerJobId }),
      scope: input.scope,
      request: input.request,
      binding,
    });
  }
  if (!canonicalPath) return {};
  const manifest = input.request.operation === ProjectOperation.StartWorker
    ? binding?.start?.manifest
    : input.request.operation === ProjectOperation.CreateJob ? binding?.createManifest : undefined;
  const resources = manifest ? [
    canonicalPath,
    manifest.jobRootDir,
    ...(manifest.stateRootDir ? [manifest.stateRootDir] : []),
    ...(manifest.outputPath ? [manifest.outputPath] : []),
    ...(manifest.progressPath ? [manifest.progressPath] : []),
  ] : [canonicalPath];
  const physicalResources = await Promise.all(resources.map(prospectiveAdmissionResourcePath));
  if (physicalResources.some((root) => root === undefined)) return {};
  const writableRoots = [...new Set(physicalResources as string[])];
  const backings = await Promise.all(writableRoots.map(prospectiveAdmissionResourceBacking));
  if (backings.some(root => root === undefined)) return {};
  const physicalWritableRoots = backings.filter(
    (roots): roots is readonly ProjectAdmissionPhysicalRoot[] => roots !== undefined,
  ).flat();
  const ownedPaths = binding?.createWorktree?.ownedPaths ??
    (input.request.ownedPaths?.length ? input.request.ownedPaths : undefined);
  return {
    canonicalPath,
    writableRoots,
    physicalWritableRoots,
    ...(ownedPaths ? { ownedPaths: [...ownedPaths] } : {}),
  };
}

async function collectWriterCensus(
  input: CodexProjectScopedAdmissionInput & {
    readonly summaries: readonly CodexGoalJobSummary[];
    readonly target: ProjectAdmissionScopedContext["target"];
  },
): Promise<readonly WriterCensusEntry[]> {
  const entries: WriterCensusEntry[] = [];
  for (const summary of input.summaries) {
    if (input.target.canonicalPath && isSelfSummary(summary, input.request, input.targetBinding)) continue;
    let manifest: CodexGoalJobManifest | undefined;
    if (input.deps.readJob) {
      try {
        manifest = await input.deps.readJob({
          registryRootDir: input.registryRootDir,
          jobId: summary.jobId,
        });
      } catch {
        entries.push({
          jobId: summary.jobId,
          workspacePath: summary.workspacePath,
          authority: "unknown",
        });
        continue;
      }
    }
    if (manifest && retirementReleased(input.registryRootDir, summary.jobId)) {
      entries.push({ manifest, jobId: summary.jobId, workspacePath: summary.workspacePath, authority: "released" });
      continue;
    }
    const canonicalWorkspacePath = await optionalRealPathForAdmission(
      summary.workspacePath,
    );
    let writableRoots: readonly ProjectAdmissionPhysicalRoot[] | undefined;
    let authority: WriterAuthority = "unknown";
    if (manifest && input.deps.readWriterWritableRoots) {
      try {
        const observed = await input.deps.readWriterWritableRoots(manifest);
        if (observed.status === "released") authority = "released";
        else if (observed.status === "allocated" && observed.roots.length > 0 &&
          observed.roots.every(root => /^\d+:\d+$/.test(root.device) && isAbsolute(root.backingPath) &&
            resolve(root.backingPath) === root.backingPath && !/[\x00-\x1f\x7f]/.test(root.backingPath))) {
          writableRoots = [...observed.roots]; authority = "allocated";
        }
      } catch {
        // EACCES, missing grants, corrupt owner state and unavailable observation
        // remain unknown. A workspace realpath cannot replace confinement proof.
      }
    }
    entries.push({
      ...(manifest ? { manifest } : {}),
      jobId: summary.jobId,
      workspacePath: summary.workspacePath,
      ...(canonicalWorkspacePath ? { canonicalWorkspacePath } : {}),
      ...(writableRoots === undefined ? {} : { writableRoots }),
      authority,
    });
  }
  return entries;
}

function isSelfSummary(
  summary: CodexGoalJobSummary,
  request: ProjectAdmissionRequest,
  binding: ProjectAdmissionTargetBinding | undefined,
): boolean {
  return summary.jobId === request.jobId && (
    (request.operation === ProjectOperation.StartWorker && binding?.start?.manifest.jobId === summary.jobId) ||
    (request.operation === ProjectOperation.CreateJob && binding?.createManifest?.jobId === summary.jobId)
  );
}

function writerPotentiallyOverlapsTarget(
  entry: WriterCensusEntry,
  target: ProjectAdmissionScopedContext["target"],
): boolean {
  if (entry.authority === "released") return false;
  if (!target.physicalWritableRoots?.length || entry.authority === "unknown") return true;
  return entry.writableRoots!.some(root => target.physicalWritableRoots!.some(targetRoot =>
    root.device === targetRoot.device && pathsOverlap(root.backingPath, targetRoot.backingPath)
  ));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathInsideOrEqual(left, right) || pathInsideOrEqual(right, left);
}

function isTargetSafetyDebt(
  item: ProjectDebtItem,
  request: ProjectAdmissionRequest,
  target: ProjectAdmissionScopedContext["target"],
  overlaps: readonly WriterCensusEntry[],
  registryRootDir: string,
): boolean {
  // An unclassified control/evidence read failure cannot be proven unrelated
  // from its lexical path. Configured ledgers may live outside the registry.
  if (item.scope === ProjectDebtScope.ControlState) return true;
  if (item.severity === "info") return false;
  if (
    item.reason === ProjectDebtReason.DiskPressure ||
    item.reason === ProjectDebtReason.SnapshotStale ||
    item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord ||
    item.reason === ProjectDebtReason.RetentionEvidenceMissing ||
    item.reason === ProjectDebtReason.LegacyOutputQuarantineRequired
  ) {
    return true;
  }
  if (item.subject === request.jobId) return true;
  const subject = safePath(item.subject);
  const targetPath = target.canonicalPath;
  const registryPath = resolve(registryRootDir);
  if (item.reason === ProjectDebtReason.UnreadableRoot) {
    return !subject || pathsOverlap(subject, registryPath) ||
      (targetPath !== undefined && pathsOverlap(subject, targetPath));
  }
  if (subject && (target.writableRoots ?? (targetPath ? [targetPath] : []))
    .some((root) => pathsOverlap(subject, root))) return true;
  return overlaps.some((entry) =>
    item.subject === entry.jobId ||
    (subject !== undefined &&
      (entry.canonicalWorkspacePath ?? resolve(entry.workspacePath)) === subject)
  );
}

function writerDebt(
  entry: WriterCensusEntry,
  target: ProjectAdmissionScopedContext["target"],
): ProjectDebtItem {
  return {
    reason: ProjectDebtReason.ActiveWriterConflict,
    subject: entry.jobId,
    severity: "blocking",
    ...(target.ownedPaths ? { affectedPaths: [...target.ownedPaths] } : {}),
    evidence: [
      entry.authority === "allocated"
        ? `allocated writer overlaps target: ${entry.jobId}`
        : `unknown writer authority for ${entry.jobId}`,
      `workspace=${entry.workspacePath}`,
    ],
  };
}

function safePath(value: string): string | undefined {
  return value.length > 0 && !value.includes("\u0000") ? resolve(value) : undefined;
}

function debtKey(item: ProjectDebtItem): string {
  return JSON.stringify([
    item.reason,
    item.subject,
    item.severity ?? "blocking",
    [...item.evidence].sort(),
    item.affectedPaths ? [...item.affectedPaths].sort() : null,
    item.pathDisjointProducerEligible ?? null,
    item.scope ?? null,
    item.retainedOutput ?? null,
  ]);
}
