import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectDebtReason } from "@vioxen/subscription-runtime/worker-core";
import {
  DEFAULT_ORPHAN_GIT_STATUS_TIMEOUT_MS,
  MAX_ORPHAN_GIT_STATUS_TIMEOUT_MS,
  ORPHAN_GIT_STATUS_TIMEOUT_ENV,
  normalizeOrphanGitStatusTimeoutMs,
  orphanDirtyWorkspaceDebt,
} from "../application/project-control/codex-goal-project-orphan-workspace-admission";

const emptyConsumedOutput = {
  byJobId: new Map(),
  byWorkspace: new Map(),
  debt: [],
};

describe("orphan workspace git status admission", () => {
  it("strictly normalizes the configured timeout and applies its safe cap", () => {
    expect(normalizeOrphanGitStatusTimeoutMs(undefined)).toBe(
      DEFAULT_ORPHAN_GIT_STATUS_TIMEOUT_MS,
    );
    for (const invalid of ["", "0", "-1", " 50", "50 ", "1.5", "1e3", "abc",
      "9007199254740992"]) {
      expect(normalizeOrphanGitStatusTimeoutMs(invalid)).toBe(
        DEFAULT_ORPHAN_GIT_STATUS_TIMEOUT_MS,
      );
    }
    expect(normalizeOrphanGitStatusTimeoutMs("45000")).toBe(45_000);
    expect(normalizeOrphanGitStatusTimeoutMs("999999")).toBe(
      MAX_ORPHAN_GIT_STATUS_TIMEOUT_MS,
    );
  });

  it("allows a slow clean workspace that completes inside the configured bound", async () => {
    await withFakeGit(async ({ root, workspace, setBehavior }) => {
      await workspace("project-slow-clean");
      await setBehavior("project-slow-clean", "delay-clean:50");

      await expect(scan(root, "5000")).resolves.toEqual([]);
    });
  });

  it("fails closed with evidence when git status exceeds the configured bound", async () => {
    await withFakeGit(async ({ root, workspace, setBehavior }) => {
      const path = await workspace("project-timeout");
      await setBehavior("project-timeout", "delay-clean:250");

      const debt = await scan(root, "20");
      expect(debt).toEqual([expect.objectContaining({
        reason: ProjectDebtReason.UnreadableWorkspace,
        subject: path,
        severity: "blocking",
        evidence: [expect.stringContaining("git status failed: timed out after 20ms")],
      })]);
    });
  });

  it("fails closed with useful evidence when git status exits nonzero", async () => {
    await withFakeGit(async ({ root, workspace, setBehavior }) => {
      const path = await workspace("project-nonzero");
      await setBehavior("project-nonzero", "nonzero");

      const debt = await scan(root, "5000");
      expect(debt).toEqual([expect.objectContaining({
        reason: ProjectDebtReason.UnreadableWorkspace,
        subject: path,
        severity: "blocking",
        evidence: [expect.stringContaining("deliberate git status failure")],
      })]);
    });
  });

  it("skips missing .git and preserves serial scan and debt ordering", async () => {
    await withFakeGit(async ({ root, logPath, workspace, setBehavior }) => {
      const first = await workspace("project-z-first");
      await workspace("project-missing-git", false);
      const second = await workspace("project-a-second");
      await setBehavior(basename(first), "dirty:first");
      await setBehavior(basename(second), "dirty:second");
      const expectedOrder = (await readdir(root))
        .filter((name) => name !== "project-missing-git")
        .map((name) => join(root, name));

      const debt = await scan(root, "5000");
      expect(debt.map((item) => item.subject)).toEqual(expectedOrder);
      expect(debt.map((item) => item.reason)).toEqual([
        ProjectDebtReason.OrphanLegacyWorkspace,
        ProjectDebtReason.OrphanLegacyWorkspace,
      ]);
      expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual(
        expectedOrder,
      );
    });
  });
});

async function scan(root: string, timeoutMs: string) {
  const previous = process.env[ORPHAN_GIT_STATUS_TIMEOUT_ENV];
  process.env[ORPHAN_GIT_STATUS_TIMEOUT_ENV] = timeoutMs;
  try {
    return await orphanDirtyWorkspaceDebt({
      root,
      prefixes: ["project-"],
      knownWorkspacePaths: new Set(),
      consumedOutput: emptyConsumedOutput,
      orphanWorkspaceBindings: [],
      deniedRoots: [],
    });
  } finally {
    if (previous === undefined) delete process.env[ORPHAN_GIT_STATUS_TIMEOUT_ENV];
    else process.env[ORPHAN_GIT_STATUS_TIMEOUT_ENV] = previous;
  }
}

async function withFakeGit(run: (fixture: {
  readonly root: string;
  readonly logPath: string;
  workspace(name: string, git?: boolean): Promise<string>;
  setBehavior(name: string, behavior: string): Promise<void>;
}) => Promise<void>): Promise<void> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "orphan-git-status-admission-"));
  const root = join(fixtureRoot, "worktrees");
  const bin = join(fixtureRoot, "bin");
  const logPath = join(fixtureRoot, "git-calls.log");
  const previousPath = process.env.PATH;
  const previousLog = process.env.FAKE_GIT_CALL_LOG;
  await mkdir(root);
  await mkdir(bin);
  const fakeGitPath = join(bin, "git");
  await writeFile(fakeGitPath, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const workspace = process.argv[3];
fs.appendFileSync(process.env.FAKE_GIT_CALL_LOG, workspace + "\\n");
const behavior = fs.readFileSync(path.join(workspace, ".fake-git-behavior"), "utf8");
if (behavior.startsWith("delay-clean:")) {
  setTimeout(() => process.exit(0), Number(behavior.slice("delay-clean:".length)));
} else if (behavior === "nonzero") {
  process.stderr.write("deliberate git status failure\\n");
  process.exit(7);
} else if (behavior.startsWith("dirty:")) {
  process.stdout.write(" M " + behavior.slice("dirty:".length) + ".txt\\n");
} else {
  process.exit(0);
}
`);
  await chmod(fakeGitPath, 0o755);
  process.env.PATH = bin;
  process.env.FAKE_GIT_CALL_LOG = logPath;
  try {
    await run({
      root,
      logPath,
      async workspace(name, git = true) {
        const path = join(root, name);
        await mkdir(path);
        if (git) await mkdir(join(path, ".git"));
        await writeFile(join(path, ".fake-git-behavior"), "clean");
        return path;
      },
      async setBehavior(name, behavior) {
        await writeFile(join(root, name, ".fake-git-behavior"), behavior);
      },
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FAKE_GIT_CALL_LOG;
    else process.env.FAKE_GIT_CALL_LOG = previousLog;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
