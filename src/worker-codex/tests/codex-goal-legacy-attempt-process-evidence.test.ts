import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import type { Dir } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLegacyAttemptProcessEvidence } from
  "../application/project-control/codex-goal-legacy-attempt-process-evidence";

vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

describe("legacy attempt process evidence", () => {
  it("rejects global descriptor overflow across PIDs without partial evidence", async () => {
    const procRoot = "/TEST/legacy-attempt-budget/proc";
    let readDescriptorCount = 0;
    const closedPids: string[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(fs, "readdir").mockResolvedValue(["123", "124"] as never);
    vi.spyOn(fs, "readFile").mockImplementation(async path => {
      if (String(path).endsWith("/stat")) {
        return `123 (tool) S ${Array.from({ length: 19 }, (_, index) => index + 1).join(" ")} 999\n`;
      }
      return Buffer.from("/bin/tool\0");
    });
    vi.spyOn(fs, "readlink").mockImplementation(async path => {
      if (String(path).endsWith("/cwd")) return "/TEST/elsewhere";
      readDescriptorCount += 1;
      return "socket:[1]";
    });
    vi.spyOn(fs, "opendir").mockImplementation(async path => {
      const pid = String(path).split("/").at(-2)!;
      const count = pid === "123" ? 131_072 : 131_073;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (let fd = 0; fd < count; fd += 1) yield { name: String(fd) };
          } finally {
            closedPids.push(pid);
          }
        },
      } as unknown as Dir;
    });
    try {
      await expect(captureLegacyAttemptProcessEvidence({
        custodyPaths: ["/TEST/custody"], procRoot, selfPid: 999,
      })).rejects.toThrow("legacy_attempt_quarantine_process_fd_inventory_too_large");
      expect(readDescriptorCount).toBe(262_144);
      expect(closedPids).toEqual(["123", "124"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects an expired observation even with no PIDs to inspect", async () => {
    const root = await mkdtemp(join(tmpdir(), "legacy-attempt-deadline-"));
    roots.push(root);
    const clock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(0).mockReturnValue(30_001);
    try {
      await expect(captureLegacyAttemptProcessEvidence({
        custodyPaths: [join(root, "custody")], procRoot: root,
      })).rejects.toThrow("legacy_attempt_quarantine_process_inventory_timeout");
    } finally {
      clock.mockRestore();
    }
  });

  it("inspects all 8218 descriptors and detects custody beyond the former cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "legacy-attempt-large-proc-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    const processRoot = join(procRoot, "123");
    const custody = join(root, "custody");
    const elsewhere = join(root, "elsewhere");
    const descriptors = join(processRoot, "fd");
    await mkdir(descriptors, { recursive: true });
    await mkdir(custody);
    await mkdir(elsewhere);
    await writeFile(join(processRoot, "cmdline"), "/bin/tool\0");
    await writeFile(join(processRoot, "stat"),
      `123 (tool) S ${Array.from({ length: 19 }, (_, index) => index + 1).join(" ")} 999\n`);
    await symlink(elsewhere, join(processRoot, "cwd"));
    for (let fd = 0; fd < 8218; fd += 1) {
      await symlink(elsewhere, join(descriptors, String(fd)));
    }
    const input = { custodyPaths: [custody], procRoot, selfPid: 999 };
    expect((await captureLegacyAttemptProcessEvidence(input)).blockers).toEqual([]);
    await rm(join(descriptors, "8217"));
    await symlink(join(custody, "held.lock") + " (deleted)",
      join(descriptors, "8217"));
    expect((await captureLegacyAttemptProcessEvidence(input)).blockers)
      .toMatchObject([{ pid: 123 }]);
    await symlink(elsewhere, join(descriptors, "not-a-descriptor"));
    await expect(captureLegacyAttemptProcessEvidence(input))
      .rejects.toThrow("legacy_attempt_quarantine_process_fd_invalid");
  }, 30_000);

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
