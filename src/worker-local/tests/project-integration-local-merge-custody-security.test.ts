import { chmod, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { applyWorkerOutput, runRequiredChecks, commitApprovedChanges, openProjectIntegrationAttempt, IntegrationAttemptStatus, type CheckRunnerPort } from "../../worker-core/index";
import { readGitBlobBatch } from "../git-blob-batch-reader";
import { SimpleSecretScanner } from "../simple-secret-scanner";
import { LocalGitIntegrationAdapter } from "../project-integration-local-adapters";
import { createMergeFixture, gitOutput } from "./project-integration-local-adapters.fixture";
import { createFixture, mergeInput, policy } from "../../worker-core/integration/tests/project-integration-use-cases.fixture";

function invalidUtf8Path(workspacePath: string): Buffer {
  return Buffer.concat([Buffer.from(join(workspacePath, "dir") + "/"), Buffer.from([255]), Buffer.from(".ts")]);
}

async function setup(unsupportedPath?: "backslash" | "replacement" | "invalid-utf8") {
  let repo = await createMergeFixture();
  if (unsupportedPath) {
    await mkdir(join(repo.workspacePath, "dir"));
    if (unsupportedPath === "backslash") {
      await writeFile(join(repo.workspacePath, "dir/hidden.ts"), "export const value = 3;\n");
      await writeFile(join(repo.workspacePath, "dir\\hidden.ts"), "export const value = 3;\n");
    } else {
      await writeFile(join(repo.workspacePath, "dir/\uFFFD.ts"), "export const value = 3;\n");
      if (unsupportedPath === "invalid-utf8") await writeFile(invalidUtf8Path(repo.workspacePath), "export const value = 3;\n");
    }
    await gitOutput(repo.workspacePath, ["add", "-A"]);
    await gitOutput(repo.workspacePath, ["commit", "-m", "test: add distinct tracked paths"]);
    repo = { ...repo, targetCommit: (await gitOutput(repo.workspacePath, ["rev-parse", "HEAD"])).trim() };
  }
  const fixture = createFixture(); const candidate = mergeInput();
  const localPolicy = { ...policy(), access: { ...policy().access, scope: { ...policy().access.scope!, workspaceRoots: [repo.workspacePath], worktreeRoots: [repo.workspacePath] } } };
  const git = new LocalGitIntegrationAdapter({ allowedPatchRoots: [repo.rootDir] });
  const deps = { ...fixture.deps(), git, scanner: new SimpleSecretScanner() };
  const opened = await openProjectIntegrationAttempt(deps, { ...candidate, policy: localPolicy, sourceWorkspacePath: repo.workspacePath, targetWorkspacePath: repo.workspacePath,
    merge: { ...candidate.merge, sourceCommit: repo.sourceCommit, expectedTargetCommit: repo.targetCommit },
    workerOutput: { ...candidate.workerOutput, workspacePath: repo.workspacePath, baseCommit: repo.targetCommit, patchPath: repo.patchPath, patchSha256: repo.patchSha256 } });
  if (!unsupportedPath) await applyWorkerOutput(deps, { attemptId: opened.attemptId });
  return { repo, fixture, deps, opened, localPolicy, cmd: async (args: string[]) => (await gitOutput(repo.workspacePath, args)).trim(),
    commit: () => commitApprovedChanges(deps, { attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: localPolicy }) };
}

describe("independent merge custody security regressions", () => {
  it("rejects wrong-tree same-parent recovery masked by a replacement ref", async () => {
    const f = await setup();
    try {
      const checked = await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId });
      const identity = ["-c", "user.name=Approved Integrator", "-c", "user.email=integrator@example.com"];
      const parents = ["-p", f.repo.targetCommit, "-p", f.repo.sourceCommit, "-m", "chore: merge reviewed output"];
      const approved = await f.cmd([...identity, "commit-tree", checked.authorizedMergeTree!, ...parents]);
      await writeFile(join(f.repo.workspacePath, "src/memory.ts"), "unreviewed recovery content\n");
      await f.cmd(["add", "src/memory.ts"]);
      const wrongTree = await f.cmd(["write-tree"]);
      const wrong = await f.cmd([...identity, "commit-tree", wrongTree, ...parents]);
      await f.cmd(["reset", "--hard", wrong]);
      await f.cmd(["replace", wrong, approved]);
      await f.cmd(["read-tree", "--reset", "-u", approved]);
      expect(await f.cmd(["--no-replace-objects", "rev-parse", "HEAD^{tree}"])).toBe(wrongTree);
      expect(wrongTree).not.toBe(checked.authorizedMergeTree);
      expect(await f.cmd(["--no-replace-objects", "show", "-s", "--format=%P", "HEAD"])).toBe(f.repo.targetCommit+" "+f.repo.sourceCommit);
      await expect(f.commit()).rejects.toThrow("merge_output_recovery_tree_mismatch");
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it("rejects raw worktree mutation hidden by a local clean filter before checks", async () => {
    const f = await setup();
    try {
      await writeFile(join(f.repo.workspacePath, ".git/info/attributes"), "src/memory.ts filter=reviewaudit\n");
      await f.cmd(["config", "filter.reviewaudit.clean", "sed 's/value = 999/value = 3/'"]);
      await writeFile(join(f.repo.workspacePath, "src/memory.ts"), "export const value = 999;\n");
      const run = f.deps.checks.runCheck.bind(f.deps.checks);
      const observed: string[] = [];
      vi.spyOn(f.deps.checks as CheckRunnerPort, "runCheck").mockImplementation(async input => {
        observed.push(await readFile(join(f.repo.workspacePath, "src/memory.ts"), "utf8"));
        return run(input);
      });
      await expect(runRequiredChecks(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
      expect(observed).toEqual([]);
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it.each([IntegrationAttemptStatus.Applied, IntegrationAttemptStatus.ChecksPassed])("refuses legacy %s migration without original patch hash", async status => {
    const f = await setup();
    try {
      const applied = status === IntegrationAttemptStatus.ChecksPassed
        ? await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId })
        : f.fixture.store.get(f.opened.attemptId)!;
      const { authorizedMergeTree: _tree, checkedReviewedTree: _checked, ...legacy } = applied;
      const { patchSha256: _hash, ...output } = legacy.workerOutput;
      f.fixture.store.update({ ...legacy, status, workerOutput: output });
      // Mutate both the patch and the live resolved file: neither is an authorized baseline.
      const patch = (await readFile(f.repo.patchPath, "utf8")).replace("+export const value = 3;", "+export const value = 999;");
      await writeFile(f.repo.patchPath, patch);
      await writeFile(join(f.repo.workspacePath, "src/memory.ts"), "export const value = 999;\n");
      await f.cmd(["add", "src/memory.ts"]);
      await expect(runRequiredChecks(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_original_evidence_required");
      expect(f.fixture.store.get(f.opened.attemptId)!.authorizedMergeTree).toBeUndefined();
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });
  it.each(["skip-worktree", "index-only", "hidden-source-file", "scanner-rejection"] as const)("retains %s rejection", async mutation => {
    const f = await setup();
    try {
      await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId });
      if (mutation === "scanner-rejection") {
        // Benign custom signature exercises the actual scanner and commit gate without a credential fixture.
        const scanner = new SimpleSecretScanner({ patterns: [/export const value = 3/] });
        await expect(commitApprovedChanges({ ...f.deps, scanner }, { attemptId: f.opened.attemptId,
          message: "chore: merge reviewed output", policy: f.localPolicy })).rejects.toMatchObject({ reason: "secret_scan_failed" });
      } else {
        const file = mutation === "hidden-source-file" ? "src/base-change.ts" : "src/memory.ts";
        const original = await readFile(join(f.repo.workspacePath, file));
        await writeFile(join(f.repo.workspacePath, file), "unreviewed bytes\n");
        if (mutation === "index-only") {
          await f.cmd(["add", file]); await writeFile(join(f.repo.workspacePath, file), original);
        } else {
          await f.cmd(["update-index", mutation === "skip-worktree" ? "--skip-worktree" : "--assume-unchanged", file]);
        }
        await expect(f.commit()).rejects.toThrow("merge_output_target_tree_mismatch");
      }
      expect(await f.cmd(["rev-parse", "HEAD"])).toBe(f.repo.targetCommit);
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it.each(["source", "target", "source-tree", "source-blob", "authorized-tree"] as const)("ignores replacement of %s throughout replay and explicit-env publication", async kind => {
    const f = await setup();
    const previous = process.env.GIT_NO_REPLACE_OBJECTS;
    try {
      const before = await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId });
      let original: string;
      let replacement: string;
      if (kind === "source") {
        original = f.repo.sourceCommit; replacement = f.repo.targetCommit;
      } else if (kind === "target") {
        original = f.repo.targetCommit; replacement = f.repo.sourceCommit;
      } else if (kind === "source-blob") {
        original = await f.cmd(["rev-parse", `${f.repo.sourceCommit}:src/memory.ts`]);
        replacement = await f.cmd(["rev-parse", `${f.repo.targetCommit}:src/memory.ts`]);
      } else {
        original = kind === "authorized-tree" ? before.authorizedMergeTree! : await f.cmd(["rev-parse", `${f.repo.sourceCommit}^{tree}`]);
        replacement = await f.cmd(["rev-parse", `${f.repo.targetCommit}^{tree}`]);
      }
      expect(original).not.toBe(replacement);
      await f.cmd(["replace", original, replacement]);
      process.env.GIT_NO_REPLACE_OBJECTS = "0";
      const checked = await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId });
      expect(checked.authorizedMergeTree).toBe(before.authorizedMergeTree);
      const result = await f.commit();
      expect(result.status).toBe(IntegrationAttemptStatus.CommitCreated);
      expect(await f.cmd(["--no-replace-objects", "rev-parse", `${result.commitCandidate!.commitSha}^{tree}`])).toBe(before.authorizedMergeTree);
      expect(await f.cmd(["--no-replace-objects", "show", "-s", "--format=%P", result.commitCandidate!.commitSha])).toBe(`${f.repo.targetCommit} ${f.repo.sourceCommit}`);
    } finally {
      if (previous === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
      else process.env.GIT_NO_REPLACE_OBJECTS = previous;
      await rm(f.repo.rootDir, { recursive: true, force: true });
    }
  });

  it.each(["during-check", "commit", "full-tree", "executable-mode"] as const)("rejects raw %s changes independently of Git normalization", async stage => {
    const f = await setup();
    try {
      const file = stage === "full-tree" ? "src/base-change.ts" : "src/memory.ts";
      await writeFile(join(f.repo.workspacePath, ".git/info/attributes"), `${file} filter=reviewaudit\n`);
      await f.cmd(["config", "filter.reviewaudit.clean", "sed 's/value = 999/value = 3/'"]);
      const mutate = async () => {
        if (stage === "executable-mode") {
          await f.cmd(["config", "core.fileMode", "false"]);
          await chmod(join(f.repo.workspacePath, file), 0o755);
        } else if (stage === "full-tree") {
          const original = await readFile(join(f.repo.workspacePath, file), "utf8");
          await f.cmd(["config", "filter.reviewaudit.clean", "sed 's/auditunreviewed//g'"]);
          await writeFile(join(f.repo.workspacePath, file), original + "auditunreviewed");
          await f.cmd(["update-index", "--assume-unchanged", file]);
        } else await writeFile(join(f.repo.workspacePath, file), "export const value = 999;\n");
      };
      if (stage === "during-check") {
        const run = f.deps.checks.runCheck.bind(f.deps.checks);
        vi.spyOn(f.deps.checks as CheckRunnerPort, "runCheck").mockImplementation(async input => { await mutate(); return run(input); });
        await expect(runRequiredChecks(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
      } else {
        await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId });
        await mutate();
        await expect(f.commit()).rejects.toThrow("merge_output_target_tree_mismatch");
      }
      expect(await f.cmd(["rev-parse", "HEAD"])).toBe(f.repo.targetCommit);
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it.each(["hash", "target", "source", "applied-source"] as const)("refuses invalid original %s evidence before legacy replay", async field => {
    const f = await setup();
    try {
      const applied = f.fixture.store.get(f.opened.attemptId)!;
      const { authorizedMergeTree: _tree, checkedReviewedTree: _checked, ...legacy } = applied;
      f.fixture.store.update({ ...legacy,
        ...(field === "hash" ? { workerOutput: { ...legacy.workerOutput, patchSha256: "invalid" } } : {}),
        ...(field === "target" ? { merge: { ...legacy.merge!, expectedTargetCommit: "HEAD" } } : {}),
        ...(field === "source" ? { merge: { ...legacy.merge!, sourceCommit: "" } } : {}),
        ...(field === "applied-source" ? { appliedMergeSourceCommit: "" } : {}),
      });
      await expect(runRequiredChecks(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_original_evidence_required");
      expect(f.fixture.store.get(f.opened.attemptId)!.authorizedMergeTree).toBeUndefined();
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it.each(["blob", "tree"] as const)("scanner rejects original benign signature despite %s replacement", async kind => {
    const f = await setup();
    try {
      const attempt = await runRequiredChecks(f.deps, { attemptId: f.opened.attemptId });
      const tree = attempt.authorizedMergeTree!;
      const original = await f.cmd(["rev-parse", kind === "blob" ? `${tree}:src/memory.ts` : tree]);
      const replacement = await f.cmd(["rev-parse", kind === "blob" ? `${f.repo.targetCommit}:src/memory.ts` : `${f.repo.targetCommit}^{tree}`]);
      const scanner = new SimpleSecretScanner({ patterns: [/export const value = 3/] });
      const input = { workspacePath: f.repo.workspacePath, files: ["src/memory.ts"], reviewedTree: tree, reviewedParent: f.repo.targetCommit };
      const expected = await scanner.scanFiles(input);
      expect(expected.status).toBe("failed");
      await f.cmd(["replace", original, replacement]);
      expect(await scanner.scanFiles(input)).toEqual(expected);
      if (kind === "blob") {
        const blobs = await readGitBlobBatch({ workspacePath: f.repo.workspacePath, objectNames: [original], maxBlobBytes: 1024,
          maxTotalBytes: 1024, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "0" } });
        expect(blobs[0]?.toString("utf8")).toBe("export const value = 3;\n");
      }
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it("rejects a tracked literal-backslash path instead of checking its slash alias", async () => {
    const f = await setup("backslash");
    try {
      await writeFile(join(f.repo.workspacePath, ".git/info/attributes"), "*.ts filter=reviewaudit\n");
      await f.cmd(["config", "filter.reviewaudit.clean", "sed 's/value = 999/value = 3/'"]);
      await writeFile(join(f.repo.workspacePath, "dir\\hidden.ts"), "export const value = 999;\n");
      // The distinct canonical path retains the same authorized blob, and Git's clean view hides tampering.
      expect(await readFile(join(f.repo.workspacePath, "dir/hidden.ts"), "utf8")).toBe("export const value = 3;\n");
      await f.cmd(["diff", "--quiet"]);
      const check = vi.spyOn(f.deps.checks, "runCheck");
      await expect(applyWorkerOutput(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
      expect(check).not.toHaveBeenCalled();
      expect(await f.cmd(["rev-parse", "HEAD"])).toBe(f.repo.targetCommit);
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it("rejects an ambiguous replacement-character Git pathname even when its bytes match", async () => {
    const f = await setup("replacement");
    try {
      const check = vi.spyOn(f.deps.checks, "runCheck");
      await expect(applyWorkerOutput(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
      expect(check).not.toHaveBeenCalled();
      expect(await f.cmd(["rev-parse", "HEAD"])).toBe(f.repo.targetCommit);
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("rejects invalid UTF-8 filename bytes aliasing a replacement-character pathname", async () => {
    const f = await setup("invalid-utf8");
    try {
      await writeFile(join(f.repo.workspacePath, ".git/info/attributes"), "*.ts filter=reviewaudit\n");
      await f.cmd(["config", "filter.reviewaudit.clean", "sed 's/value = 999/value = 3/'"]);
      await writeFile(invalidUtf8Path(f.repo.workspacePath), "export const value = 999;\n");
      expect(await readFile(join(f.repo.workspacePath, "dir/\uFFFD.ts"), "utf8")).toBe("export const value = 3;\n");
      await f.cmd(["diff", "--quiet"]);
      const check = vi.spyOn(f.deps.checks, "runCheck");
      await expect(applyWorkerOutput(f.deps, { attemptId: f.opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
      expect(check).not.toHaveBeenCalled();
      expect(await f.cmd(["rev-parse", "HEAD"])).toBe(f.repo.targetCommit);
    } finally { await rm(f.repo.rootDir, { recursive: true, force: true }); }
  });

});
