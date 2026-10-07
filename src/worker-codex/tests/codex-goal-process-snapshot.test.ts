import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCodexGoalProcessSnapshot, inspectCodexGoalProcessSnapshotRows, summarizeCodexGoalProcessTree } from "../codex-goal-process-snapshot";

describe("Codex goal process snapshot", () => {
  it("confirms a genuinely exited TEST child is absent from a successful process table", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid!;
    await once(child, "exit");
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(await inspectCodexGoalProcessSnapshot(pid)).toMatchObject({ alive: false });
  });

  it("keeps a native live process alive", async () => {
    expect(await inspectCodexGoalProcessSnapshot(process.pid)).toMatchObject({ alive: true });
  });

  it.each(["", "malformed table", "999 1 S 0 Thu Aug 21 02:00:00 2026 unrelated process"])(
    "rejects successful tables without an observable sentinel: %s", async (table) => {
      const root = await mkdtemp(join(tmpdir(), "sr-process-table-TEST-"));
      const previousPath = process.env.PATH;
      await writeFile(join(root, "ps"), `#!/bin/sh\nif [ "$1" = "-axo" ]; then\nprintf '%s\\n' '${table}'\nelse\nexit 1\nfi\n`, { mode: 0o700 });
      process.env.PATH = root;
      try {
        expect(await inspectCodexGoalProcessSnapshot(process.pid)).toEqual({});
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(root, { recursive: true, force: true });
      }
    });

  it("affirms absence from a successfully observed synthetic process table", () => {
    expect(inspectCodexGoalProcessSnapshotRows(100, [])).toEqual({ alive: false });
    expect(inspectCodexGoalProcessSnapshotRows(100, [{
      pid: 101, ppid: 1, cpu: 0, command: "unrelated synthetic process",
    }])).toEqual({ alive: false });
  });

  it("captures immutable start identities for the supervised process tree", () => {
    expect(
      summarizeCodexGoalProcessTree(100, [
        {
          pid: 100,
          ppid: 1,
          cpu: 0,
          startedAt: "Thu Aug 21 02:00:00 2026",
          command: "node subscription-runtime-codex-goal",
        },
        {
          pid: 101,
          ppid: 100,
          cpu: 0,
          startedAt: "Thu Aug 21 02:00:01 2026",
          command: "codex app-server --listen stdio://",
        },
      ]),
    ).toMatchObject({
      supervisorStartedAt: "Thu Aug 21 02:00:00 2026",
      processTreeIdentities: [
        { pid: 100, startedAt: "Thu Aug 21 02:00:00 2026" },
        { pid: 101, startedAt: "Thu Aug 21 02:00:01 2026" },
      ],
    });
  });

  it("does not treat app-server lifetime CPU as a live workload child", () => {
    expect(
      summarizeCodexGoalProcessTree(100, [
        {
          pid: 100,
          ppid: 1,
          cpu: 0,
          command: "node subscription-runtime-codex-goal",
        },
        {
          pid: 101,
          ppid: 100,
          cpu: 2.4,
          command: "codex app-server --listen stdio://",
        },
      ]),
    ).toMatchObject({
      alive: true,
      cpuActive: true,
      appServerAlive: true,
      appServerPid: 101,
      workloadProcessAlive: false,
    });
  });

  it("excludes the stable app-server infrastructure chain from workload", () => {
    const infrastructureRows = [
      {
        pid: 100,
        ppid: 1,
        cpu: 0,
        command: "node subscription-runtime-codex-goal",
      },
      {
        pid: 101,
        ppid: 100,
        cpu: 1.2,
        command: "node codex app-server --listen stdio://",
      },
      {
        pid: 102,
        ppid: 101,
        cpu: 0.2,
        command: "codex app-server --listen stdio://",
      },
      {
        pid: 103,
        ppid: 102,
        cpu: 0,
        command: "/opt/codex/codex-code-mode-host",
      },
    ] as const;
    const infrastructureOnly = summarizeCodexGoalProcessTree(
      100,
      infrastructureRows,
    );
    expect(infrastructureOnly).toMatchObject({
      appServerAlive: true,
      appServerPid: 101,
      workloadProcessAlive: false,
    });
    expect(infrastructureOnly).not.toHaveProperty("workloadProcessPid");
    expect(infrastructureOnly).not.toHaveProperty("workloadProcessCommand");

    const withLint = summarizeCodexGoalProcessTree(100, [
      ...infrastructureRows,
      { pid: 104, ppid: 103, cpu: 0, command: "sh -c pnpm eslint src" },
      { pid: 105, ppid: 104, cpu: 0, command: "pnpm eslint src" },
    ]);
    expect(withLint).toMatchObject({
      appServerAlive: true,
      workloadProcessAlive: true,
      workloadProcessPid: 104,
      workloadProcessCommand: "sh -c pnpm eslint src",
    });

    const afterLint = summarizeCodexGoalProcessTree(100, infrastructureRows);
    expect(afterLint).toMatchObject({
      appServerAlive: true,
      workloadProcessAlive: false,
    });
    expect(afterLint).not.toHaveProperty("workloadProcessPid");
    expect(afterLint).not.toHaveProperty("workloadProcessCommand");
  });

  it("does not treat a code-mode-host token in workload arguments as infrastructure", () => {
    const snapshot = summarizeCodexGoalProcessTree(100, [
      {
        pid: 100,
        ppid: 1,
        cpu: 0,
        command: "node subscription-runtime-codex-goal",
      },
      {
        pid: 101,
        ppid: 100,
        cpu: 0,
        command: "codex app-server --listen stdio://",
      },
      {
        pid: 102,
        ppid: 101,
        cpu: 0,
        command: "/opt/codex/codex-code-mode-host",
      },
      {
        pid: 103,
        ppid: 102,
        cpu: 0,
        command: "sh -c pnpm vitest codex-code-mode-host.test.ts",
      },
      {
        pid: 104,
        ppid: 103,
        cpu: 0,
        command: "pnpm vitest codex-code-mode-host.test.ts",
      },
    ]);

    expect(snapshot).toMatchObject({
      workloadProcessAlive: true,
      workloadProcessPid: 103,
      workloadProcessCommand: "sh -c pnpm vitest codex-code-mode-host.test.ts",
    });
  });
});
