import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

// TEST seams only: Git fails as a bounded spawn does, and the fixture tree
// reads as root's. The refusal mapping under test runs for real.
const spawn = vi.hoisted(() => ({ code: "", configOk: true }));
vi.mock("node:child_process", async original => ({ ...await original<object>(), execFileSync: (_file: string, args: string[]) => {
  if (spawn.configOk && args[0] === "config") return Buffer.alloc(0);
  throw Object.assign(new Error(`TEST spawnSync /usr/bin/git ${spawn.code}`), { code: spawn.code });
} }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => Object.assign(fs.lstatSync(...args)!, { uid: 0 })) as typeof fs.lstatSync,
    fstatSync: ((...args: Parameters<typeof fs.fstatSync>) => Object.assign(fs.fstatSync(...args), { uid: 0 })) as typeof fs.fstatSync };
});
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: () => undefined }));
import { assertNoUnpublishedCommits, assertRetirementConfigInert, inspectRetirementRepository } from "../job-retirement/job-retirement-git";

const root = mkdtempSync(join(tmpdir(), "TEST-job-retirement-git-limits-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const workspace = join(root, "workspace"), config = join(root, "config");
mkdirSync(join(workspace, ".git"), { recursive: true, mode: 0o700 });
writeFileSync(config, "[core]\n\tbare = false\n", { mode: 0o600 });

it.each(["ETIMEDOUT", "ENOBUFS"])("keeps a Git run that hit its bound (%s) as git_limit_exceeded", code => {
  spawn.code = code;
  spawn.configOk = true;
  // Each of these catches maps any other Git failure to its own reason.
  expect(() => assertNoUnpublishedCommits(workspace, ["HEAD"], true)).toThrow("job_retirement_git_limit_exceeded");
  expect(() => inspectRetirementRepository(workspace)).toThrow("job_retirement_git_limit_exceeded");
  spawn.configOk = false;
  expect(() => assertRetirementConfigInert(config)).toThrow("job_retirement_git_limit_exceeded");
});

it("still maps any other Git failure to the reason of its check", () => {
  spawn.code = "EPIPE";
  spawn.configOk = true;
  expect(() => assertNoUnpublishedCommits(workspace, ["HEAD"])).toThrow("job_retirement_branch_unpublished_commits");
  expect(() => inspectRetirementRepository(workspace)).toThrow("job_retirement_manifest_invalid");
  spawn.configOk = false;
  expect(() => assertRetirementConfigInert(config)).toThrow("job_retirement_git_config_unsafe");
});
