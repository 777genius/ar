import { describe, expect, it } from "vitest";
import { inspectCodexGoalProcessSnapshotRows, summarizeCodexGoalProcessTree } from "../codex-goal-process-snapshot";

describe("Codex goal process snapshot", () => {
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
