import { describe, expect, it } from "vitest";

import {
  DurableHandoffPostStopError,
  DurableHandoffStopError,
  preserveTerminalHandoffBeforeForcedStop,
  preserveTerminalHandoffBeforeStop,
} from "../codex-goal-preserve-before-stop";

describe("preserve before stop", () => {
  it("does not call the stored stop function when materialization fails", async () => {
    let stopCalled = false;
    await expect(
      preserveTerminalHandoffBeforeStop({
        materialize: async () => ({
          artifacts: [],
          errorCode: "handoff_packet_verification_failed",
        }),
        stop: async () => {
          stopCalled = true;
        },
      }),
    ).rejects.toThrow("durable_handoff_materialization_failed");
    expect(stopCalled).toBe(false);
  });

  it("keeps the primitive fail-closed until lifecycle applies a force override", async () => {
    let processKillerCalled = false;
    await expect(
      preserveTerminalHandoffBeforeStop({
        materialize: async () => ({
          artifacts: [],
          changedPaths: ["dirty.txt"],
          errorCode: "handoff_durable_root_required",
        }),
        stop: () => {
          processKillerCalled = true;
          return "terminated";
        },
      }),
    ).rejects.toThrow("durable_handoff_materialization_failed");
    expect(processKillerCalled).toBe(false);
  });

  it("keeps packet evidence when stopping fails after materialization", async () => {
    let failure: unknown;
    try {
      await preserveTerminalHandoffBeforeStop({
        materialize: async () => ({
          packetPath: "/durable/task.packet",
          manifestSha256: "a".repeat(64),
        }),
        stop: async () => {
          throw new Error("tmux server unavailable");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DurableHandoffStopError);
    expect(failure).toMatchObject({
      message: "tmux server unavailable",
      handoff: {
        packetPath: "/durable/task.packet",
        manifestSha256: "a".repeat(64),
      },
    });
  });

  it("returns a fresh terminal packet when the workspace changes during stop", async () => {
    let capture = 0;
    await expect(
      preserveTerminalHandoffBeforeStop({
        materialize: async () => ({
          packetPath: `/durable/task-${++capture}.packet`,
          manifestSha256: String(capture).repeat(64),
        }),
        stop: async () => "terminated",
      }),
    ).resolves.toMatchObject({
      handoff: {
        packetPath: "/durable/task-2.packet",
        manifestSha256: "2".repeat(64),
      },
      stopResult: "terminated",
    });
  });

  it("retains pre-stop evidence when terminal recapture fails", async () => {
    let capture = 0;
    let failure: unknown;
    try {
      await preserveTerminalHandoffBeforeStop({
        materialize: async () =>
          ++capture === 1
            ? {
                packetPath: "/durable/task.packet",
                manifestSha256: "a".repeat(64),
              }
            : {
                errorCode: "handoff_workspace_changed_during_materialization",
              },
        stop: async () => "terminated",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DurableHandoffPostStopError);
    expect(failure).toMatchObject({
      message: expect.stringContaining(
        "handoff_workspace_changed_during_materialization",
      ),
      preStopHandoff: {
        packetPath: "/durable/task.packet",
        manifestSha256: "a".repeat(64),
      },
      stopResult: "terminated",
    });
  });

  it("recaptures a terminal packet after a forced stop when pre-stop capture fails", async () => {
    let capture = 0;
    await expect(
      preserveTerminalHandoffBeforeForcedStop({
        materialize: async () =>
          ++capture === 1
            ? { errorCode: "handoff_workspace_changed_during_materialization" }
            : {
                packetPath: "/durable/task-terminal.packet",
                manifestSha256: "b".repeat(64),
              },
        stop: async () => "terminated",
        forceAfterMaterializationFailure: true,
      }),
    ).resolves.toMatchObject({
      handoff: {
        packetPath: "/durable/task-terminal.packet",
        manifestSha256: "b".repeat(64),
      },
      stopResult: "terminated",
    });
  });
});
