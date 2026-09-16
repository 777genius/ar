import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SecretScanStatus, type PreparedReviewedGitCommit } from "@vioxen/subscription-runtime/worker-core";
import { commitReviewedIntegrationTree } from "../project-integration-reviewed-tree-commit";
import { reconcileReviewedIntegrationCommit } from "../project-integration-reviewed-tree-recovery";
import type { LocalGitOutputRollbackRuntime } from "../project-integration-local-output-rollback";

const fault = vi.hoisted(() => ({ rename: false, cleanup: false, lockCleanup: false, leftovers: [] as string[] }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fault.rename && String(args[0]).endsWith("index.lock")) throw new Error("fixture_index_rename");
      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fault.lockCleanup && String(args[0]).endsWith("index.lock")) throw new Error("fixture_lock_cleanup");
      if (fault.cleanup && /reviewed-(?:commit-index|index-recovery)-/.test(String(args[0]))) { fault.leftovers.push(String(args[0])); throw new Error("fixture_cleanup"); }
      return actual.rm(...args);
    },
  };
});
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  fault.rename = fault.cleanup = fault.lockCleanup = false;
  for (const root of [...roots.splice(0), ...fault.leftovers.splice(0)]) await rm(root, { force: true, recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reviewed-publication-test-")); roots.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  let casFault: "before" | "after" | undefined;
  let published = 0;
  const git: LocalGitOutputRollbackRuntime["git"] = async (args, workspacePath, env) => {
    if (args[0] === "update-ref" && casFault === "before") throw new Error("fixture_before_cas");
    const result = await exec("git", [...args], { cwd: workspacePath, ...(env ? { env } : {}) });
    if (args[0] === "update-ref") {
      published++;
      if (casFault === "after") throw new Error("fixture_after_cas");
    }
    return { ...result, exitCode: 0, timedOut: false };
  };
  const runtime: LocalGitOutputRollbackRuntime = {
    git,
    tryGit: async (args, workspacePath, env) => {
      try { return await git(args, workspacePath, env); }
      catch { return { exitCode: 1, stdout: "", stderr: "", timedOut: false }; }
    },
    getStatus: async () => ({ branch: "main", dirtyFiles: ["report.md"] }),
    canonicalWorkerPatch: async () => { throw new Error("unused"); },
    assertPatchSha256: async () => { throw new Error("unused"); },
  };
  const run = async (...args: string[]) => (await git(args, cwd)).stdout.trim();
  await run("init", "-b", "main");
  await run("config", "user.name", "iliya");
  await run("config", "user.email", "iliyazelenkog@gmail.com");
  await writeFile(join(cwd, "report.md"), "base\n");
  await run("add", "."); await run("commit", "-m", "test: base");
  const parent = await run("rev-parse", "HEAD");
  await writeFile(join(cwd, "report.md"), "reviewed\n");
  await run("add", "."); const tree = await run("write-tree");
  await run("reset", "--mixed", "HEAD");
  let prepared: PreparedReviewedGitCommit | undefined;
  const input = { runtime, workspacePath: cwd, parent, branch: "main", tree, message: "docs: report",
    identity: { name: "iliya", email: "iliyazelenkog@gmail.com" },
    verify: async () => {
      if (await readFile(join(cwd, "report.md"), "utf8") !== "reviewed\n") throw new Error("fixture_worktree_drift");
      if (await run("rev-parse", "HEAD") !== parent) throw new Error("fixture_head_drift");
      return tree;
    },
    onPrepared: async (value: PreparedReviewedGitCommit) => { prepared = value; },
  };
  return { cwd, run, input, setCasFault: (value: typeof casFault) => { casFault = value; },
    prepared: () => prepared!, published: () => published,
    reconcile: () => reconcileReviewedIntegrationCommit({ ...input, ...prepared! }) };
}

it.each(["before", "after"] as const)("reconciles exact prepared identity after a %s CAS transport failure", async (where) => {
  const f = await fixture(); f.setCasFault(where);
  await expect(commitReviewedIntegrationTree(f.input)).rejects.toThrow(`fixture_${where}_cas`);
  expect(f.prepared().commitSha).toMatch(/^[a-f0-9]{40}$/);
  if (where === "before") {
    expect(await f.reconcile()).toBeUndefined();
    expect(await f.run("rev-parse", "HEAD")).toBe(f.input.parent);
    f.setCasFault(undefined);
    const prepared = f.prepared();
    await commitReviewedIntegrationTree({ ...f.input, prepared: { ...prepared, reviewedOutputId: "fixture", identity: f.input.identity,
      candidate: { commitSha: prepared.commitSha, message: f.input.message, files: ["report.md"], createdAt: new Date().toISOString(), secretScanStatus: SecretScanStatus.Passed } } });
    expect(await f.run("rev-parse", "HEAD")).toBe(prepared.commitSha);
  }
  expect(await f.reconcile()).toMatchObject({ commitSha: f.prepared().commitSha, reviewedIndexRecoveryPending: false });
  expect(await f.reconcile()).toMatchObject({ commitSha: f.prepared().commitSha });
  expect(f.published()).toBe(1);
  expect(await f.run("status", "--porcelain")).toBe("");
});

it.each(["rename", "lock", "cleanup", "lock-cleanup"] as const)("preserves publication through %s failure and recovers independently", async (where) => {
  const f = await fixture();
  fault.rename = where === "rename" || where === "lock-cleanup"; fault.cleanup = where === "cleanup"; fault.lockCleanup = where === "lock-cleanup";
  const lock = join(f.cwd, ".git", "index.lock");
  if (where === "lock") {
    const onPrepared = f.input.onPrepared;
    f.input.onPrepared = async (prepared) => { await onPrepared(prepared); await writeFile(lock, "another writer\n"); };
  }
  const result = await commitReviewedIntegrationTree(f.input);
  expect(result.commitSha).toBe(f.prepared().commitSha);
  expect(result.reviewedIndexRecoveryPending).toBe(where !== "cleanup");
  if (where === "lock") { expect(await readFile(lock, "utf8")).toBe("another writer\n"); await rm(lock); }
  fault.rename = fault.cleanup = fault.lockCleanup = false;
  expect(await f.reconcile()).toMatchObject({ commitSha: result.commitSha, reviewedIndexRecoveryPending: false });
  expect(f.published()).toBe(1);
  expect(await f.run("status", "--porcelain")).toBe("");
});

it("runs the host author hook and rejects hook errors, index/message/worktree mutations", async () => {
  const f = await fixture(); const hook = join(f.cwd, ".git", "hooks", "pre-commit");
  for (const script of ["exit 1", "git read-tree HEAD", "printf 'drift' >> report.md"]) {
    await writeFile(hook, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    await expect(commitReviewedIntegrationTree(f.input)).rejects.toThrow();
    expect(f.prepared()).toBeUndefined();
    expect(await f.run("rev-parse", "HEAD")).toBe(f.input.parent);
    await writeFile(join(f.cwd, "report.md"), "reviewed\n");
  }
  await writeFile(hook, '#!/bin/sh\nset -eu\nfor kind in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do\ncase "$(git var "$kind")" in "iliya <iliyazelenkog@gmail.com> "*) ;; *) exit 1;; esac\ndone\n', { mode: 0o700 });
  const msgHook = join(f.cwd, ".git", "hooks", "commit-msg");
  await writeFile(msgHook, '#!/bin/sh\nprintf "drift" >> "$1"\n', { mode: 0o700 });
  await expect(commitReviewedIntegrationTree(f.input)).rejects.toThrow("hook_mutation");
  await rm(msgHook);
  await commitReviewedIntegrationTree(f.input);
  expect(await f.run("show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD")).toBe("iliya <iliyazelenkog@gmail.com>|iliya <iliyazelenkog@gmail.com>");
});

it.each(["before-publication", "after-publication", "index-lock", "after-index-rename"] as const)("recovers a killed child at %s from durable prepared evidence", async (window) => {
  const f = await fixture();
  const childRoot = await mkdtemp(join(tmpdir(), "reviewed-crash-child-")); roots.push(childRoot);
  const { transpileModule, ModuleKind, ScriptTarget } = await import("typescript");
  for (const name of ["project-integration-reviewed-tree-commit", "project-integration-reviewed-tree-recovery"]) {
    const source = await readFile(new URL(`../${name}.ts`, import.meta.url), "utf8");
    const crashSource = window === "after-index-rename" ? source.replace("await rename(lockPath, indexPath);", 'await rename(lockPath, indexPath); process.kill(process.pid, "SIGKILL");') : source;
    const output = transpileModule(crashSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
    await writeFile(join(childRoot, `${name}.mjs`), output.replaceAll('"./project-integration-reviewed-tree-recovery"', '"./project-integration-reviewed-tree-recovery.mjs"'));
  }
  const evidence = join(childRoot, "prepared.json");
  const child = join(childRoot, "child.mjs");
  await writeFile(child, `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { commitReviewedIntegrationTree } from "./project-integration-reviewed-tree-commit.mjs";
const window = ${JSON.stringify(window)};
const die = () => process.kill(process.pid, "SIGKILL");
const git = async (args, cwd, env) => {
  if (args[0] === "update-ref" && window === "before-publication") die();
  if (args[0] === "write-tree" && env?.GIT_INDEX_FILE?.includes("reviewed-index-recovery-") && window === "index-lock") die();
  const stdout = execFileSync("git", args, { cwd, env: env ?? process.env, encoding: "utf8" });
  if (args[0] === "update-ref" && window === "after-publication") die();
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
};
await commitReviewedIntegrationTree({
  ...${JSON.stringify({ workspacePath: f.cwd, parent: f.input.parent, branch: "main", tree: f.input.tree, identity: f.input.identity, message: f.input.message })},
  runtime: { git, tryGit: async (...args) => { try { return await git(...args); } catch { return { stdout: "", stderr: "", exitCode: 1, timedOut: false }; } } },
  verify: async () => ${JSON.stringify(f.input.tree)},
  onPrepared: async value => writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(value)),
});
`);
  await expect(exec(process.execPath, [child], { timeout: 15000, env: { ...process.env, TMPDIR: childRoot } })).rejects.toMatchObject({ signal: "SIGKILL" });
  const prepared = JSON.parse(await readFile(evidence, "utf8")) as PreparedReviewedGitCommit;
  const reconcile = () => reconcileReviewedIntegrationCommit({ ...f.input, ...prepared });
  if (window === "before-publication") {
    expect(await reconcile()).toBeUndefined();
    expect(await f.run("rev-parse", "HEAD")).toBe(f.input.parent);
    await commitReviewedIntegrationTree({ ...f.input, prepared: { ...prepared, reviewedOutputId: "fixture", identity: f.input.identity,
      candidate: { commitSha: prepared.commitSha, message: f.input.message, files: ["report.md"], createdAt: new Date().toISOString(), secretScanStatus: SecretScanStatus.Passed } } });
  } else {
    expect(await f.run("rev-parse", "HEAD")).toBe(prepared.commitSha);
    if (window === "index-lock") expect(await readFile(join(f.cwd, ".git", "index.lock"))).toHaveLength(0);
  }
  expect(await reconcile()).toMatchObject({ commitSha: prepared.commitSha, reviewedIndexRecoveryPending: false });
  expect(await f.run("status", "--porcelain")).toBe("");
  expect(await f.run("rev-list", "--count", `${f.input.parent}..HEAD`)).toBe("1");
});
