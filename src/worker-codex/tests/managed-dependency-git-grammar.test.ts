import assert from "node:assert/strict";
import { it } from "vitest";
import { classifyManagedDependencyGitArgs, isManagedDependencySignedTaskId, ManagedDependencyGitOperation, ManagedDependencyGitRunner } from "../managed-dependency-git";

// Red: a genuinely signed task containing @ is denied, or an overlong/path
// identity is admitted before fixed protected task artifact selection.
it("managed task syntax retains the exact signed 128-character identity contract", () => {
  for (const value of ["task@1", "a".repeat(128), "_task", ".", ".."]) assert.equal(isManagedDependencySignedTaskId(value), true);
  for (const value of ["", "a".repeat(129), "task/name", "task\\name", "task\0name", "task name", "task\n", "task\r", "a".repeat(128) + "\n"]) assert.equal(isManagedDependencySignedTaskId(value), false);
});

// Red: a privileged helper accepts a config/helper override, mutable repository
// operation or generated-byte path before the actual current-purpose boundary.
it("managed Git syntax rejects execution and generated-content request shapes", () => {
  for (const args of [
    ["-c", "alias.reader=!touch marker", "reader"],
    ["--exec-path=/tmp/project", "status"],
    ["submodule", "update", "--init"], ["checkout", "HEAD"],
    ["diff", "--ext-diff", "--", "source.ts"],
    ["diff", "--no-ext-diff", "--textconv", "--", "source.ts"],
    ["diff", "--no-ext-diff", "--", "node_modules/fixture/index.js"],
    ["ls-tree", "-z", "HEAD", "--", "packages/live/node_modules/tool.js"],
    ["ls-files", "--stage", "-z", "--", "../external"],
    ["cat-file", "blob", "HEAD:node_modules/fixture/index.js"],
    ["add", "-A"], ["read-tree", "--reset", "HEAD"],
    ["apply", "--cached", "--unsafe-paths", "--whitespace=nowarn", "-"],
    ["apply", "--cached", "--whitespace=nowarn", "patch-from-model.diff"],
    ["diff", "--binary", "--no-index", "--", "/dev/null", "../auth.json"],
    ["diff", "--cached", "--no-ext-diff", "--name-only", "--no-renames", "--diff-filter=M", "-z", "a".repeat(40), "--"],
    ["diff", "--no-ext-diff", "--diff-filter=A", "--", "source.ts"],
  ]) assert.throws(() => classifyManagedDependencyGitArgs(args), /dependency_host_git_unsupported/);
});

// Red: the closed codec prevents the actual authored binary/status/history
// operations needed for useful terminal output while fixing execution forms.
it("managed Git syntax retains authored binary, tree and fixed identity operations", () => {
  assert.equal(classifyManagedDependencyGitArgs(["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"]), ManagedDependencyGitOperation.AuthoredDiff);
  assert.equal(classifyManagedDependencyGitArgs(["ls-tree", "-z", "HEAD", "--", "source.ts", ":(exclude)authored.ts"]), ManagedDependencyGitOperation.AuthoredTreeEntries);
  assert.equal(classifyManagedDependencyGitArgs(["rev-parse", "--verify", "HEAD"]), ManagedDependencyGitOperation.RepositoryIdentity);
  assert.equal(classifyManagedDependencyGitArgs(["apply", "--cached", "--whitespace=nowarn", "-"]), ManagedDependencyGitOperation.PrivateIndex);
  assert.equal(classifyManagedDependencyGitArgs(["diff", "--binary", "--no-index", "--", "/dev/null", "new-file.bin"]), ManagedDependencyGitOperation.AuthoredNoIndexDiff);
  assert.equal(classifyManagedDependencyGitArgs(["diff", "--cached", "--no-ext-diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", "a".repeat(40), "--"]), ManagedDependencyGitOperation.AuthoredDiff);
});

// Red: syntax-only read-tree/write-tree/apply reaches a live original index
// through the public command runner without a genuine retained scratch resource.
it("the public command runner refuses private-index operations before capture", async () => {
  for (const args of [["read-tree", "HEAD"], ["write-tree"], ["apply", "--cached", "--whitespace=nowarn", "-"]]) {
    await assert.rejects(new ManagedDependencyGitRunner().run({ command: "/usr/bin/git",
      cwd: "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-git-grammar-missing/workspace", args,
    }), /dependency_host_git_private_index_required/);
  }
});

// Red on the old actual adapter: raw overrides reach child_process instead of
// the domain error; the new boundary denies before spawning even absent TEST cwd.
it("actual managed adapter refuses an override before any Git process", async () => {
  await assert.rejects(new ManagedDependencyGitRunner().run({
    command: "/usr/bin/git", cwd: "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-git-grammar-missing/workspace",
    args: ["-c", "alias.reader=!touch marker", "reader"],
  }), /dependency_host_git_unsupported/);
});
