import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AccessBoundary, AccessDecisionReason, LaunchPlanStatus, NetworkAccessMode, createAccessPolicyService } from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId, codexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { parseResearchOperatorRequest, researchRunConfig, type ResearchOperatorRequest } from "../research-launch-contract";
import { assertCodexGoalAccessLaunchAllowed, codexGoalControlsForAccessBoundary } from "../codex-goal-access-plan";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { ensureCodexAgentTempRoot } from "../../provider-codex/codex-runtime-temp";
import { appServerThreadStartParams } from "../../provider-codex/app-server/application/app-server-thread-start-params";
import { tryHandleAppServerApprovalRequest } from "../../provider-codex/app-server/application/app-server-approval-request-handler";
import { resolveCodexExecutionProfile } from "../../provider-codex/codex-execution-profile";

let root: string;
let request: ResearchOperatorRequest;
beforeEach(async () => {
  // All paths and bytes are synthetic and owned by this isolated TEST fixture.
  const parent = join(process.cwd(), "tmp");
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, "TEST-research-launch-access-r12-"));
  const jobRootDir = join(root, "TEST-project/jobs/TEST-research");
  request = parseResearchOperatorRequest({ schemaVersion: 1, jobId: "TEST-research", taskId: "TEST-source-canary",
    jobRootDir, workspacePath: join(jobRootDir, "workspace"), promptPath: join(jobRootDir, "prompt.md"),
    authRootDir: join(root, "TEST-auth"), accounts: ["TEST-account-a", "TEST-account-b"], codexBinaryPath: process.execPath,
    model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default", taskTimeoutMs: 1000 });
  for (const path of [request.workspacePath, request.authRootDir, join(jobRootDir, "state"), join(jobRootDir, "home"),
    join(root, "TEST-project/jobs/TEST-sibling/workspace"), join(root, "TEST-sibling-project/workspace"),
    join(root, "TEST-external/workspace"), join(root, "TEST-private-host-authority")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await writeFile(request.promptPath, "TEST public research prompt", { mode: 0o600 });
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("closed research launch configuration (source checks, no native launch)", () => {
  it.each(["nested", "separate"])("admits the actual %s workspace config through the unchanged launch validator", placement => {
    const selected = placement === "nested" ? request : parseResearchOperatorRequest({ ...request,
      workspacePath: join(root, "TEST-external/workspace") });
    const config = researchRunConfig(selected);
    const plan = assertCodexGoalAccessLaunchAllowed(config);
    expect(plan?.status).toBe(LaunchPlanStatus.Ready);
    expect(plan?.boundary).toBe(AccessBoundary.IsolatedWorkspaceWrite);
    if (plan?.status !== LaunchPlanStatus.Ready) throw new Error("expected TEST launch plan");
    expect(plan.networkPolicy.mode).toBe(NetworkAccessMode.Unrestricted);
    expect(plan.environmentPolicy.exposeAuthRoot).toBe(false);
    expect(codexGoalControlsForAccessBoundary(config)).toEqual({ editMode: "allow-edits", providerSandboxMode: "workspace-write" });
    // Removing only the derived scope reproduces immutable036's admission failure.
    const { projectAccessScope: _scope, ...oldConfig } = config;
    expect(() => assertCodexGoalAccessLaunchAllowed(oldConfig)).toThrow(
      "codex_goal_access_boundary_blocked:missing_project_scope:project scope is required for non-danger access boundaries");
  });

  it("permits selected workspace I/O and refuses external, sibling, account and private Host paths", async () => {
    const config = researchRunConfig(request);
    assertCodexGoalAccessLaunchAllowed(config);
    const policy = createAccessPolicyService({ boundary: config.accessBoundary!, scope: config.projectAccessScope! });
    const selected = join(request.workspacePath, "TEST-result.txt");
    expect(policy.canWritePath({ path: selected }).allowed).toBe(true);
    await writeFile(selected, "TEST workspace result");
    expect(policy.canReadPath({ path: selected, realPath: await realpath(selected) }).allowed).toBe(true);
    expect(await readFile(selected, "utf8")).toBe("TEST workspace result");
    for (const path of [join(root, "TEST-project/jobs/TEST-sibling/workspace"), join(root, "TEST-sibling-project/workspace"),
      join(root, "TEST-external/workspace"), request.jobRootDir, request.promptPath,
      join(request.jobRootDir, "state"), join(request.jobRootDir, "home"), join(root, "TEST-private-host-authority"),
      request.workspacePath + "-sibling", join(request.workspacePath, "../state")]) {
      expect(policy.canReadPath({ path }), path).toMatchObject({ allowed: false, reason: AccessDecisionReason.PathOutsideScope });
      expect(policy.canWritePath({ path }), path).toMatchObject({ allowed: false, reason: AccessDecisionReason.PathOutsideScope });
    }
    for (const path of [request.authRootDir, join(request.authRootDir, "TEST-account-a/auth.json"),
      join(request.authRootDir, "TEST-account-other/auth.json")]) {
      expect(policy.canReadPath({ path })).toMatchObject({ allowed: false, reason: AccessDecisionReason.AuthPathDenied });
      expect(policy.canWritePath({ path })).toMatchObject({ allowed: false, reason: AccessDecisionReason.AuthPathDenied });
    }
    for (const target of [request.authRootDir, join(root, "TEST-sibling-project/workspace")]) {
      const path = join(request.workspacePath, target === request.authRootDir ? "TEST-auth-link" : "TEST-sibling-link");
      await symlink(target, path);
      const realPath = await realpath(path);
      expect(policy.canReadPath({ path, realPath }).allowed).toBe(false);
      expect(policy.canWritePath({ path, realPath }).allowed).toBe(false);
    }
    expect(policy.canCreateJob({ jobId: "TEST-child" }).allowed).toBe(false);
    expect(policy.canStartWorker({ jobId: "TEST-child" }).allowed).toBe(false);
  });

  it("keeps agent temp in the existing native permission mechanism and carries config into executor composition", async () => {
    const config = researchRunConfig(request);
    const plan = assertCodexGoalAccessLaunchAllowed(config);
    if (plan?.status !== LaunchPlanStatus.Ready) throw new Error("expected TEST launch plan");
    const policy = createAccessPolicyService({ boundary: config.accessBoundary!, scope: config.projectAccessScope! });
    const temp = await ensureCodexAgentTempRoot({ sourceEnv: config.sourceEnv });
    expect(temp).toBe(join(request.jobRootDir, "tmp/agent"));
    // Temp is not admitted by widening the project or job root scope.
    expect(policy.canWritePath({ path: temp! }).allowed).toBe(false);
    await writeFile(join(temp!, "TEST-scratch.txt"), "TEST scratch bytes");
    expect(await readFile(join(temp!, "TEST-scratch.txt"), "utf8")).toBe("TEST scratch bytes");
    const egress = codexProviderEgressPolicy(CodexProviderEgressProfileId.PublicResearchV1);
    const options = buildCodexGoalExecutorOptions({ config, providerEgressPolicy: egress,
      stateRootDir: config.stateRootDir!, encryptionKey: new Uint8Array(32) });
    expect(options.accounts).toHaveLength(request.accounts.length);
    expect(options.prewarmOnStart).toBe(true);
    expect(options.requireGitWorkspace).toBe(true);
    for (const account of options.accounts) {
      expect(account.worker.enforceProjectReadBoundary).toBe(true);
      expect(account.worker.commandPolicy?.validateCommands).toBe(true);
      expect(account.worker.model).toBe("gpt-6.1-sol");
      expect(account.worker.reasoningEffort).toBe("xhigh");
      expect(account.worker.serviceTier).toBe("default");
      expect(account.worker.publicSourceReader).toBe(options.accounts[0]!.worker.publicSourceReader);
      const thread = appServerThreadStartParams({ workspacePath: config.workspacePath, model: account.worker.model!,
        reasoningEffort: account.worker.reasoningEffort!, serviceTier: account.worker.serviceTier!,
        sandboxMode: codexGoalControlsForAccessBoundary(config).providerSandboxMode!, goalMode: account.worker.executionEngine === "app-server-goal" }, {
        sourceEnv: account.worker.sourceEnv!, executionProfile: resolveCodexExecutionProfile(account.worker.executionProfile),
        hostedPermissionProfiles: account.worker.enforceProjectReadBoundary!, providerEgressPolicy: egress,
        publicSourceReader: account.worker.publicSourceReader! });
      if (!("permissions" in thread.params)) throw new Error("expected TEST hosted permission profile");
      expect(thread.params.permissions).toBe("hosted-project-write");
      expect(thread.params.runtimeWorkspaceRoots).toEqual([request.workspacePath, temp]);
      expect(thread.params.dynamicTools?.map(tool => tool.name)).toEqual(["public_source_read"]);
      expect(thread.params.config.features).not.toHaveProperty("fast_mode");
    }
  });

  it.each(["projectAccessScope", "sourceEnv", "mounts"])("rejects a caller-controlled %s bag before deriving configuration", field => {
    expect(() => parseResearchOperatorRequest({ ...request, [field]: { root: "/" } })).toThrow();
  });

  it("preserves the finite durable sink without adding it to worker permissions", () => {
    const sink = join(root, "TEST-registry/durable-handoffs");
    const config = researchRunConfig(parseResearchOperatorRequest({ ...request, durableHandoffRootDir: sink }));
    expect(config.durableHandoffRootDir).toBe(sink);
    const policy = createAccessPolicyService({ boundary: config.accessBoundary!, scope: config.projectAccessScope! });
    expect(policy.canReadPath({ path: sink }).allowed).toBe(false);
    expect(policy.canWritePath({ path: sink }).allowed).toBe(false);
    expect(researchRunConfig(request)).not.toHaveProperty("durableHandoffRootDir");
    expect(() => parseResearchOperatorRequest({ ...request, durableHandoffRootDir: undefined })).toThrow();
    expect(() => parseResearchOperatorRequest({ ...request, durableHandoffRootDir: "/TEST-registry/../auth" })).toThrow();
  });

  it("denies provider requests to expand the scoped permission roots", () => {
    const config = researchRunConfig(request);
    assertCodexGoalAccessLaunchAllowed(config);
    const replies: string[] = [];
    for (const deniedRoot of [request.authRootDir, join(root, "TEST-sibling-project/workspace"), join(root, "TEST-private-host-authority")]) {
      expect(tryHandleAppServerApprovalRequest({ id: 1, method: "item/permissions/requestApproval",
        params: { permissions: { filesystem: { read: [deniedRoot], write: [deniedRoot] } } },
        reviewCommand: () => { throw new Error("unexpected TEST command review"); }, warn: () => {},
        respond: () => { throw new Error("unexpected TEST permission grant"); }, respondError: (_id, error) => replies.push(error) })).toBe(true);
    }
    expect(replies).toEqual(Array(3).fill("codex_app_server_permission_request_denied"));
  });
});
