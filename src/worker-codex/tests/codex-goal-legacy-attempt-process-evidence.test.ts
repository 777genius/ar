import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureLegacyAttemptProcessEvidence } from
  "../application/project-control/codex-goal-legacy-attempt-process-evidence";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

describe("legacy attempt process evidence", () => {
  it("hashes a bounded proc inventory and detects open custody descriptors", async () => {
    const root = await mkdtemp(join(tmpdir(), "legacy-attempt-proc-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    const processRoot = join(procRoot, "123");
    const custody = join(root, "custody");
    const elsewhere = join(root, "elsewhere");
    await mkdir(join(processRoot, "fd"), { recursive: true });
    await mkdir(custody);
    await mkdir(elsewhere);
    const held = join(custody, "held.lock");
    await writeFile(held, "held\n");
    await writeFile(join(processRoot, "cmdline"), "/bin/tool\0--safe\0");
    await writeFile(join(processRoot, "stat"),
      `123 (tool) S ${Array.from({ length: 19 }, (_, index) => index + 1).join(" ")} 999\n`);
    await symlink(elsewhere, join(processRoot, "cwd"));
    await symlink(held, join(processRoot, "fd", "3"));

    const evidence = await captureLegacyAttemptProcessEvidence({
      custodyPaths: [custody],
      procRoot,
      selfPid: 999,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(evidence).toMatchObject({
      inspectedPidCount: 1,
      inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      blockers: [{ pid: 123, cwd: elsewhere }],
    });
  });
});
