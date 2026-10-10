import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectControlAuditEventType, ProjectDebtReason, ProjectOperation, recordTerminalOutputDecision, type ProjectControlBrokerPorts } from "@vioxen/subscription-runtime/worker-core";
import { RunEventProjectionService, RunEventProviderKind, type RunObservationSnapshot } from "@vioxen/subscription-runtime/worker-core";
import { LocalFileRunEventStore, LocalFileRunEventProjectionStateStore } from "@vioxen/subscription-runtime/store-local-file";
import { runEventRootFromArgs } from "../codex-goal-mcp-inputs";
import { LocalConsumedOutputLedgerWriter } from "@vioxen/subscription-runtime/worker-local";
import * as goalOps from "../codex-goal-ops";
import { authorizeProjectPreStartAdmissionLaunch } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import { resolveProjectControlledRuntimeInPlaceContinuation } from "../application/project-control/codex-goal-project-in-place-continuation";
import { readVerifiedProducerHandoff } from "../application/project-control/codex-goal-project-verifier-handoff";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import { codexGoalJobToArgs, createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob, type CodexGoalJobManifest, type CodexGoalJobSummary } from "../codex-goal-jobs";
import { createCodexProjectControlBroker } from "../codex-goal-mcp-project-broker";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "../codex-goal-project-workspace-lock";
import { assertAdmissionRegistryComplete, revalidateAdmissionCreatedWorktree } from "../application/project-control/codex-goal-project-admission-target";
import { recordRejectedUncapturedOutput } from "../codex-goal-mcp-project-control-reviewed-rejection";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { assertProjectControlCustodyScopeCanonical } from "../codex-goal-mcp-project-scope";
import { assertProjectPreStartAdmissionLaunchBinding, planProjectPreStartAdmission, prepareProjectPreStartAdmission } from "../application/project-control/codex-goal-project-pre-start-admission";
import { validateProjectRefillPreStartAdmission } from "../application/project-control/codex-goal-project-refill-admission";
import { cleanupProjectPreStartAdmissionFixtures, createBuiltinFixture, declarativeContract } from "./codex-goal-project-pre-start-admission-fixture";
import {
  buildCodexProjectAdmissionSnapshot, codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupProjectPreStartAdmissionFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: {
  separateJobRoot?: boolean;
  jobRootParent?: string;
  jobRootName?: string;
  jobsParentAlias?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "retained-disjoint-admission-"));
  roots.push(root);
  const workspacePath = join(root, "historical");
  const requestedWorkspace = join(root, "isolated");
  for (const path of [workspacePath, requestedWorkspace]) {
    await mkdir(path);
    await exec("git", ["init", "-b", "main", path]);
    await exec("git", ["-C", path, "config", "user.name", "Synthetic Test"]);
    await exec("git", ["-C", path, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(path, "held.txt"), "base\n");
    await exec("git", ["-C", path, "add", "held.txt"]);
    await exec("git", ["-C", path, "commit", "-m", "test: synthetic base"]);
  }
  const registryRootDir = join(root, "registry");
  if (options.jobsParentAlias) await symlink(options.jobsParentAlias, join(root, "jobs"));
  const jobRootDir = join(options.jobRootParent ?? (options.separateJobRoot ? join(root, "jobs") : registryRootDir), options.jobRootName ?? "project-history");
  await mkdir(jobRootDir, { recursive: true });
  await writeFile(join(workspacePath, "held.txt"), "retained change\n");
  await writeFile(join(workspacePath, "untracked.txt"), "retained addition\n");
  let manifest: CodexGoalJobManifest = {
    schemaVersion: 1, jobId: "project-history", taskId: "task-history",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    workspacePath, jobRootDir, promptPath: join(jobRootDir, "prompt.md"), accounts: ["synthetic-account"],
    tags: ["worker-role-producer"],
  };
  if (options.separateJobRoot) manifest = await createCodexGoalJob({ registryRootDir, manifest });
  const handoff = await materializeCodexGoalHandoffArtifacts({
    workerJobId: manifest.jobId, taskId: manifest.taskId, workspacePath, jobRootDir,
  });
  if (!handoff) throw new Error("synthetic dirty output required");
  const resultPath = join(jobRootDir, `${manifest.taskId}.latest-result.json`);
  const result = {
    status: "done", changedFiles: handoff.changedPaths, evidence: [], blockers: [],
    nextAction: "review_completed", artifacts: handoff.artifacts,
    details: { baseCommit: handoff.baseCommit },
  };
  await writeFile(resultPath, JSON.stringify(result));
  const summary = {
    jobId: manifest.jobId, taskId: manifest.taskId, tags: manifest.tags ?? [],
    workspacePath, promptPath: manifest.promptPath, accountNames: [],
    updatedAt: manifest.updatedAt, manifestPath: join(registryRootDir, manifest.jobId, "job.json"),
  };
  if (!options.separateJobRoot) await writeFile(summary.manifestPath, JSON.stringify(manifest));
  const item: Record<string, unknown> = {
    ok: true, jobId: manifest.jobId, workspacePath, workspaceDirty: true,
    workerAlive: false, workerProcessAlive: false, progressProcessAlive: false,
    activeWriterRisk: "dirty_workspace_without_worker", resultExists: true,
    resultStatus: "done", changedFiles: handoff.changedPaths,
  };
  const summaries: CodexGoalJobSummary[] = [summary];
  const items = [item];
  // This injected policy fixture explicitly declares released retained owners.
  // Exact snapshots keep new identities and manifest drift Unknown; native
  // executor/owner qualification is exercised by the dedicated owner tests.
  const releasedWriters = new Map<string, CodexGoalJobManifest>();
  function releaseSyntheticWriter(manifest: CodexGoalJobManifest) {
    releasedWriters.set(manifest.jobId, structuredClone(manifest));
  }
  releaseSyntheticWriter(manifest);
  const deps: CodexProjectAdmissionDeps = {
    listJobs: async () => summaries,
    buildOverviewItems: async () => items,
    readJob: readCodexGoalJob,
    readWriterWritableRoots: async (current) =>
      isDeepStrictEqual(releasedWriters.get(current.jobId), current)
        ? { status: "released" } : { status: "unknown" },
  };
  const input = { registryRootDir, scope: { projectId: "project", jobIdPrefixes: ["project-"] }, deps };
  const gate = codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" });
  const request = { operation: ProjectOperation.StartWorker, workspacePath: requestedWorkspace, ownedPaths: ["new/"] };
  return { root, workspacePath, manifest, summary, summaries, item, items, handoff, result, resultPath, input, gate, request, releaseSyntheticWriter };
}

describe("retained terminal output path-disjoint admission", () => {
  it.each(["siblings", "nested"] as const)("recognizes both officially published configured ledgers in either root order (layout=%s)", async (layout) => {
    const f = await fixture();
    const container = join(f.input.registryRootDir, "consumed-output");
    const evidenceRoot = join(container, "archives");
    const firstRoot = join(container, "ledger-one");
    const secondRoot = layout === "nested" ? join(firstRoot, "second-ledger") : join(container, "ledger-two");
    for (const root of [firstRoot, secondRoot]) await mkdir(join(root, "items"), { recursive: true, mode: 0o700 });
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const secondJobRoot = join(f.input.registryRootDir, "project-second-consumed");
    const second = await createCodexGoalJob({ registryRootDir: f.input.registryRootDir,
      manifest: { ...f.manifest, jobId: "project-second-consumed", taskId: "task-second-consumed",
        jobRootDir: secondJobRoot, promptPath: join(secondJobRoot, "prompt.md") } });
    const receipts = [];
    for (const [ledgerRoot, manifest] of [[firstRoot, f.manifest], [secondRoot, second]] as const) {
      // Each official producer requires one root; only the subsequent original
      // reader/admission combines the independently published distinct job IDs.
      receipts.push(await recordRejectedUncapturedOutput({
        scope: { ...f.input.scope, consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot] },
        custodyRoot: f.root, jobId: manifest.jobId, jobRootDir: manifest.jobRootDir,
        workspacePath: manifest.workspacePath, closedAt: "2026-10-02T00:00:00.000Z", reason: "TEST rejected output" }));
    }
    // Publish the native job.json collision through the original ledger writer
    // in the SECOND root, so its item exception cannot accidentally use root one.
    const { attemptId, ...nativeDecision } = receipts[1]!.decision;
    void attemptId;
    const native = await recordTerminalOutputDecision({
      writer: new LocalConsumedOutputLedgerWriter(undefined, f.root, [evidenceRoot]),
    }, { allowedLedgerRoots: [secondRoot], ledgerRoot: secondRoot,
      decision: { ...nativeDecision, jobId: "job" } });
    expect(native.ledgerPath).toBe(join(secondRoot, "items", "job.json"));
    const summaries = await listCodexGoalJobs({ registryRootDir: f.input.registryRootDir });
    const before = await Promise.all(receipts.map((receipt) => readFile(receipt.ledgerPath)));
    for (const roots of [[firstRoot, secondRoot], [secondRoot, firstRoot]]) {
      const scope = { ...f.input.scope, registryRoot: f.input.registryRootDir, readRoots: [f.root], consumedOutputLedgerRoots: roots, consumedOutputEvidenceRoots: [evidenceRoot] };
      await assertProjectControlCustodyScopeCanonical(scope);
      const ledger = await readCodexGoalConsumedOutputLedgers({ roots, evidenceRoots: [evidenceRoot] });
      expect(ledger.byJobId.get(f.manifest.jobId)?.valid).toBe(true);
      expect(ledger.byJobId.get(second.jobId)?.valid).toBe(true);
      expect(ledger.byJobId.get("job")?.valid).toBe(true);
      await expect(assertAdmissionRegistryComplete({ ...f.input, scope, summaries })).resolves.toBeUndefined();
    }
    expect(await Promise.all(receipts.map((receipt) => readFile(receipt.ledgerPath)))).toEqual(before);
    await mkdir(join(container, "unknown-third-job"));
    for (const roots of [[firstRoot, secondRoot], [secondRoot, firstRoot]]) {
      await expect(assertAdmissionRegistryComplete({ ...f.input, summaries,
        scope: { ...f.input.scope, consumedOutputLedgerRoots: roots, consumedOutputEvidenceRoots: [evidenceRoot] } })).rejects.toThrow("unregistered consumed-output entry");
    }
  });

  it.each(["direct", "direct-custom", "nested", "deep", "nested-evidence"] as const)("admits the configured registry ledger produced by the official mark_reviewed writer (layout=%s)", async (layout) => {
    const f = await fixture();
    const container = join(f.input.registryRootDir, layout === "direct-custom" ? "configured-review-ledger" : "consumed-output");
    const direct = layout === "direct" || layout === "direct-custom";
    const ledgerRoot = direct ? container : layout === "deep" ? join(container, "retained", "ledger") : join(container, "ledger");
    const evidenceRoot = direct ? join(f.root, "archives") : layout === "nested-evidence" ? join(ledgerRoot, "archives") : layout === "deep" ? join(container, "retained", "archives") : join(container, "archives");
    await mkdir(join(ledgerRoot, "items"), { recursive: true, mode: 0o700 });
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const scope = { ...f.input.scope, registryRoot: f.input.registryRootDir, readRoots: [f.root],
      consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot] };
    await assertProjectControlCustodyScopeCanonical(scope);
    // The production mark_reviewed path invokes this producer for uncaptured
    // rejected output. Use its real retained backup and ledger publication.
    const receipt = await recordRejectedUncapturedOutput({ scope, custodyRoot: f.root,
      jobId: f.manifest.jobId, jobRootDir: f.manifest.jobRootDir,
      workspacePath: f.workspacePath, closedAt: "2026-10-02T00:00:00.000Z", reason: "TEST rejected output" });
    const before = await readFile(receipt.ledgerPath);
    expect(JSON.parse(before.toString())).toMatchObject({ schemaVersion: 1, jobId: f.manifest.jobId, status: "rejected" });
    const input = { ...f.input, scope };
    const snapshot = await buildCodexProjectAdmissionSnapshot({ ...input, requestedWorkspacePath: f.request.workspacePath });
    expect(snapshot.debt.some((debt) => debt.reason === ProjectDebtReason.UnreadableRoot)).toBe(false);
    await expect(codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" }).evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    expect(await readFile(receipt.ledgerPath)).toEqual(before);
    if (layout === "deep") {
      const unknown = join(container, "retained", "unknown-worker");
      await mkdir(unknown);
      await expect(codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
      await rmdir(unknown);
    }
    const hidden = join(ledgerRoot, "nested-unregistered-job");
    await mkdir(hidden);
    await writeFile(join(hidden, "job.json"), "{}");
    await expect(assertAdmissionRegistryComplete({ ...input,
      summaries: await listCodexGoalJobs({ registryRootDir: input.registryRootDir }) }))
      .rejects.toThrow("unregistered job inside consumed-output");
    await rm(hidden, { recursive: true });
    // Recognition of the container must never waive the original record parser.
    await writeFile(receipt.ledgerPath, "{malformed TEST record");
    await expect(codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each(["wrong-scope", "root-symlink", "items-symlink", "unknown-directory", "unknown-sibling", "unconfigured-archive", "archive-symlink"] as const)("denies an untrusted registry ledger container: %s", async (fault) => {
    const f = await fixture();
    const container = join(f.input.registryRootDir, fault === "unknown-directory" ? "unknown-ledger" : "consumed-output");
    const ledgerRoot = join(container, "ledger");
    const outside = join(f.root, "outside-ledger");
    await mkdir(join(outside, "items"), { recursive: true });
    if (fault === "root-symlink") await symlink(outside, container);
    else {
      await mkdir(ledgerRoot, { recursive: true });
      if (fault === "items-symlink") await symlink(join(outside, "items"), join(ledgerRoot, "items"));
      else await mkdir(join(ledgerRoot, "items"));
      if (fault === "unknown-sibling") await mkdir(join(container, "unknown-job"));
      if (fault === "unconfigured-archive") await mkdir(join(container, "archives"));
      if (fault === "archive-symlink") await symlink(outside, join(container, "archives"));
    }
    const input = { ...f.input, scope: { ...f.input.scope,
      consumedOutputLedgerRoots: [fault === "wrong-scope" || fault === "unknown-directory" ? outside : ledgerRoot],
      ...(fault === "archive-symlink" ? { consumedOutputEvidenceRoots: [join(container, "archives")] } : {}) } };
    await expect(codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each([false, true])("admits an isolated producer and preserves retained output/debt (historical duplicates=%s)", async (duplicate) => {
    const f = await fixture();
    if (duplicate) {
      // Each historical identity has its own result and immutable handoff.
      const secondRoot = join(f.input.registryRootDir, "project-history-2");
      await mkdir(secondRoot);
      const secondManifest = { ...f.manifest, jobId: "project-history-2", jobRootDir: secondRoot, workspacePath: f.workspacePath };
      const h = await materializeCodexGoalHandoffArtifacts({ workerJobId: secondManifest.jobId, taskId: secondManifest.taskId, workspacePath: f.workspacePath, jobRootDir: secondRoot });
      if (!h) throw new Error("second handoff required");
      await writeFile(join(secondRoot, `${secondManifest.taskId}.latest-result.json`), JSON.stringify({ ...f.result, artifacts: h.artifacts, details: { baseCommit: h.baseCommit } }));
      f.summaries.push({ ...f.summary, jobId: secondManifest.jobId, manifestPath: join(secondRoot, "job.json") });
      f.items.push({ ...f.item, jobId: secondManifest.jobId });
      await writeFile(join(secondRoot, "job.json"), JSON.stringify(secondManifest));
      f.releaseSyntheticWriter(secondManifest);
    }
    const paths = [join(f.workspacePath, "held.txt"), join(f.workspacePath, "untracked.txt"), f.resultPath, f.handoff.manifestPath, f.handoff.patchPath, f.summary.manifestPath];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    expect(createHash("sha256").update(before[4]!).digest("hex")).toBe(f.handoff.manifest.artifacts.patch.sha256);
    expect(createHash("sha256").update(before[3]!).digest("hex")).toBe(f.handoff.artifacts.find((a) => a.kind === "manifest")?.sha256);
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    const snapshot = await buildCodexProjectAdmissionSnapshot({ ...f.input, requestedWorkspacePath: f.request.workspacePath });
    expect(snapshot.debt).toEqual(expect.arrayContaining([expect.objectContaining({ reason: ProjectDebtReason.UnconsumedCompletedJob, severity: "blocking", affectedPaths: ["held.txt", "untracked.txt"] })]));
    expect(snapshot.counts?.unconsumedCompletedJobs).toBe(duplicate ? 2 : 1);
    expect(snapshot.counts?.activeWriterConflicts).toBe(duplicate ? 2 : 1);
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
    await expect(f.gate.evaluate({ ...f.request, ownedPaths: ["held.txt"] })).resolves.toMatchObject({ allowed: false });
    await expect(f.gate.evaluate({ ...f.request, ownedPaths: ["untracked.txt"] })).resolves.toMatchObject({ allowed: false });
  });

  it("admits complete retained output from native separate registry/job roots and preserves custody fences", async () => {
    const f = await fixture({ separateJobRoot: true });
    expect(f.manifest.jobRootDir).toBe(join(f.root, "jobs", f.manifest.jobId));
    expect(f.summary.manifestPath).toBe(join(f.input.registryRootDir, f.manifest.jobId, "job.json"));
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    const snapshot = await buildCodexProjectAdmissionSnapshot({ ...f.input, requestedWorkspacePath: f.request.workspacePath });
    expect(snapshot.debt).toEqual(expect.arrayContaining([expect.objectContaining({
      reason: ProjectDebtReason.UnconsumedCompletedJob, affectedPaths: ["held.txt", "untracked.txt"],
    })]));
    await expect(f.gate.evaluate({ ...f.request, workspacePath: f.workspacePath })).resolves.toMatchObject({ allowed: false });
    Object.assign(f.item, { progressProcessAlive: undefined });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    Object.assign(f.item, { progressProcessAlive: false });
    const registered = await readFile(f.summary.manifestPath);
    await rm(f.summary.manifestPath);
    await symlink(join(f.root, "copied-job.json"), f.summary.manifestPath);
    await writeFile(join(f.root, "copied-job.json"), registered);
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each(["foreign prefix", "outside parent", "escaping parent alias"])("denies valid retained bytes under an untrusted native job root: %s", async (layout) => {
    const outside = await mkdtemp(join(tmpdir(), "retained-custody-outside-"));
    roots.push(outside);
    const f = await fixture({ separateJobRoot: true,
      ...(layout === "foreign prefix" ? { jobRootName: "foreign-history" } : {}),
      ...(layout === "outside parent" ? { jobRootParent: outside } : {}),
      ...(layout === "escaping parent alias" ? { jobsParentAlias: outside } : {}),
    });
    await expect(readVerifiedProducerHandoff({ producer: f.manifest })).resolves.toMatchObject({
      changedPaths: ["held.txt", "untracked.txt"],
    });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("requires native strict done evidence behind a legacy completed overview", async () => {
    const f = await fixture();
    Object.assign(f.item, { resultStatus: "completed", recommendedAction: "review_completed", lifecycleMarkerTypes: ["review"] });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    await writeFile(f.resultPath, JSON.stringify({ ...f.result, status: "completed" }));
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("keeps a shared historical workspace with any live or unknown participant fenced", async () => {
    const f = await fixture();
    f.summaries.push({ ...f.summary, jobId: "project-other-writer" });
    const other = { ...f.item, jobId: "project-other-writer", workerAlive: true, activeWriterRisk: "active_worker" };
    f.items.push(other);
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    Object.assign(other, { workerAlive: false, activeWriterRisk: "unknown" });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("checks requested identity against registry jobs outside the project prefix", async () => {
    const f = await fixture();
    f.summaries.push({ ...f.summary, jobId: "another-project-live", workspacePath: f.request.workspacePath });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each([false, true])("does not override existing terminal consumption integrity (own mismatched record=%s)", async (ownRecord) => {
    const f = await fixture();
    const ledgerRoot = join(f.root, "ledger");
    const retainedRoot = join(f.root, "retained");
    await mkdir(join(ledgerRoot, "items"), { recursive: true });
    await mkdir(retainedRoot);
    const jobId = ownRecord ? f.manifest.jobId : "project-consumed";
    await writeFile(join(ledgerRoot, "items", `${jobId}.json`), JSON.stringify({
      schemaVersion: 1, jobId, status: "rejected", note: "synthetic consumed output",
      closedAt: "2026-10-02T00:00:00.000Z", consumedAt: "2026-10-02T00:00:00.000Z",
      notes: [{ status: "rejected", text: "synthetic consumed output" }],
      backup: { workspace: ownRecord ? join(f.root, "mismatched") : f.workspacePath,
        statusPath: join(retainedRoot, "missing-status.txt"), patchPath: join(retainedRoot, "missing.patch") },
    }));
    const input = { ...f.input, scope: { ...f.input.scope,
      consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [retainedRoot] } };
    const snapshot = await buildCodexProjectAdmissionSnapshot({ ...input, requestedWorkspacePath: f.request.workspacePath });
    const conflict = snapshot.debt.find((d) => d.reason === ProjectDebtReason.ActiveWriterConflict);
    expect(conflict).toBeDefined();
    expect(conflict?.pathDisjointProducerEligible).toBeUndefined();
    await expect(codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("does not prove stopped history from a truncated registry observation", async () => {
    const f = await fixture();
    const previous = process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
    try {
      f.summaries.push({ ...f.summary, jobId: "project-older-unknown", updatedAt: "2026-09-01T00:00:00.000Z" });
      process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = "1";
      await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    } finally {
      if (previous === undefined) delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
      else process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = previous;
    }
  });

  it.each([
    ["live writer", { workerAlive: true, workerProcessAlive: true, activeWriterRisk: "active_worker" }],
    ["unknown process", { progressProcessAlive: undefined }],
    ["no stopped process proof", { workerProcessAlive: undefined }],
    ["state mismatch", { activeWriterRisk: "state_mismatch" }],
    ["unreadable overview", { ok: false }],
    ["failed dirty read", { workspaceDirty: false }],
    ["unknown result", { resultExists: false }],
    ["partial result", { resultStatus: "partial" }],
    ["unknown writer", { activeWriterRisk: "unknown" }],
    ["unexplained workspace conflict", { workspaceConflict: true }],
  ] as const)("denies %s", async (_name, mutation) => {
    const f = await fixture(); Object.assign(f.item, mutation);
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each(["missing patch", "malformed manifest", "partial retention", "missing result", "non-strict result", "partial native result", "source mismatch", "registry mismatch", "result hash mismatch", "changed bytes", "incomplete paths", "git unreadable"])("denies %s using fresh retained evidence", async (mutation) => {
    const f = await fixture();
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    if (mutation === "missing patch") await rm(f.handoff.patchPath);
    if (mutation === "malformed manifest") await writeFile(f.handoff.manifestPath, "{");
    if (mutation === "partial retention") await writeFile(f.handoff.patchPath, (await readFile(f.handoff.patchPath)).subarray(0, 20));
    if (mutation === "missing result") await rm(f.resultPath);
    if (mutation === "non-strict result") await writeFile(f.resultPath, JSON.stringify({ status: "done", artifacts: f.result.artifacts }));
    if (mutation === "partial native result") await writeFile(f.resultPath, JSON.stringify({ ...f.result, status: "partial" }));
    if (mutation === "source mismatch") await writeFile(f.summary.manifestPath, JSON.stringify({ ...f.manifest, workspacePath: f.request.workspacePath }));
    if (mutation === "registry mismatch") f.summary.manifestPath = join(f.root, "unowned-job.json");
    if (mutation === "result hash mismatch") await writeFile(f.resultPath, JSON.stringify({ ...f.result, artifacts: f.result.artifacts.map((a) => a.kind === "manifest" ? { ...a, sha256: "0".repeat(64) } : a) }));
    if (mutation === "changed bytes") await writeFile(join(f.workspacePath, "held.txt"), "after retention\n");
    if (mutation === "incomplete paths") await writeFile(join(f.workspacePath, "later.txt"), "not retained\n");
    if (mutation === "git unreadable") await rm(join(f.workspacePath, ".git"), { recursive: true });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("denies same realpath, missing requested identity, invalid ownership, and unreadable roots", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias"); await symlink(f.workspacePath, alias);
    for (const workspacePath of [f.workspacePath, alias, join(f.root, "missing")]) {
      await expect(f.gate.evaluate({ ...f.request, workspacePath })).resolves.toMatchObject({ allowed: false });
    }
    for (const ownedPaths of [[], ["../held.txt"], ["/held.txt"], ["new/", ""]]) {
      await expect(f.gate.evaluate({ ...f.request, ownedPaths })).resolves.toMatchObject({ allowed: false });
    }
    const noWorkspace = { operation: f.request.operation, ownedPaths: f.request.ownedPaths };
    await expect(f.gate.evaluate(noWorkspace)).resolves.toMatchObject({ allowed: false });
    const subdirectory = join(f.request.workspacePath, "nested"); await mkdir(subdirectory);
    await expect(f.gate.evaluate({ ...f.request, workspacePath: subdirectory })).resolves.toMatchObject({ allowed: false });
    const unreadable = join(f.root, "unreadable");
    await writeFile(unreadable, "not a directory\n");
    const gate = codexProjectAdmissionGate({ ...f.input, controllerJobId: "project-controller", scope: { ...f.input.scope, workspaceRoots: [unreadable] } });
    await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });
});

async function creationFixture() {
  const f = await fixture();
  const source = await realpath(f.request.workspacePath);
  const revision = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const target = { jobId: "project-next", sourceWorkspacePath: source,
    expectedSourceRealPath: source, expectedRevision: revision, sourceRevisionPinned: true,
    path: join(f.root, "future", "worker"), ownedPaths: ["new/"] };
  const scope = { ...f.input.scope, workspaceRoots: [f.root], worktreeRoots: [f.root] };
  const request = { operation: ProjectOperation.CreateWorktree, jobId: target.jobId,
    workspacePath: target.path, ownedPaths: target.ownedPaths };
  const input = { ...f.input, scope, controllerJobId: "project-controller", targetBinding: { createWorktree: target } };
  return { ...f, target, request, input, gate: codexProjectAdmissionGate(input) };
}

async function startFixture(options: { colocatedJobRoot?: boolean } = {}) {
  const f = await fixture();
  const prepared = await createBuiltinFixture();
  const scope = { ...f.input.scope, ...prepared.scope, workspaceRoots: [f.root, prepared.root] };
  const jobRootDir = join(options.colocatedJobRoot ? f.input.registryRootDir : join(f.root, "jobs"), "project-worker");
  await mkdir(jobRootDir, { recursive: true });
  const promptPath = join(jobRootDir, "prompt.md");
  await writeFile(promptPath, "bounded prompt\n");
  const manifestInput = { ...prepared.manifest, jobRootDir, promptPath,
    workspacePath: await realpath(prepared.workspacePath), authRootDir: join(f.root, "synthetic-auth"),
    projectAccessScope: { projectId: scope.projectId, isolatedWorkspaceRoot: await realpath(prepared.workspacePath),
      allowedAccountIds: ["account-a"], authRoot: join(f.root, "synthetic-auth") } };
  const plan = planProjectPreStartAdmission({
    value: { mode: "serial-builtin", contract: declarativeContract(prepared.contract) },
    confirmed: true, scope, manifest: manifestInput,
  })!;
  const createManifest = { ...manifestInput, projectPreStartAdmission: plan.descriptor };
  // Native refill order: prepare outside registry, broker publishes only its
  // registration, then the stored-manifest validator refreshes the receipt.
  await prepareProjectPreStartAdmission({ plan, manifest: createManifest, scope });
  const broker = createCodexProjectControlBroker({ controller: { ...f.manifest, jobId: "project-controller" },
    registryRootDir: f.input.registryRootDir, scope, admissionDeps: f.input.deps, createManifest });
  await broker.createJob({ jobId: createManifest.jobId, workspacePath: createManifest.workspacePath,
    ownedPaths: ["src/example.ts"] });
  const manifest = await readCodexGoalJob({ registryRootDir: f.input.registryRootDir, jobId: createManifest.jobId });
  await validateProjectRefillPreStartAdmission({ registryRootDir: f.input.registryRootDir,
    controllerJobId: "project-controller", manifest, scope,
    expectedCanonicalWorkspacePath: manifest.workspacePath, admittedInputPatch: false });
  const summary = (await listCodexGoalJobs({ registryRootDir: f.input.registryRootDir })).find((row) => row.jobId === manifest.jobId)!;
  f.summaries.push(summary);
  const item = { ...f.item, jobId: manifest.jobId, workspacePath: manifest.workspacePath,
    workspaceDirty: false, resultExists: false, resultStatus: undefined,
    activeWriterRisk: "none", changedFiles: [] };
  f.items.push(item);
  // The prepared self remains Unknown to the synthetic owner port. Only its
  // actual manifest/receipt/artifact shape and held lease establish the target.
  const launch = await goalLaunchInput({ ...codexGoalJobToArgs(manifest), cwd: f.root });
  const request = { operation: ProjectOperation.StartWorker, jobId: manifest.jobId,
    workspacePath: manifest.workspacePath, ownedPaths: ["src/example.ts"] };
  const input = { ...f.input, scope, controllerJobId: "project-controller" };
  const locks = projectControlWorkspaceLocks(f.input.registryRootDir);
  return { ...f, manifest, item, request, input, launch, locks,
    async withLease<T>(effect: (gate: ReturnType<typeof codexProjectAdmissionGate>, binding: NonNullable<Parameters<typeof codexProjectAdmissionGate>[0]["targetBinding"]>) => Promise<T>) {
      return withValidatedProjectWorkspaceLock({ locks, scope, requestedWorkspacePath: manifest.workspacePath,
        owner: `project-refill-start:project-controller:${manifest.jobId}`,
        effect: async (workspaceLease) => {
          const binding = { start: { manifest, launch, workspaceLease } };
          return effect(codexProjectAdmissionGate({ ...input, targetBinding: binding }), binding);
        },
      });
    },
  };
}

describe("operation-bound retained output admission", () => {
  it.each(["missing observation port", "unknown owner", "changed owner manifest"] as const)("keeps retained history fenced with %s", async (fault) => {
    const f = await creationFixture();
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    let deps = f.input.deps;
    if (fault === "missing observation port") {
      const { readWriterWritableRoots: _read, ...withoutObservation } = deps;
      deps = withoutObservation;
    }
    if (fault === "unknown owner") deps = { ...deps, readWriterWritableRoots: async () => ({ status: "unknown" }) };
    if (fault === "changed owner manifest") await writeFile(f.summary.manifestPath,
      JSON.stringify({ ...f.manifest, promptPath: join(f.manifest.jobRootDir, "changed-prompt.md") }));
    await expect(codexProjectAdmissionGate({ ...f.input, deps }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each(["outside scope", "changed scoped identity", "missing parent proof"])("retains the original admission identity across %s mutation races", async (mutation) => {
    const f = await creationFixture();
    await mkdir(join(f.root, "future"));
    const alternate = mutation === "outside scope" ? await mkdtemp(join(tmpdir(), "admission-outside-")) : join(f.root, "alternate");
    if (mutation === "outside scope") roots.push(alternate);
    else await mkdir(alternate);
    const broker = createCodexProjectControlBroker({ controller: { ...f.manifest, jobId: "project-controller" },
      registryRootDir: f.input.registryRootDir, scope: f.input.scope, admissionDeps: f.input.deps, createWorktreeInput: f.target });
    // The existing audit port observes the allowed decision before the native
    // workspace port runs. No production hook or fake Git result is involved.
    const ports = (broker as unknown as { ports: ProjectControlBrokerPorts }).ports;
    ports.audit!.record = async (event) => {
      if (event.type !== ProjectControlAuditEventType.AdmissionDecisionRecorded || !event.decision.allowed) return;
      await rm(join(f.root, "future"), { recursive: true });
      if (mutation === "missing parent proof") await writeFile(join(f.root, "future"), "not a directory");
      else await symlink(alternate, join(f.root, "future"));
    };
    await expect(broker.createWorktree(f.target)).rejects.toThrow("project_control_creation_admission_changed");
    await expect(lstat(join(alternate, "worker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a missing target through the actual broker without consuming disjoint retained output", async () => {
    const f = await creationFixture();
    const { targetBinding: _binding, ...unbound } = f.input;
    await expect(codexProjectAdmissionGate(unbound).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    const retained = await readFile(f.handoff.patchPath);
    const broker = createCodexProjectControlBroker({
      controller: { ...f.manifest, jobId: "project-controller" }, registryRootDir: f.input.registryRootDir,
      scope: f.input.scope, admissionDeps: f.input.deps, createWorktreeInput: f.target,
    });
    await broker.createWorktree(f.target);
    expect((await exec("git", ["-C", f.target.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(f.target.expectedRevision);
    expect(await readFile(f.handoff.patchPath)).toEqual(retained);
    await expect(f.gate.evaluate({ ...f.request, ownedPaths: ["held.txt"] })).resolves.toMatchObject({ allowed: false });
  });

  it("proves an absent scoped worktree root without granting its existing ancestor workspace authority", async () => {
    const f = await creationFixture();
    const worktreeRoot = join(f.root, "future");
    const scope = { ...f.input.scope, workspaceRoots: [f.target.sourceWorkspacePath], worktreeRoots: [worktreeRoot] };
    const gate = codexProjectAdmissionGate({ ...f.input, scope });
    await expect(lstat(worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    const sibling = { ...f.target, path: join(f.root, "outside-scoped-root", "project-child") };
    await expect(codexProjectAdmissionGate({ ...f.input, scope, targetBinding: { createWorktree: sibling } })
      .evaluate({ ...f.request, workspacePath: sibling.path })).resolves.toMatchObject({ allowed: false });
    const broker = createCodexProjectControlBroker({ registryRootDir: f.input.registryRootDir,
      controller: { ...f.manifest, jobId: "project-controller" }, scope,
      admissionDeps: f.input.deps, createWorktreeInput: f.target });
    await expect(broker.createWorktree(f.target)).resolves.toMatchObject({ status: "applied" });
    expect(await realpath(f.target.path)).toBe(join(await realpath(worktreeRoot), "worker"));
    expect((await exec("git", ["-C", f.target.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(f.target.expectedRevision);
  });

  it.each(["source identity", "source SHA", "scope", "request ownership", "expected target identity"])("denies an unproved future target: %s", async (mutation) => {
    const f = await creationFixture();
    const target = { ...f.target };
    if (mutation === "source identity") target.expectedSourceRealPath = f.workspacePath;
    if (mutation === "source SHA") target.expectedRevision = "0".repeat(40);
    const input = { ...f.input, targetBinding: { createWorktree: { ...target,
      ...(mutation === "expected target identity" ? { expectedRealPath: f.workspacePath } : {}) } },
      ...(mutation === "scope" ? { scope: { ...f.input.scope, workspaceRoots: [target.sourceWorkspacePath], worktreeRoots: [] } } : {}) };
    const request = { ...f.request, ...(mutation === "request ownership" ? { ownedPaths: ["held.txt"] } : {}) };
    await expect(codexProjectAdmissionGate(input).evaluate(request)).resolves.toMatchObject({ allowed: false });
  });

  it("revalidates the materialized canonical Git root and pinned HEAD", async () => {
    const f = await creationFixture();
    await mkdir(join(f.root, "future"));
    await exec("git", ["-C", f.target.sourceWorkspacePath, "worktree", "add", "--detach", f.target.path, f.target.expectedRevision]);
    const input = { expectedIdentity: await realpath(f.target.path), target: f.target, scope: f.input.scope };
    await expect(revalidateAdmissionCreatedWorktree(input)).resolves.toBeUndefined();
    await writeFile(join(f.target.path, "next.txt"), "next\n");
    await exec("git", ["-C", f.target.path, "add", "next.txt"]);
    await exec("git", ["-C", f.target.path, "commit", "-m", "test: changed synthetic target"]);
    await expect(revalidateAdmissionCreatedWorktree(input)).rejects.toThrow("project_control_created_admission_target_changed");
  });

  it("admits only its exact registered prepared self while the native lease is held", async () => {
    const f = await startFixture();
    await expect(codexProjectAdmissionGate(f.input).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    await f.withLease(async (gate, binding) => {
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
      await expect(gate.evaluate({ ...f.request, ownedPaths: ["held.txt"] })).resolves.toMatchObject({ allowed: false });
      await f.locks.release(binding.start!.workspaceLease.lease);
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    });
  });

  it("allows unknown optional process fields only for a native never-launched target", async () => {
    const f = await startFixture();
    Object.assign(f.item, { workerProcessAlive: undefined, progressProcessAlive: undefined, progressExists: false, workerSupervisorKind: "none" });
    await f.withLease(async (gate) => {
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
      await writeFile(f.launch.config.progressPath!, JSON.stringify({ status: "running", pid: 999999 }));
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    });
  });

  it.each(["progress", "log", "state"] as const)("fences false/false stopped self with native %s artifacts and a valid receipt", async (artifact) => {
    const f = await startFixture();
    const receipt = await readFile(f.manifest.projectPreStartAdmission!.receiptPath);
    const bindingBefore = await assertProjectPreStartAdmissionLaunchBinding({ manifest: f.manifest, scope: f.input.scope });
    expect(f.item).toMatchObject({ workerProcessAlive: false, progressProcessAlive: false,
      workspaceDirty: false, resultExists: false, activeWriterRisk: "none" });
    await f.withLease(async (gate) => {
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
      if (artifact === "progress") await writeFile(f.launch.config.progressPath!, JSON.stringify({
        taskId: f.manifest.taskId, status: "running", pid: 999999,
      }));
      if (artifact === "log") await writeFile(f.launch.logPath!, "previous attempt stopped\n");
      if (artifact === "state") {
        const root = f.launch.config.stateRootDir ?? join(f.manifest.jobRootDir, "state");
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "previous-attempt.json"), JSON.stringify({ taskId: f.manifest.taskId, attemptNumber: 1 }));
      }
      // Receipt/Git binding can remain valid after native launch rollback.
      await expect(assertProjectPreStartAdmissionLaunchBinding({ manifest: f.manifest, scope: f.input.scope })).resolves.toEqual(bindingBefore);
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    });
    expect(await readFile(f.manifest.projectPreStartAdmission!.receiptPath)).toEqual(receipt);
  });

  it.each(["progressPid", "workerSupervisorKind", "attemptNumber"])("fences unknown process observation with prior %s", async (field) => {
    const f = await startFixture();
    Object.assign(f.item, { workerProcessAlive: undefined, progressProcessAlive: undefined,
      [field]: field === "workerSupervisorKind" ? "direct" : 12345 });
    await f.withLease(async (gate) => {
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    });
  });

  it.each(["jobId", "jobRootDir", "promptPath"] as const)("binds launch %s before admission exemption and any launch effect", async (field) => {
    const f = await startFixture();
    const receiptBefore = await readFile(f.manifest.projectPreStartAdmission!.receiptPath);
    const supervisor = vi.spyOn(goalOps, "startCodexGoalTmux").mockImplementation(async () => { throw new Error("synthetic_supervisor_must_not_be_reached"); });
    await f.withLease(async (_gate, binding) => {
      const launch = { ...f.launch, config: { ...f.launch.config,
        [field]: field === "jobId" ? "project-foreign" : join(f.root, "foreign") } };
      const targetBinding = { start: { ...binding.start!, launch } };
      await expect(codexProjectAdmissionGate({ ...f.input, targetBinding }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
      Object.assign(f.items[0]!, { workspaceDirty: false, resultExists: false, activeWriterRisk: "none" });
      const broker = createCodexProjectControlBroker({ controller: { ...f.manifest, jobId: "project-controller" },
        registryRootDir: f.input.registryRootDir, scope: f.input.scope, admissionDeps: f.input.deps,
        startManifest: f.manifest, startLaunch: launch, startWorkspaceLease: binding.start!.workspaceLease, startSkipDoctor: true });
      await expect(broker.startWorker(f.request)).rejects.toThrow("project_control_start_launch_identity_mismatch");
      expect(supervisor).not.toHaveBeenCalled();
    });
    expect(await readFile(f.manifest.projectPreStartAdmission!.receiptPath)).toEqual(receiptBefore);
  });

  it("admits an exact native interrupted continuation beside complete stopped retained output", async () => {
    const f = await startFixture();
    await authorizeProjectPreStartAdmissionLaunch({ manifest: f.manifest, scope: f.input.scope });
    await mkdir(join(f.manifest.workspacePath, "src"));
    await writeFile(join(f.manifest.workspacePath, "src", "example.ts"), "export const resumed = true;\n");
    const handoff = await materializeCodexGoalHandoffArtifacts({ workerJobId: f.manifest.jobId,
      taskId: f.manifest.taskId, workspacePath: f.manifest.workspacePath, jobRootDir: f.manifest.jobRootDir });
    if (!handoff) throw new Error("native interrupted handoff required");
    await writeFile(f.launch.config.outputPath!, JSON.stringify({ schemaVersion: 1, taskId: f.manifest.taskId,
      status: "partial", reason: "account_unavailable", updatedAt: "2026-10-01T00:00:00.000Z",
      changedFiles: handoff.changedPaths, evidence: ["safe_execution_status:partial"], blockers: ["account_unavailable"],
      nextAction: "switch_account", artifacts: handoff.artifacts }));
    const continuation = await resolveProjectControlledRuntimeInPlaceContinuation({ manifest: f.manifest, scope: f.input.scope,
      workspacePath: f.manifest.workspacePath, cause: { kind: "capacity", failureReason: "account_unavailable" } });
    Object.assign(f.item, { workspaceDirty: true, resultExists: true, resultStatus: "partial", activeWriterRisk: "dirty_workspace_without_worker",
      activeWriterRiskReasons: ["dirty_workspace_without_worker"], changedFiles: handoff.changedPaths });
    const retainedBefore = await readFile(f.handoff.patchPath);
    await f.withLease(async (_gate, binding) => {
      const input = { ...f.input, targetBinding: { start: { ...binding.start!, continuation } },
        inPlaceContinuationTarget: { jobId: f.manifest.jobId, workspacePath: f.manifest.workspacePath, ownedPaths: continuation.ownedPaths } };
      const gate = codexProjectAdmissionGate(input);
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
      await expect(gate.evaluate({ ...f.request, ownedPaths: ["src/"] })).resolves.toMatchObject({ allowed: false });
      await writeFile(join(f.manifest.workspacePath, "src", "example.ts"), "changed generation\n");
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    });
    expect(await readFile(f.handoff.patchPath)).toEqual(retainedBefore);
  });

  it.each(["live self", "result self", "changed manifest", "changed receipt", "foreign registration"])("retains the start fence for %s", async (mutation) => {
    const f = await startFixture();
    await f.withLease(async (gate) => {
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
      if (mutation === "live self") Object.assign(f.item, { workerAlive: true, workerProcessAlive: true, activeWriterRisk: "active_worker" });
      if (mutation === "result self") Object.assign(f.item, { resultExists: true });
      if (mutation === "changed manifest") await writeFile(join(f.input.registryRootDir, f.manifest.jobId, "job.json"), JSON.stringify({ ...f.manifest, promptPath: join(f.root, "foreign.md") }));
      if (mutation === "changed receipt") await writeFile(f.manifest.projectPreStartAdmission!.receiptPath, "{}");
      if (mutation === "foreign registration") {
        const root = join(f.input.registryRootDir, "foreign-worker"); await mkdir(root);
        const manifest = { ...f.manifest, jobId: "foreign-worker", jobRootDir: root };
        await writeFile(join(root, "job.json"), JSON.stringify(manifest));
        f.summaries.push({ ...f.summaries.at(-1)!, jobId: manifest.jobId, manifestPath: join(root, "job.json") });
      }
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    });
  });

  it.each(["bad timestamp", "invalid JSON", "missing manifest", "manifest symlink"])("denies native listing omission: %s", async (mutation) => {
    const f = await fixture();
    const jobId = "foreign-live-worker";
    const root = join(f.input.registryRootDir, jobId); await mkdir(root);
    const path = join(root, "job.json");
    const manifest = { ...f.manifest, jobId, jobRootDir: root, workspacePath: f.request.workspacePath, updatedAt: "not-a-date" };
    if (mutation === "bad timestamp") await writeFile(path, JSON.stringify(manifest));
    if (mutation === "invalid JSON") await writeFile(path, "{");
    if (mutation === "manifest symlink") await symlink(f.summary.manifestPath, path);
    const deps = { ...f.input.deps, listJobs: listCodexGoalJobs };
    const gate = codexProjectAdmissionGate({ ...f.input, deps, controllerJobId: "project-controller" });
    await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    const snapshot = await buildCodexProjectAdmissionSnapshot({ ...f.input, deps, requestedWorkspacePath: f.request.workspacePath });
    expect(snapshot.debt).toEqual(expect.arrayContaining([expect.objectContaining({ reason: ProjectDebtReason.UnreadableRoot })]));
  });

  it("admits a native default event projection without treating its observed liveness as authority", async () => {
    const f = await fixture();
    const rootDir = runEventRootFromArgs({}, f.input.registryRootDir);
    const service = new RunEventProjectionService({
      registryRootDir: f.input.registryRootDir, providerKind: RunEventProviderKind.Codex,
      eventStore: new LocalFileRunEventStore({ rootDir }),
      stateStore: new LocalFileRunEventProjectionStateStore({ rootDir }),
      observationPort: { observeRun: async (): Promise<RunObservationSnapshot> => ({
        runId: "synthetic-observation", providerKind: RunEventProviderKind.Codex,
        observedAt: "2026-10-07T00:00:00Z", status: "running", liveness: "alive", warnings: [],
        readOnlyDecision: { kind: "keep_watching", reason: "worker_observable", safeMessage: "watch" },
      }) },
    });
    await service.projectRun({ runId: "synthetic-observation" });
    const path = join(rootDir, "run-events", "events.ndjson");
    const before = await readFile(path, "utf8");
    expect(before.length).toBeGreaterThan(0);
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    expect(await readFile(path, "utf8")).toBe(before);
    f.item.workerAlive = true;
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each([".project-authority", ".project-control", "durable-handoffs", "consumed-output-ledger", ".consumed-output-ledger-mutation-locks", "archives", "state", ".run-events"])("allows native container %s but never ignores its malformed job manifest", async (name) => {
    const f = await fixture();
    const root = join(f.input.registryRootDir, name); await mkdir(root);
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    await writeFile(join(root, "job.json"), "{");
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("admits a configured native consumed-output parent while retaining manifest and liveness fences", async () => {
    const f = await fixture();
    const root = join(f.input.registryRootDir, "consumed-output");
    const ledger = join(root, "ledger");
    const archives = join(root, "archives");
    await mkdir(join(ledger, "items"), { recursive: true });
    await mkdir(archives);
    await mkdir(join(root, ".consumed-output-ledger-mutation-locks"));
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    const input = { ...f.input, scope: { ...f.input.scope,
      consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [archives] } };
    const gate = codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" });
    await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    f.item.workerAlive = true;
    await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
    f.item.workerAlive = false;
    await writeFile(join(root, "job.json"), "{");
    await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each(["alias", "file", "denied ancestor", "denied descendant", "other name", "ancestor ledger", "sibling ledger"])("denies unsafe configured consumption container: %s", async (mutation) => {
    const f = await fixture();
    const root = join(f.input.registryRootDir, mutation === "other name" ? "arbitrary" : "consumed-output");
    const ledger = mutation === "ancestor ledger" ? f.root : mutation === "sibling ledger" ? join(f.root, "consumed-output-other", "ledger") : join(root, "ledger");
    const archives = join(root, "archives");
    await mkdir(root);
    await mkdir(join(ledger, "items"), { recursive: true });
    if (mutation === "alias") await symlink(f.request.workspacePath, archives);
    else if (mutation === "file") await writeFile(archives, "not a directory");
    else await mkdir(archives);
    const input = { ...f.input, scope: { ...f.input.scope, consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [archives],
      ...(mutation === "denied ancestor" ? { deniedRoots: [f.input.registryRootDir] } : {}),
      ...(mutation === "denied descendant" ? { deniedRoots: [join(root, "private")] } : {}) } };
    await expect(codexProjectAdmissionGate({ ...input, controllerJobId: "project-controller" }).evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it.each(["unknown-directory", ".unknown-directory", "state-symlink", ".project-control-symlink", ".run-events-symlink", "consumed-output-symlink"])("denies unknown or symlink registry container %s", async (name) => {
    const f = await fixture();
    if (name.endsWith("-symlink")) await symlink(f.request.workspacePath, join(f.input.registryRootDir, name.slice(0, -"-symlink".length)));
    else await mkdir(join(f.input.registryRootDir, name));
    await expect(f.gate.evaluate(f.request)).resolves.toMatchObject({ allowed: false });
  });

  it("follows native prepared CreateJob then registered start admission with separate job and registry roots", async () => {
    const f = await startFixture();
    expect(f.manifest.jobRootDir).toBe(join(f.root, "jobs", "project-worker"));
    expect(f.summaries.at(-1)!.manifestPath).toBe(join(f.input.registryRootDir, "project-worker", "job.json"));
    expect(await readCodexGoalJob({ registryRootDir: f.input.registryRootDir, jobId: f.manifest.jobId })).toEqual(f.manifest);
    await f.withLease(async (gate) => {
      await expect(gate.evaluate(f.request)).resolves.toMatchObject({ allowed: true });
    });
  });

  it("admits only the bound unpublished CreateJob staging and rejects added runtime files", async () => {
    const f = await startFixture({ colocatedJobRoot: true });
    await rm(join(f.input.registryRootDir, f.manifest.jobId, "job.json"));
    f.summaries.pop(); f.items.pop();
    const request = { ...f.request, operation: ProjectOperation.CreateJob };
    const gate = codexProjectAdmissionGate({ ...f.input, targetBinding: { createManifest: f.manifest } });
    await expect(codexProjectAdmissionGate(f.input).evaluate(request)).resolves.toMatchObject({ allowed: false });
    await expect(gate.evaluate(request)).resolves.toMatchObject({ allowed: true });
    await writeFile(join(f.manifest.jobRootDir, "worker.pid"), "12345");
    await expect(gate.evaluate(request)).resolves.toMatchObject({ allowed: false });
  });
});
