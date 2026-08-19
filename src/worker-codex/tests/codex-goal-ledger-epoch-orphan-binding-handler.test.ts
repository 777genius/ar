import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rename, rm, writeFile } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertConsumedOutputLedgerEpochOrphanBindingsUnchanged,
  LedgerEpochOrphanWorkspaceBindingRevalidationError,
} from "../application/project-control/codex-goal-consumed-output-ledger-epoch";
import { bindLedgerEpochOrphanWorkspace } from
  "../application/project-control/codex-goal-ledger-epoch-orphan-quarantine";

const execFileAsync = promisify(execFile);

describe("project control ledger epoch handler orphan binding revalidation", () => {
  it("caps sealed orphan binding observations at exactly eight", async () => {
    const fixture = await sealedBindingFixture();
    const shimRoot = await mkdtemp(join(tmpdir(), "ledger-binding-git-shim-"));
    const counterPath = join(shimRoot, "active-count");
    const maximumPath = join(shimRoot, "maximum-count");
    const lockPath = join(shimRoot, "counter-lock");
    const gitPath = (await execFileAsync("sh", ["-c", "command -v git"]))
      .stdout.trim();
    await writeFile(join(shimRoot, "git"), `#!${process.execPath}\n` +
      `const fs=require("node:fs"),cp=require("node:child_process");\n` +
      `const [counter,maximum,lock,git]=${JSON.stringify([
        counterPath, maximumPath, lockPath, gitPath,
      ])};\n` +
      `const locked=(fn)=>{for(;;){try{fs.mkdirSync(lock);break}catch{}}` +
      `try{return fn()}finally{fs.rmdirSync(lock)}};\n` +
      `const change=(delta)=>locked(()=>{const active=Number(` +
      `fs.existsSync(counter)?fs.readFileSync(counter,"utf8"):0)+delta;` +
      `fs.writeFileSync(counter,String(active));const prior=Number(` +
      `fs.existsSync(maximum)?fs.readFileSync(maximum,"utf8"):0);` +
      `fs.writeFileSync(maximum,String(Math.max(active,prior)))});\n` +
      `change(1);while(Number(fs.readFileSync(maximum,"utf8"))<8){` +
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}` +
      `const result=cp.spawnSync(git,process.argv.slice(2),{stdio:"inherit"});` +
      `change(-1);process.exit(result.status??1);\n`);
    await chmod(join(shimRoot, "git"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimRoot}:${originalPath ?? ""}`;
    try {
      await expect(assertConsumedOutputLedgerEpochOrphanBindingsUnchanged({
        orphanWorkspaceBindings: Array.from({ length: 24 }, () => fixture.binding),
        deniedRoots: [],
      })).resolves.toBeUndefined();
      expect(Number(await readFile(maximumPath, "utf8"))).toBe(8);
    } finally {
      process.env.PATH = originalPath;
      await rm(shimRoot, { recursive: true, force: true });
      await fixture.remove();
    }
  });

  it("ignores excluded files and git metadata during sealed binding validation", async () => {
    const fixture = await sealedBindingFixture();
    try {
      await writeFile(join(fixture.workspace, "runtime.scratch"), "ignored\n");
      await writeFile(join(fixture.workspace, ".git", "runtime-churn"), "changed\n");
      await expect(assertConsumedOutputLedgerEpochOrphanBindingsUnchanged({
        orphanWorkspaceBindings: [fixture.binding],
        deniedRoots: [],
      })).resolves.toBeUndefined();
    } finally {
      await fixture.remove();
    }
  });

  it("fails closed with binding location and mismatch category on actual drift", async () => {
    const fixture = await sealedBindingFixture();
    try {
      await writeFile(join(fixture.workspace, "tracked.txt"), "drifted\n");
      const error = await assertConsumedOutputLedgerEpochOrphanBindingsUnchanged({
        orphanWorkspaceBindings: [fixture.binding],
        deniedRoots: [],
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(
        LedgerEpochOrphanWorkspaceBindingRevalidationError,
      );
      expect(error).toMatchObject({
        category: "mismatch",
        bindingIndex: 0,
        bindingPath: fixture.workspace,
        message: "ledger_epoch_orphan_workspace_binding_drift",
      });
    } finally {
      await fixture.remove();
    }
  });

  it("reports a sealed binding observation failure without command output", async () => {
    const fixture = await sealedBindingFixture();
    try {
      await rename(join(fixture.workspace, ".git"), join(fixture.workspace, ".git-away"));
      const error = await assertConsumedOutputLedgerEpochOrphanBindingsUnchanged({
        orphanWorkspaceBindings: [fixture.binding],
        deniedRoots: [],
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        category: "observation_error",
        bindingIndex: 0,
        bindingPath: fixture.workspace,
        message: "ledger_epoch_orphan_workspace_binding_observation_error",
      });
      expect(String(error)).not.toContain("fatal:");
    } finally {
      await fixture.remove();
    }
  });
});

async function sealedBindingFixture() {
  const root = await mkdtemp(join(tmpdir(), "ledger-sealed-binding-"));
  const workspace = await realpath(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, ".gitignore"), "*.scratch\n");
  await writeFile(join(workspace, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=runtime", "-c", "user.email=runtime@invalid",
    "commit", "--quiet", "-m", "fixture",
  ], { cwd: workspace });
  await writeFile(join(workspace, "tracked.txt"), "sealed\n");
  const binding = await bindLedgerEpochOrphanWorkspace({
    workspacePath: workspace,
    deniedRoots: [],
  });
  if (!binding || binding.state !== "quarantined") {
    throw new Error("sealed_binding_fixture_invalid");
  }
  return {
    workspace,
    binding,
    remove: async () => await rm(root, { recursive: true, force: true }),
  };
}
