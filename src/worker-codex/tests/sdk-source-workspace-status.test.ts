import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { sdkSourceWorkspaceStatusReader } from "./sdk-source-workspace-status";

const execute = promisify(execFile), cleanup: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-source-status-")));
  cleanup.push(root); await chmod(root, 0o700);
  const source = join(root, "source"); await mkdir(source, { mode: 0o700 });
  await execute("/usr/bin/git", ["init", "--template=", "--initial-branch=main", source], {
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 5000,
  });
  return { root, source, read: await sdkSourceWorkspaceStatusReader(root) };
}
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("observes actual fresh clean and dirty Source facts without executing project fsmonitor", async () => {
  const { root, source, read } = await fixture(), script = join(root, "monitor"), marker = join(root, "executed");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await execute("/usr/bin/git", ["-C", source, "config", "core.fsmonitor", script], { timeout: 5000 });
  await expect(read(source)).resolves.toEqual({ exists: true, dirty: false, changedFiles: [] });
  await writeFile(join(source, "untracked\nname.txt"), "TEST actual untracked bytes\n");
  await expect(read(source)).resolves.toEqual({ exists: true, dirty: true, changedFiles: ["untracked\nname.txt"] });
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses foreign paths and replacement of an already observed Source directory", async () => {
  const { root, source, read } = await fixture();
  await expect(read(join(root, "foreign"))).rejects.toThrow("TEST_source_status_scope_invalid");
  await read(source); await rename(source, join(root, "original-source")); await mkdir(source, { mode: 0o700 });
  await expect(read(source)).rejects.toThrow("TEST_source_status_scope_invalid");
});
it("refuses linked Git metadata instead of discovering another repository", async () => {
  const { root, source, read } = await fixture();
  await rename(join(source, ".git"), join(root, "original-metadata"));
  await writeFile(join(source, ".git"), "gitdir: ../original-metadata\n");
  await expect(read(source)).rejects.toThrow("TEST_source_status_scope_invalid");
});
