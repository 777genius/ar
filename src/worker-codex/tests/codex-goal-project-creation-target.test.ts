import { callToolJson, describe, tmpdir } from "./codex-goal-mcp-project-admission-test-fixture";
import { access, chmod, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { AccessBoundary, InMemoryWorkerAccountCapacityStore, InMemoryWorkerAccountLeaseStore, ProjectOperation, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { codexGoalJobToArgs, createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob, type CodexGoalJobManifestInput } from "../codex-goal-jobs";
import { observeProtectedCodexGoalJobBirth, prepareProtectedCodexGoalJobBirth, protectedCodexGoalJobBirthPreparationCurrent,
  recordProtectedCodexGoalJobFirstEffect, type ProtectedCodexGoalJobBirthPreparation } from "../protected-job-birth";
import { researchAuthorityRoot, researchHash } from "../research-launch-files";
import {
  admissionCreationTargetIdentity, admissionCreateJobTargetIdentity, admissionNeedsFreshCreateJobTarget, admissionStartSelfIdentity,
  type ProjectAdmissionTargetBinding,
} from "../application/project-control/codex-goal-project-admission-target";
import { prospectiveAdmissionResourceBacking } from "../application/project-control/codex-goal-project-admission-paths";
import { host } from "./research-launch-fixture";
import { callToolJson as invokeTool, git, gitInitRepository, gitStdout } from "./codex-goal-mcp-test-support";
import { cleanupProjectPreStartAdmissionFixtures, createBuiltinFixture, declarativeContract } from "./codex-goal-project-pre-start-admission-fixture";
import { planProjectPreStartAdmission, prepareProjectPreStartAdmission } from "../application/project-control/codex-goal-project-pre-start-admission";
import { materializeReviewedOutputAggregateArtifacts, resolveLocalReviewedOutputAggregate } from "../codex-goal-mcp-project-verifier-support";
import { stagedPatchSha256 } from "../application/project-control/codex-goal-project-git";
import { createApprovedReviewedOutput } from "./codex-goal-mcp-project-prepare-verifier-test-support";
import { reviewedWorkerOutputRoot } from "../reviewed-worker-output";
import { bindDependencyPreflightDiagnostic, runDependencyBootstrap } from "../dependency-bootstrap";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "../codex-goal-project-workspace-lock";
import { codexProjectAdmissionGate } from "../application/project-control/codex-goal-project-admission";
import { createCodexProjectControlBroker } from "../codex-goal-mcp-project-broker";
import { createCommittedTestRepository } from "./codex-goal-mcp-project-broker-test-support";
import { assertCodexProjectReservedLaunchAuthority, reserveCodexProjectAccount } from "../application/project-control/codex-goal-project-account-reservation";

afterEach(cleanupProjectPreStartAdmissionFixtures);

async function fixture() {
  const root = join(tmpdir(), "TEST-creation-target");
  const registryRootDir = join(root, "registry");
  const workspacePath = join(root, "workspaces", "child");
  for (const path of [registryRootDir, workspacePath, join(root, "jobs"), join(root, "worktrees")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const scope: ProjectAccessScope = {
    projectId: "TEST-creation", registryRoot: registryRootDir, authRoot: join(tmpdir(), "auth"),
    workspaceRoots: [join(root, "workspaces")], worktreeRoots: [join(root, "worktrees")],
    jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"], allowedAccountIds: ["TEST-a"],
  };
  const manifest: CodexGoalJobManifestInput = {
    jobId: "TEST-child", taskId: "TEST-child", workspacePath,
    jobRootDir: join(root, "jobs", "TEST-child"), promptPath: join(root, "jobs", "TEST-child", "prompt.md"),
    accounts: ["TEST-a"], authRootDir: join(tmpdir(), "auth"),
  };
  const input = { registryRootDir, scope, binding: { createManifest: manifest },
    request: { operation: ProjectOperation.CreateJob, jobId: manifest.jobId, workspacePath } };
  return { root, registryRootDir, workspacePath, scope, manifest, input };
}

describe("scoped creation targets", () => {
  it("keeps a prepared job released when its required checkpoint publisher is missing", async () => {
    const f = await createBuiltinFixture({ temporaryRoot: tmpdir() }), registryRootDir = join(f.root, "registry");
    const worktreeRoot = join(f.root, "worktrees"), authRootDir = join(f.root, "TEST-auth");
    const controllerWorkspace = join(f.root, "TEST-controller-workspace");
    await createCommittedTestRepository(controllerWorkspace, "TEST checkpoint controller\n");
    await mkdir(registryRootDir, { mode: 0o700 }); await mkdir(worktreeRoot, { mode: 0o700 });
    const scope = { ...f.scope, registryRoot: registryRootDir, workspaceRoots: [f.workspacePath, controllerWorkspace],
      worktreeRoots: [worktreeRoot], jobIdPrefixes: ["project-"], allowedAccountIds: f.manifest.accounts };
    const controllerRoot = join(f.root, "jobs", "project-controller");
    const controller = await createCodexGoalJob({ registryRootDir, manifest: { ...f.manifest,
      jobId: "project-controller", taskId: "project-controller", jobRootDir: controllerRoot,
      workspacePath: controllerWorkspace, promptPath: join(controllerRoot, "prompt.md"), authRootDir, accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: scope } });
    const plan = f.plan();
    await rm(f.manifest.jobRootDir, { recursive: true });
    const manifest = await createCodexGoalJob({ registryRootDir, manifest: { ...f.manifest, authRootDir,
      checkpointRequired: true, projectPreStartAdmission: plan.descriptor,
      projectAccessScope: { projectId: scope.projectId, isolatedWorkspaceRoot: f.workspacePath,
        allowedAccountIds: f.manifest.accounts, authRoot: authRootDir } } });
    await writeFile(manifest.promptPath, "bounded prompt\n", { mode: 0o600 });
    await prepareProjectPreStartAdmission({ plan, manifest, scope });
    const receiptBefore = await readFile(plan.descriptor.receiptPath);
    const launch = await goalLaunchInput({ ...codexGoalJobToArgs(manifest), cwd: f.root });
    const deps = { listJobs: listCodexGoalJobs, readJob: readCodexGoalJob,
      readWriterWritableRoots: observeProtectedCodexGoalJobBirth,
      buildOverviewItems: async (inputs: readonly { jobId: string }[]) => inputs.map(({ jobId }) => ({
        ok: true, jobId, workspacePath: jobId === controller.jobId ? controller.workspacePath : manifest.workspacePath,
        workerAlive: false, workerProcessAlive: false,
        progressProcessAlive: false, workspaceDirty: false, resultExists: false, activeWriterRisk: "none",
        progressExists: false, workerSupervisorKind: "none" })) };
    const oldSocket = process.env.SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET;
    delete process.env.SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET;
    try {
      await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(registryRootDir), scope,
        requestedWorkspacePath: manifest.workspacePath, owner: `project-start:${controller.jobId}:${manifest.jobId}`,
        effect: async workspaceLease => {
          const broker = createCodexProjectControlBroker({ registryRootDir, controller, scope, admissionDeps: deps,
            startManifest: manifest, startLaunch: launch, startWorkspaceLease: workspaceLease,
            revalidateStartPublication: async () => undefined });
          await expect(broker.startWorker({ jobId: manifest.jobId, registryRoot: registryRootDir,
            workspacePath: manifest.workspacePath, accounts: manifest.accounts, ownedPaths: ["src/example.ts"] }))
            .rejects.toThrow("checkpoint_publisher_required");
        },
      });
      expect(await readFile(plan.descriptor.receiptPath)).toEqual(receiptBefore);
      expect(await observeProtectedCodexGoalJobBirth(manifest)).toEqual({ status: "released" });
      const target = { sourceWorkspacePath: f.workspacePath, expectedSourceRealPath: f.workspacePath,
        path: join(worktreeRoot, "project-independent"), expectedRevision: String(f.contract.baseSha), sourceRevisionPinned: true };
      await expect(codexProjectAdmissionGate({ registryRootDir, scope, controllerJobId: controller.jobId, deps,
        targetBinding: { createWorktree: target } }).evaluate({ operation: ProjectOperation.CreateWorktree,
          workspacePath: target.path })).resolves.toMatchObject({ allowed: true });
      await expect(access(launch.config.outputPath!)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(target.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldSocket === undefined) delete process.env.SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET;
      else process.env.SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET = oldSocket;
    }
  });

  // RED: an official exclusive receipt used to make the fresh self unavailable.
  it("qualifies a never-started self only with its original private exclusive receipt", async () => {
    const f = await createBuiltinFixture({ temporaryRoot: tmpdir() });
    const registryRootDir = join(f.root, "registry"), plan = f.plan();
    const scope = { ...f.scope, registryRoot: registryRootDir, workspaceRoots: [f.workspacePath] };
    await mkdir(registryRootDir, { mode: 0o700 });
    const authRootDir = join(f.root, "TEST-auth");
    const manifest = await createCodexGoalJob({ registryRootDir, manifest: { ...f.manifest, authRootDir,
      projectPreStartAdmission: plan.descriptor, projectAccessScope: { projectId: scope.projectId,
        isolatedWorkspaceRoot: f.workspacePath, allowedAccountIds: f.manifest.accounts, authRoot: authRootDir } } });
    await prepareProjectPreStartAdmission({ plan, manifest, scope });
    const preparedBytes = await readFile(plan.descriptor.receiptPath);
    const launch = await goalLaunchInput({ ...codexGoalJobToArgs(manifest), cwd: f.root });
    const reservation = await reserveCodexProjectAccount({ manifest, launch, deps: {
      leaseMode: "exclusive", capacityStore: new InMemoryWorkerAccountCapacityStore(), leaseStore: new InMemoryWorkerAccountLeaseStore(),
    } });
    const receiptPath = join(manifest.jobRootDir, "account-reservation.json"), bytes = await readFile(receiptPath);
    await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(registryRootDir), scope,
      requestedWorkspacePath: manifest.workspacePath, owner: `project-start:project-controller:${manifest.jobId}`,
      effect: async workspaceLease => {
        const summaries = await listCodexGoalJobs({ registryRootDir });
        const overviewItems = [{ ok: true, jobId: manifest.jobId, workerAlive: false, workerProcessAlive: false,
          progressProcessAlive: false, workspaceConflict: false, workspaceDirty: false, resultExists: false, activeWriterRisk: "none" }];
        const identity = (selected = reservation.launch) => admissionStartSelfIdentity({ registryRootDir, scope,
          controllerJobId: "project-controller", request: { operation: ProjectOperation.StartWorker, jobId: manifest.jobId,
            workspacePath: manifest.workspacePath, ownedPaths: ["src/example.ts"] }, summaries, overviewItems,
          binding: { start: { manifest, launch: selected, workspaceLease } } });
        const expected = { jobId: manifest.jobId, workspacePath: manifest.workspacePath };
        await expect(identity()).resolves.toEqual(expected);
        await expect(identity({ ...reservation.launch })).resolves.toBeUndefined();
        await writeFile(receiptPath, Buffer.concat([bytes, Buffer.from("\n")]));
        await expect(identity()).resolves.toBeUndefined();
        await writeFile(receiptPath, bytes);
        for (const alias of ["symlink", "hardlink"] as const) {
          const copy = join(f.root, "TEST-receipt-copy.json");
          await writeFile(copy, bytes, { mode: 0o600 }); await rm(receiptPath);
          if (alias === "symlink") await symlink(copy, receiptPath); else await link(copy, receiptPath);
          await expect(identity()).resolves.toBeUndefined();
          await rm(receiptPath); await rm(copy); await writeFile(receiptPath, bytes, { mode: 0o600 });
        }
        await chmod(receiptPath, 0o644); await expect(identity()).resolves.toBeUndefined();
        await chmod(receiptPath, 0o600); await rm(receiptPath); await expect(identity()).resolves.toBeUndefined();
        await writeFile(receiptPath, bytes, { mode: 0o600 });
        await expect(identity()).resolves.toEqual(expected);
      } });
    expect(await readFile(plan.descriptor.receiptPath)).toEqual(preparedBytes);
    expect(assertCodexProjectReservedLaunchAuthority({ manifest, sourceLaunch: launch, reservedLaunch: reservation.launch }).fresh).toBe(true);
    await expect(access(launch.logPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("qualifies only the official unchanged dependency diagnostic for a never-started self", async () => {
    const f = await createBuiltinFixture({ temporaryRoot: tmpdir() }), registryRootDir = join(f.root, "registry");
    await mkdir(registryRootDir, { mode: 0o700 });
    const scope = { ...f.scope, registryRoot: registryRootDir, workspaceRoots: [f.workspacePath] }, plan = f.plan();
    const manifest = await createCodexGoalJob({ registryRootDir, manifest: { ...f.manifest,
      authRootDir: join(f.root, "TEST-auth"), projectPreStartAdmission: plan.descriptor,
      projectAccessScope: { projectId: scope.projectId, isolatedWorkspaceRoot: f.workspacePath,
        allowedAccountIds: f.manifest.accounts, authRoot: join(f.root, "TEST-auth") } } });
    await prepareProjectPreStartAdmission({ plan, manifest, scope });
    const receiptBefore = await readFile(plan.descriptor.receiptPath);
    const launch = await goalLaunchInput({ ...codexGoalJobToArgs(manifest), cwd: f.root });
    const request = { operation: ProjectOperation.StartWorker, jobId: manifest.jobId,
      workspacePath: manifest.workspacePath, ownedPaths: ["src/example.ts"] };
    const deps = { listJobs: listCodexGoalJobs, readJob: readCodexGoalJob,
      readWriterWritableRoots: async () => ({ status: "unknown" as const }),
      buildOverviewItems: async () => [{ ok: true, jobId: manifest.jobId, workspacePath: manifest.workspacePath,
        workerAlive: false, workerProcessAlive: false, progressProcessAlive: false, workspaceDirty: false,
        resultExists: false, activeWriterRisk: "none", progressExists: false, workerSupervisorKind: "none" }] };
    await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(registryRootDir), scope,
      requestedWorkspacePath: manifest.workspacePath, owner: `project-refill-start:project-controller:${manifest.jobId}`,
      effect: async workspaceLease => {
        const start = { manifest, launch, workspaceLease };
        const gate = (bound: NonNullable<ProjectAdmissionTargetBinding["start"]> = start) => codexProjectAdmissionGate({ registryRootDir, scope,
          controllerJobId: "project-controller", deps, targetBinding: { start: bound } });
        const prepared = await runDependencyBootstrap({ workspacePath: manifest.workspacePath, jobRootDir: manifest.jobRootDir, mode: "off" });
        const diagnostic = bindDependencyPreflightDiagnostic(prepared, manifest.jobRootDir)!;
        expect(diagnostic).toBeDefined();
        const bound = { ...start, dependencyPreflightDiagnostic: diagnostic };
        await expect(gate().evaluate(request)).resolves.toMatchObject({ allowed: false });
        await expect(gate(bound).evaluate(request)).resolves.toMatchObject({ allowed: true });
        const bytes = await readFile(diagnostic.path);
        await writeFile(diagnostic.path, Buffer.concat([bytes, Buffer.from("\n")]));
        await expect(gate(bound).evaluate(request)).resolves.toMatchObject({ allowed: false });
        await writeFile(diagnostic.path, bytes);
        for (const alias of ["symlink", "hardlink"] as const) {
          const copy = join(f.root, "TEST-diagnostic-copy.json");
          await writeFile(copy, bytes, { mode: 0o600 }); await rm(diagnostic.path);
          if (alias === "symlink") await symlink(copy, diagnostic.path); else await link(copy, diagnostic.path);
          await expect(gate(bound).evaluate(request)).resolves.toMatchObject({ allowed: false });
          await rm(diagnostic.path); await rm(copy); await writeFile(diagnostic.path, bytes, { mode: 0o600 });
        }
        await chmod(diagnostic.path, 0o644);
        await expect(gate(bound).evaluate(request)).resolves.toMatchObject({ allowed: false });
        await chmod(diagnostic.path, 0o600);
        await expect(gate({ ...bound, dependencyPreflightDiagnostic: { ...diagnostic, workspacePath: f.root } }).evaluate(request)).resolves.toMatchObject({ allowed: false });
        const foreign = join(manifest.jobRootDir, "TEST-other.json"); await writeFile(foreign, "{}", { mode: 0o600 });
        await expect(gate(bound).evaluate(request)).resolves.toMatchObject({ allowed: false });
        await rm(foreign);
        await expect(gate(bound).evaluate(request)).resolves.toMatchObject({ allowed: true });
      },
    });
    expect(await readFile(plan.descriptor.receiptPath)).toEqual(receiptBefore);
    await expect(access(launch.config.outputPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("registers a fresh job with actual physical target facts (future workspace=%s)", async future => {
    const f = await fixture();
    if (future) await rm(f.workspacePath, { recursive: true });
    const controllerWorkspace = join(f.root, "workspaces", "controller");
    await mkdir(controllerWorkspace, { mode: 0o700 });
    for (const workspace of [controllerWorkspace, ...(future ? [] : [f.workspacePath])]) {
      await gitInitRepository(workspace);
      await writeFile(join(workspace, "README.md"), "TEST base\n");
      await git(workspace, ["add", "README.md"]);
      await git(workspace, ["commit", "-m", "test: creation target base"]);
    }
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "TEST-creation-target", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const controllerRoot = join(f.root, "jobs", "TEST-controller");
      await expect(callToolJson(client, "codex_goal_create_job", {
        registryRootDir: f.registryRootDir, jobId: "TEST-controller", taskId: "TEST-controller",
        workspacePath: controllerWorkspace, jobRootDir: controllerRoot, promptPath: join(controllerRoot, "prompt.md"),
        authRootDir: f.scope.authRoot,
        accounts: ["TEST-a"], accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: f.scope,
      })).resolves.toMatchObject({ ok: true });
      const physical = await Promise.all([f.workspacePath, f.manifest.jobRootDir].map(prospectiveAdmissionResourceBacking));
      expect(physical.every(roots => Boolean(roots?.length))).toBe(true);
      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir: f.registryRootDir, controllerJobId: "TEST-controller", ...f.manifest,
        workerRole: "producer", confirmCreate: true,
      });
      expect(created).toMatchObject({ ok: true, result: { admission: {
        scope: "target", target: { canonicalPath: f.workspacePath, physicalWritableRoots: physical.flat() },
        backlog: { count: 0 },
      } } });
      const stored = await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: f.manifest.jobId });
      expect(stored.projectPreStartAdmission).toBeUndefined();
      expect(await observeProtectedCodexGoalJobBirth(stored)).toEqual({ status: future ? "unknown" : "released" });
      // Registration neither creates the future workspace nor grants release
      // merely because its current directory has not been created yet.
      if (future) await expect(access(f.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await client.close(); await server.close(); }
  });

  it("keeps an existing prompt-only legacy root on its original admission route", async () => {
    const f = await fixture();
    expect(await admissionNeedsFreshCreateJobTarget(f.input.binding)).toBe(true);
    await mkdir(f.manifest.jobRootDir, { mode: 0o700 });
    await writeFile(f.manifest.promptPath, "TEST existing prompt\n");
    expect(await admissionNeedsFreshCreateJobTarget(f.input.binding)).toBe(false);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
  });

  it("qualifies existing staging only with the original unconsumed cold create capability", async () => {
    const f = await fixture(), proofInput = { manifest: f.manifest, registryRootDir: f.registryRootDir };
    const preparation = await prepareProtectedCodexGoalJobBirth(proofInput);
    expect(preparation).toBeDefined();
    const proof = { ...proofInput, preparation: preparation! };
    await writeFile(f.manifest.promptPath, "TEST protected staging\n", { mode: 0o600 });
    const input = { ...f.input, binding: { ...f.input.binding, createBirthPreparation: preparation! } };
    expect(await admissionNeedsFreshCreateJobTarget(input.binding)).toBe(false);
    expect(protectedCodexGoalJobBirthPreparationCurrent(proof)).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) expect(await admissionCreateJobTargetIdentity(input)).toBe(f.workspacePath);
    expect(protectedCodexGoalJobBirthPreparationCurrent(proof)).toBe(true);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    expect(await admissionCreateJobTargetIdentity({ ...input, binding: {
      ...input.binding, createBirthPreparation: Object.freeze({}) as ProtectedCodexGoalJobBirthPreparation,
    } })).toBeUndefined();
    expect(await admissionCreateJobTargetIdentity({ ...input,
      scope: { ...f.scope, preStartAdmission: { required: true, mode: "serial-builtin" } },
    })).toBeUndefined();
    expect(await admissionCreateJobTargetIdentity({ ...input, binding: {
      ...input.binding, createManifest: { ...f.manifest, taskId: "TEST-rewritten" },
    } })).toBeUndefined();
    await mkdir(join(f.registryRootDir, f.manifest.jobId), { mode: 0o700 });
    expect(await admissionCreateJobTargetIdentity(input)).toBeUndefined();
    await rm(join(f.registryRootDir, f.manifest.jobId), { recursive: true });
    recordProtectedCodexGoalJobFirstEffect(f.manifest.jobRootDir);
    expect(protectedCodexGoalJobBirthPreparationCurrent(proof)).toBe(false);
    expect(await admissionCreateJobTargetIdentity(input)).toBeUndefined();
    await expect(access(join(f.registryRootDir, f.manifest.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits only the original official reviewed aggregate staging and rejects artifact drift", async () => {
    const f = await createBuiltinFixture({ temporaryRoot: tmpdir() }), registryRootDir = join(f.root, "registry");
    await mkdir(registryRootDir, { mode: 0o700 });
    await mkdir(join(f.root, "worktrees"), { mode: 0o700 });
    const reviewed = await createApprovedReviewedOutput({ root: f.root, sourceWorkspacePath: f.workspacePath,
      reviewedRoot: reviewedWorkerOutputRoot(registryRootDir), workerJobId: "project-reviewed", changedFile: "README.md", content: "TEST approved aggregate\n" });
    const aggregate = await resolveLocalReviewedOutputAggregate({ registryRootDir, projectId: "project",
      reviewedOutputIds: [reviewed.reviewedOutputId], expectedBaseCommit: String(f.contract.baseSha) });
    const scope = { ...f.scope, registryRoot: registryRootDir, workspaceRoots: [f.root] };
    const plan = planProjectPreStartAdmission({ confirmed: true, scope, manifest: f.manifest,
      value: { mode: "serial-builtin", contract: { ...declarativeContract(f.contract), inputPatchHash: aggregate.patchSha256, ownedPaths: ["README.md"] } },
    })!;
    const manifest = { ...f.manifest, projectPreStartAdmission: plan.descriptor };
    await rm(manifest.jobRootDir, { recursive: true });
    const preparation = await prepareProtectedCodexGoalJobBirth({ manifest, registryRootDir });
    expect(preparation).toBeDefined();
    const artifacts = await materializeReviewedOutputAggregateArtifacts({ jobRootDir: manifest.jobRootDir, aggregate });
    await writeFile(manifest.promptPath, "TEST reviewed aggregate prompt\n", { mode: 0o600 });
    await git(f.workspacePath, ["apply", "--index", artifacts.patchPath]);
    await prepareProjectPreStartAdmission({ plan, manifest, scope,
      verifiedInputPatchArtifactSha256: aggregate.patchSha256, verifiedInputPatchStagedSha256: await stagedPatchSha256(f.workspacePath) });
    const binding = { createManifest: manifest, createBirthPreparation: preparation!,
      createReviewedOutputAggregate: { aggregate, sourceRealPath: f.workspacePath } };
    const input = { registryRootDir, scope, binding,
      request: { operation: ProjectOperation.CreateJob, jobId: manifest.jobId, workspacePath: manifest.workspacePath, ownedPaths: ["README.md"] } };
    for (let attempt = 0; attempt < 2; attempt++) expect(await admissionCreateJobTargetIdentity(input)).toBe(f.workspacePath);
    expect(protectedCodexGoalJobBirthPreparationCurrent({ preparation: preparation!, manifest, registryRootDir })).toBe(true);
    const { createBirthPreparation: _preparation, ...capless } = binding;
    const { createReviewedOutputAggregate: _aggregate, ...withoutAggregate } = binding;
    for (const changed of [
      capless,
      { ...binding, createBirthPreparation: Object.freeze({}) as ProtectedCodexGoalJobBirthPreparation },
      withoutAggregate,
      { ...binding, createReviewedOutputAggregate: { ...binding.createReviewedOutputAggregate, sourceRealPath: join(f.root, "missing-source") } },
      { ...binding, createReviewedOutputAggregate: { ...binding.createReviewedOutputAggregate, aggregate: { ...aggregate, baseCommit: "0".repeat(40) } } },
    ]) expect(await admissionCreateJobTargetIdentity({ ...input, binding: changed })).toBeUndefined();
    for (const path of [artifacts.patchPath, artifacts.provenancePath]) {
      const original = await readFile(path);
      await writeFile(path, "TEST tampered aggregate\n");
      expect(await admissionCreateJobTargetIdentity(input)).toBeUndefined();
      await writeFile(path, original);
    }
    const extra = join(manifest.jobRootDir, "reviewed-output-aggregate", "extra.json");
    await writeFile(extra, "{}", { mode: 0o600 });
    expect(await admissionCreateJobTargetIdentity(input)).toBeUndefined();
    await rm(extra);
    const patch = await readFile(artifacts.patchPath);
    await rm(artifacts.patchPath); await symlink(manifest.promptPath, artifacts.patchPath);
    expect(await admissionCreateJobTargetIdentity(input)).toBeUndefined();
    await rm(artifacts.patchPath); await writeFile(artifacts.patchPath, patch, { mode: 0o600 });
    expect(await admissionCreateJobTargetIdentity(input)).toBe(f.workspacePath);
    recordProtectedCodexGoalJobFirstEffect(manifest.jobRootDir);
    expect(await admissionCreateJobTargetIdentity(input)).toBeUndefined();
    await expect(access(join(registryRootDir, manifest.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("keeps legacy enforcement and refuses fallback for malformed modern birth=%s", async modern => {
    const f = await fixture(), controllerWorkspace = join(f.root, "workspaces", "controller");
    await mkdir(controllerWorkspace, { mode: 0o700 });
    for (const workspace of [controllerWorkspace, f.workspacePath]) {
      await gitInitRepository(workspace);
      await writeFile(join(workspace, "README.md"), "TEST base\n");
      await git(workspace, ["add", "README.md"]);
      await git(workspace, ["commit", "-m", "test: controller route provenance"]);
    }
    const controllerRoot = join(f.root, "jobs", "TEST-controller");
    if (!modern) await mkdir(controllerRoot, { mode: 0o700 });
    const server = createCodexGoalMcpServer(), client = new Client({ name: "TEST-owner-route", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await expect((modern ? callToolJson : invokeTool)(client, "codex_goal_create_job", {
        registryRootDir: f.registryRootDir, jobId: "TEST-controller", taskId: "TEST-controller",
        workspacePath: controllerWorkspace, jobRootDir: controllerRoot, promptPath: join(controllerRoot, "prompt.md"),
        authRootDir: f.scope.authRoot, accounts: ["TEST-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: f.scope,
      })).resolves.toMatchObject({ ok: true });
      if (modern) await writeFile(join(researchAuthorityRoot, "job-births", researchHash(controllerRoot) + ".json"), "{");
      const controller = await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-controller" });
      expect(await observeProtectedCodexGoalJobBirth(controller)).toEqual({ status: "unknown" });
      const result = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir: f.registryRootDir, controllerJobId: controller.jobId, ...f.manifest,
        workerRole: "producer", confirmCreate: true,
      });
      if (modern) {
        expect(result).toMatchObject({ ok: false, admission: { allowed: false, resource: f.workspacePath,
          examples: expect.arrayContaining([expect.objectContaining({ reason: "active_writer_conflict" })]) } });
        await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(join(f.registryRootDir, f.manifest.jobId))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result).toMatchObject({ ok: true, result: { status: "applied" } });
        expect((result.result as Record<string, unknown>).admission).toBeUndefined();
        expect((await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: f.manifest.jobId })).jobId).toBe(f.manifest.jobId);
      }
    } finally { await client.close(); await server.close(); }
  });

  it("requires initial host identity and current custody even for an absent root", async () => {
    const f = await fixture();
    expect(await admissionCreateJobTargetIdentity(f.input)).toBe(f.workspacePath);
    host.namespaceRoot = true;
    expect(await admissionNeedsFreshCreateJobTarget(f.input.binding)).toBe(true);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    host.namespaceRoot = false;
    host.foreign.add(f.workspacePath);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    host.foreign.delete(f.workspacePath);
    await chmod(join(f.root, "jobs"), 0o777);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects required pre-start policy, request mismatch and registry collision", async () => {
    const f = await fixture();
    expect(await admissionCreateJobTargetIdentity({ ...f.input,
      scope: { ...f.scope, preStartAdmission: { required: true, mode: "serial-builtin" } },
    })).toBeUndefined();
    expect(await admissionCreateJobTargetIdentity({ ...f.input,
      request: { ...f.input.request, jobId: "TEST-other" },
    })).toBeUndefined();
    await mkdir(join(f.registryRootDir, f.manifest.jobId), { mode: 0o700 });
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a future job-root alias even when its workspace is canonical", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias-jobs");
    await symlink(join(f.root, "jobs"), alias);
    expect(await admissionCreateJobTargetIdentity({ ...f.input, binding: { createManifest: {
      ...f.manifest, jobRootDir: join(alias, f.manifest.jobId), promptPath: join(alias, f.manifest.jobId, "prompt.md"),
    } } })).toBeUndefined();
  });

  it("rejects an aliased or out-of-scope future workspace and unsafe ancestor custody", async () => {
    const f = await fixture(), alias = join(f.root, "workspace-alias");
    await symlink(join(f.root, "workspaces"), alias);
    for (const workspacePath of [join(alias, "future"), join(f.root, "unscoped-future")]) {
      expect(await admissionCreateJobTargetIdentity({ ...f.input,
        request: { ...f.input.request, workspacePath },
        binding: { createManifest: { ...f.manifest, workspacePath } },
      })).toBeUndefined();
    }
    await rm(f.workspacePath, { recursive: true });
    expect(await admissionCreateJobTargetIdentity(f.input)).toBe(f.workspacePath);
    await chmod(join(f.root, "workspaces"), 0o777);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    await expect(access(f.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("qualifies a pinned worktree without granting mismatched child ownership (existing=%s)", async existing => {
    const f = await fixture();
    await gitInitRepository(f.workspacePath);
    await writeFile(join(f.workspacePath, "README.md"), "TEST pinned base\n");
    await git(f.workspacePath, ["add", "README.md"]);
    await git(f.workspacePath, ["commit", "-m", "test: standalone worktree target"]);
    const path = join(f.root, "worktrees", "TEST-standalone");
    if (existing) await git(f.workspacePath, ["worktree", "add", "-b", "fix/TEST-existing", path, "HEAD"]);
    const target = { sourceWorkspacePath: f.workspacePath, expectedSourceRealPath: f.workspacePath,
      path, expectedRevision: (await gitStdout(f.workspacePath, ["rev-parse", "HEAD"])).trim(), sourceRevisionPinned: true,
      ...(existing ? { expectedRealPath: path, newBranch: "fix/TEST-existing", workerRole: "adoption" as const } : {}) };
    const request = { operation: ProjectOperation.CreateWorktree, workspacePath: path };
    const input = { registryRootDir: f.registryRootDir, scope: f.scope, binding: { createWorktree: target }, request };
    expect(await admissionCreationTargetIdentity(input)).toBe(path);
    expect(await admissionCreationTargetIdentity({ ...input, request: { ...request, ownedPaths: ["src/"] } })).toBeUndefined();
    const child = { ...target, jobId: "TEST-child", ownedPaths: ["src/"] };
    expect(await admissionCreationTargetIdentity({ ...input, binding: { createWorktree: child },
      request: { ...request, jobId: child.jobId, ownedPaths: ["other/"] } })).toBeUndefined();
    expect(await admissionCreationTargetIdentity({ ...input, binding: { createWorktree: child },
      request: { ...request, jobId: child.jobId, ownedPaths: ["src/"] } })).toBe(path);
    if (existing) {
      await writeFile(join(path, "README.md"), "TEST adopted changes\n");
      expect(await admissionCreationTargetIdentity(input)).toBe(path);
      const unbound = { ...target };
      delete unbound.expectedRealPath;
      for (const changed of [
        unbound, { ...target, expectedRealPath: f.workspacePath },
        { ...target, expectedSourceRealPath: path }, { ...target, newBranch: "fix/TEST-other" },
        { ...target, expectedRevision: "0".repeat(40) },
      ]) expect(await admissionCreationTargetIdentity({ ...input, binding: { createWorktree: changed } })).toBeUndefined();
      await expect(access(path)).resolves.toBeUndefined();
    } else await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
