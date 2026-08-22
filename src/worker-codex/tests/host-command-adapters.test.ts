import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DfHostDiskUsageAdapter,
  ExecFileProjectControlGitAdapter,
  NodeProjectControlValidatorRunnerAdapter,
  type ProjectControlGitPort,
  type ProjectControlGitRunInput,
} from "../application/project-control/adapters/host-command-adapters";
import { execGitStdout } from "../application/project-control/codex-goal-project-git";
import { git, gitInitRepository, gitStdout } from "./codex-goal-mcp-test-support";

async function makeRepositoryWithTwoCommits(): Promise<{
  readonly root: string;
  readonly baseSha: string;
  readonly nextSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "host-command-adapter-"));
  await gitInitRepository(root);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "base.txt"]);
  await git(root, ["commit", "-m", "base"]);
  const baseSha = (await gitStdout(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "next.txt"), "next\n");
  await git(root, ["add", "next.txt"]);
  await git(root, ["commit", "-m", "next"]);
  const nextSha = (await gitStdout(root, ["rev-parse", "HEAD"])).trim();
  return { root, baseSha, nextSha };
}

describe("project-control host-command adapters", () => {
  it("git adapter run forwards the argument vector and returns stdout", async () => {
    const { root, nextSha } = await makeRepositoryWithTwoCommits();
    try {
      const adapter = new ExecFileProjectControlGitAdapter();
      const { stdout } = await adapter.run({
        args: ["-C", root, "rev-parse", "HEAD"],
      });
      expect(stdout.trim()).toBe(nextSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("git adapter run rejects and preserves the git exit code", async () => {
    const { root, baseSha, nextSha } = await makeRepositoryWithTwoCommits();
    try {
      const adapter = new ExecFileProjectControlGitAdapter();
      // next is not an ancestor of base, so git exits with code 1.
      const error = await adapter
        .run({
          args: ["-C", root, "merge-base", "--is-ancestor", nextSha, baseSha],
        })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as { readonly code?: unknown }).code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("git adapter runBuffered returns raw byte streams", async () => {
    const { root } = await makeRepositoryWithTwoCommits();
    try {
      const adapter = new ExecFileProjectControlGitAdapter();
      const { stdout } = await adapter.runBuffered({
        args: ["-C", root, "show", "HEAD:next.txt"],
      });
      expect(Buffer.isBuffer(stdout)).toBe(true);
      expect(stdout.toString("utf8")).toBe("next\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disk usage adapter reports available bytes for an existing path", async () => {
    const adapter = new DfHostDiskUsageAdapter();
    const availableBytes = await adapter.availableBytes({ path: tmpdir() });
    expect(typeof availableBytes).toBe("number");
    expect(availableBytes).toBeGreaterThan(0);
  });

  it("validator runner resolves on success and rejects on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-command-validator-"));
    try {
      const runner = new NodeProjectControlValidatorRunnerAdapter();
      const okValidator = join(root, "ok.mjs");
      const failValidator = join(root, "fail.mjs");
      await writeFile(okValidator, "process.exit(0)\n");
      await writeFile(failValidator, "process.exit(1)\n");

      await expect(
        runner.run({ validatorPath: okValidator, args: [], cwd: root }),
      ).resolves.toBeDefined();
      await expect(
        runner.run({ validatorPath: failValidator, args: [], cwd: root }),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("default host-command port substitution", () => {
  it("execGitStdout uses the real git adapter when no port is injected", async () => {
    const { root, nextSha } = await makeRepositoryWithTwoCommits();
    try {
      const head = await execGitStdout(["-C", root, "rev-parse", "HEAD"]);
      expect(head.trim()).toBe(nextSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("execGitStdout routes through an injected git port", async () => {
    const calls: ProjectControlGitRunInput[] = [];
    const fakeGit: ProjectControlGitPort = {
      async run(input) {
        calls.push(input);
        return { stdout: "injected-head\n", stderr: "" };
      },
      async runBuffered(input) {
        calls.push(input);
        return { stdout: Buffer.from(""), stderr: Buffer.from("") };
      },
    };

    const stdout = await execGitStdout(["status", "--porcelain"], fakeGit);

    expect(stdout).toBe("injected-head\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "--literal-pathspecs",
      "status",
      "--porcelain",
    ]);
    expect(calls[0]?.timeoutMs).toBe(120_000);
    expect(calls[0]?.maxBuffer).toBe(1024 * 1024);
  });
});
