import { basename, join } from "node:path";
import { mkdir, readFile, lstat, readdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { AccessBoundary, AccessDecisionReason, ProjectAdmissionDecisionReason, ProjectDebtReason } from "@vioxen/subscription-runtime/worker-core";
import { describe, callToolJson as callAllocatedToolJson } from "./codex-goal-mcp-project-admission-test-fixture";
import { setupResearchFixture, cleanupResearchFixture, host, researchScratchBackingPath } from "./research-launch-fixture";
import { callToolJson, git, gitStdout, writeFakeAuth } from "./codex-goal-mcp-test-support";
import { assertHostedTestEgressDirectory } from "../hosted-test-egress-files";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { readCodexGoalJob } from "../codex-goal-jobs";
import { assertHostedDependencyPhysicalWorkspace, type HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";

describe("original public SDK physical N3 workspace", () => {
  it("creates a standalone repository through public controller/refill and passes the unchanged physical gate", async () => {
    // Allocate real backing in the fixture's disposable Linux scratch parent;
    // CI does not need an installed host-policy tree for this physical gate.
    cleanupResearchFixture();
    setupResearchFixture({ nativeBackingFacts: true });
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
      GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })) vi.stubEnv(name, value);
    const job = host.root, jobId = basename(job), workspace = join(job, "workspace"), registry = join(job, "state/registry"), auth = join(job, "auth"),
      source = join(job, "source"), controllerId = "TEST-standalone-controller", controllerRoot = join(job, "controller");
    const server = createCodexGoalMcpServer(), client = new Client({ name: "Source-physical-SDK", version: "1" }), [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await mkdir(source, { mode: 0o700 }); await git(source, ["init", "--template=", "--initial-branch=main"]);
      for (const kind of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) expect((await gitStdout(source, ["var", kind])).trim()).toMatch(/^iliya <iliyazelenkog@gmail.com> /);
      await writeFile(join(source, "README.md"), "Original public standalone SDK Source fixture.\n");
      await git(source, ["add", "README.md"]); await git(source, ["commit", "-m", "test: original standalone SDK fixture"]);
      const revision = (await gitStdout(source, ["rev-parse", "HEAD"])).trim(), branch = "test/standalone-sdk";
      // Reproduce the previous producer's real linked metadata at the exact W,
      // and prove the production physical guard refuses it before refill.
      await git(source, ["worktree", "add", "-b", "test/linked-before-refill", workspace, revision]);
      const linkedIdentity = await lstat(workspace, { bigint: true });
      const linkedBinding: HostedDependencyBinding = { version: 1, jobId, jobRootDir: job, workspace: { canonicalPath: workspace,
        dev: linkedIdentity.dev.toString(), ino: linkedIdentity.ino.toString() }, installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64) };
      expect((await lstat(join(workspace, ".git"))).isFile()).toBe(true);
      expect(() => assertHostedDependencyPhysicalWorkspace(linkedBinding)).toThrow("dependency_admission:unsupported");
      await git(source, ["worktree", "remove", "--force", workspace]);
      const authStat = await lstat(auth); expect(authStat.isDirectory()).toBe(true); expect(authStat.uid).toBe(0); expect(authStat.mode & 0o777).toBe(0o700);
      // Original cold initialization: empty private namespaces precede admission.
      // Only this TEST fixture's projection is created; all guards read it.
      const policy = "/var/lib/subscription-runtime-host-policy", projectedPolicy = join(job, "absent");
      expect(researchScratchBackingPath(projectedPolicy)).toBe(projectedPolicy);
      await mkdir(projectedPolicy, { mode: 0o700 });
      for (const name of ["ordinary-origins", "ordinary-starts", "codex-readonly-custody", "codex-readonly-revoked"]) {
        const namespace = join(policy, name), projected = join(projectedPolicy, name);
        expect(researchScratchBackingPath(namespace)).toBe(projected);
        expect(await assertHostedTestEgressDirectory(namespace, true)).toBe(true);
        const stat = await lstat(projected); expect(stat.isDirectory()).toBe(true); expect(stat.uid).toBe(0); expect(stat.mode & 0o777).toBe(0o700);
        expect(await readdir(projected)).toEqual([]);
      }
      await writeFakeAuth(auth, "account-a", { lastRefresh: new Date().toISOString() });
      await Promise.all([server.connect(st), client.connect(ct)]);
      const scope = { projectId: "Source-standalone-sdk", workspaceRoots: [source], worktreeRoots: [workspace], registryRoot: registry, authRoot: auth,
        jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"], allowedBranches: ["main", revision, branch], allowedGitRemotes: ["origin"], allowedAccountIds: ["account-a"] };
      const controller = await callAllocatedToolJson(client, "codex_goal_create_job", { jobId: controllerId, taskId: controllerId, registryRootDir: registry,
        jobRootDir: controllerRoot, workspacePath: source, promptPath: join(controllerRoot, "prompt.md"), authRootDir: auth, accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: scope });
      if (controller.ok !== true) throw new Error(JSON.stringify(controller));
      const request = { controllerJobId: controllerId, jobId, taskId: jobId, registryRootDir: registry, jobRootDir: job, workspacePath: workspace,
        cwd: workspace, sourceWorkspacePath: source, baseBranch: "main", sourceRef: revision, newBranch: branch,
        promptBody: "Original public physical N3 Source regression.\n", authRootDir: auth, accounts: ["account-a"], stateRootDir: join(job, "state"),
        progressPath: join(job, jobId + ".progress.json"), logPath: join(job, jobId + ".log"), outputPath: join(job, jobId + ".latest-result.json"),
        executionEngine: "app-server-goal", durableHandoffRootDir: join(job, "durable-handoffs"), prewarmOnStart: false, startWorker: false, confirmRefill: true };
      const result = await callToolJson(client, "codex_goal_project_refill_worker", request);
      if (result.ok !== true) throw new Error(JSON.stringify(result));
      const manifest = await readCodexGoalJob({ registryRootDir: registry, jobId });
      expect(manifest.workspacePath).toBe(workspace); expect(manifest.projectAccessScope?.workspaceRoots).toEqual([workspace]);
      const metadata = await lstat(join(workspace, ".git")); expect(metadata.isDirectory()).toBe(true); expect(metadata.isSymbolicLink()).toBe(false);
      expect(await readdir(join(workspace, ".git"))).not.toContain("commondir");
      expect((await gitStdout(workspace, ["rev-parse", "HEAD"])).trim()).toBe(revision);
      expect((await gitStdout(workspace, ["rev-parse", "HEAD^{tree}"])).trim()).toBe((await gitStdout(source, ["rev-parse", revision + "^{tree}"])).trim());
      expect((await gitStdout(workspace, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
      expect((await gitStdout(source, ["rev-parse", "refs/heads/" + branch])).trim()).toBe(revision);
      expect((await gitStdout(workspace, ["remote"])).trim()).toBe("");
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("Original public standalone SDK Source fixture.\n");
      const identity = await lstat(workspace, { bigint: true });
      const binding: HostedDependencyBinding = { version: 1, jobId, jobRootDir: job, workspace: { canonicalPath: workspace, dev: identity.dev.toString(), ino: identity.ino.toString() },
        installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64) };
      expect(() => assertHostedDependencyPhysicalWorkspace(binding)).not.toThrow();
      // Idempotent public refill preserves the actual standalone identity.
      const second = await callToolJson(client, "codex_goal_project_refill_worker", request);
      if (second.ok !== true) {
        const admission = second.admission as { readonly reason?: unknown; readonly examples?: readonly { readonly reason?: unknown }[] } | undefined;
        const knownErrors = [
          ...Object.values(ProjectAdmissionDecisionReason).map(reason => `project_control_admission_denied:${reason}`),
          ...Object.values(AccessDecisionReason).map(reason => `project_control_denied:${reason}`),
          "project_control_existing_worktree_invalid", "project_control_existing_worktree_dirty",
          "project_control_existing_worktree_real_path_outside_scope", "project_control_existing_worktree_real_path_changed",
          "project_control_existing_worktree_branch_mismatch", "project_control_existing_worktree_revision_mismatch",
          "project_control_existing_prompt_mismatch", "project_control_prompt_mismatch",
          "project_control_refill_no_ready_account", "protected_job_birth_authority_invalid", "protected_job_birth_publication_busy",
        ];
        console.error(JSON.stringify({ phase: "second_refill", ok: false,
          errorCode: knownErrors.find(code => code === second.error) ?? "unrecognized",
          admissionReason: Object.values(ProjectAdmissionDecisionReason).find(reason => reason === admission?.reason) ?? "unrecognized",
          debtReasons: Array.isArray(admission?.examples) ? admission.examples.slice(0, 2).map(item =>
            Object.values(ProjectDebtReason).find(reason => reason === item?.reason) ?? "unrecognized") : [],
        }));
      }
      expect(second.ok).toBe(true);
      const retained = await lstat(workspace, { bigint: true }); expect([retained.dev, retained.ino]).toEqual([identity.dev, identity.ino]);
    } finally { await client.close(); await server.close(); vi.unstubAllEnvs(); }
  }, 30000);
});
