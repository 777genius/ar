import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceEffectFingerprint } from "../agent-runtime-task-runner/workspace-effect-fingerprint";

const execFileAsync = promisify(execFile);

describe("workspaceEffectFingerprint", () => {
  it("changes for staged, unstaged and untracked effects", async () => {
    const cwd = await createGitFixture();
    try {
      const initial = await workspaceEffectFingerprint(cwd);
      await writeFile(join(cwd, "tracked.txt"), "unstaged\n");
      const unstaged = await workspaceEffectFingerprint(cwd);
      await git(cwd, ["add", "tracked.txt"]);
      const staged = await workspaceEffectFingerprint(cwd);
      await writeFile(join(cwd, "untracked.txt"), "first\n");
      const untracked = await workspaceEffectFingerprint(cwd);
      await writeFile(join(cwd, "untracked.txt"), "second\n");
      const changedUntracked = await workspaceEffectFingerprint(cwd);

      expect(new Set([
        initial,
        unstaged,
        staged,
        untracked,
        changedUntracked,
      ]).size).toBe(5);
      expect(await workspaceEffectFingerprint(cwd)).toBe(changedUntracked);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("covers exact Git-visible effects but excludes ignored filesystem state", async () => {
    const cwd = await createGitFixture();
    try {
      await writeFile(join(cwd, ".gitignore"), "*.cache\n");
      await writeFile(join(cwd, "tracked.cache"), "tracked initial\n");
      await git(cwd, ["add", ".gitignore"]);
      await git(cwd, ["add", "--force", "tracked.cache"]);
      await git(cwd, ["commit", "-m", "configure ignored fixture"]);
      const initial = await workspaceEffectFingerprint(cwd);

      await writeFile(join(cwd, "ignored.cache"), "ignored first\n");
      const ignoredCreated = await workspaceEffectFingerprint(cwd);
      await writeFile(join(cwd, "ignored.cache"), "ignored second\n");
      const ignoredChanged = await workspaceEffectFingerprint(cwd);
      expect(ignoredCreated).toBe(initial);
      expect(ignoredChanged).toBe(initial);

      await writeFile(join(cwd, "tracked.cache"), "tracked changed\n");
      const trackedIgnoredPattern = await workspaceEffectFingerprint(cwd);
      await writeFile(join(cwd, "visible.txt"), "nonignored untracked\n");
      const nonignoredUntracked = await workspaceEffectFingerprint(cwd);
      expect(trackedIgnoredPattern).not.toBe(initial);
      expect(nonignoredUntracked).not.toBe(trackedIgnoredPattern);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("disables configured textconv and external diff executables", async () => {
    const cwd = await createGitFixture();
    const marker = join(cwd, "textconv-executed");
    const script = join(cwd, "hostile-textconv.sh");
    try {
      await writeFile(
        script,
        `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nprintf converted\n`,
        { mode: 0o700 },
      );
      await chmod(script, 0o700);
      await writeFile(join(cwd, ".gitattributes"), "*.txt diff=hostile\n");
      await git(cwd, ["add", ".gitattributes"]);
      await git(cwd, ["commit", "-m", "configure attributes"]);
      await git(cwd, ["config", "diff.hostile.textconv", script]);
      await git(cwd, ["config", "diff.hostile.command", script]);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");

      await workspaceEffectFingerprint(cwd);

      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function createGitFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-fingerprint-"));
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await writeFile(join(cwd, "tracked.txt"), "initial\n");
  await git(cwd, ["add", "tracked.txt"]);
  await git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
