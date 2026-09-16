import { describe, expect, it } from "vitest";
import { DefaultContinuationPacketBuilder } from "../application/default-continuation-packet-builder";

type BuildInput = Parameters<DefaultContinuationPacketBuilder["build"]>[0];
const builder = new DefaultContinuationPacketBuilder();

describe("DefaultContinuationPacketBuilder", () => {
  it("bounds only rendered diff stats while preserving continuation evidence", () => {
    const originalPrompt = "Implement the accepted task without losing context.";
    const controlMessage = "Operator guidance: preserve the accepted invariant.";
    const changedFiles = Array.from({ length: 120 }, (_, index) => `src/file-${index}.ts`);
    const hugeDiffStat = Array.from(
      { length: 150 },
      (_, index) => `${index} ${"x".repeat(120)}`,
    ).join("\r\n");
    const input = buildInput(hugeDiffStat, changedFiles);
    const packet = builder.build({
      ...input,
      originalPrompt,
      controlBatch: {
        target: { jobId: "job-a", taskId: "task-a" },
        deliveryAttemptId: "delivery-a",
        signals: [],
        signalIds: ["signal-a"],
        message: controlMessage,
      },
    });

    const rendered = renderedDiffStat(packet.message, controlMessage);
    expect(rendered.length).toBeLessThanOrEqual(8_000);
    expect(rendered.split("\n").length).toBeLessThanOrEqual(100);
    expect(rendered).toContain("[diff stat truncated: additional content omitted]");
    expect(packet.message).toContain(originalPrompt);
    expect(packet.message).toContain(controlMessage);
    expect(packet.message).toContain("Do not restart from scratch.");
    expect(packet).toMatchObject({
      originalPrompt,
      changedFiles,
      workerControlSignalIds: ["signal-a"],
    });
    expect(input.snapshot.diffStat).toBe(hugeDiffStat);
    expect(input.snapshot.changedFiles).toEqual(changedFiles);
  });

  it("preserves small CRLF input and bounds a single oversized line", () => {
    const small = " src/a.ts | 2 ++\r\n 1 file changed, 2 insertions(+)";
    const smallPacket = builder.build(buildInput(small));
    expect(smallPacket.message).toContain(`Diff stat:\n${small}\n`);
    expect(smallPacket.message).not.toContain("diff stat truncated");

    const oversized = renderedDiffStat(
      builder.build(buildInput("x".repeat(50_000))).message,
      "Changed files:",
    );
    expect(oversized.length).toBeLessThanOrEqual(8_000);
    expect(oversized).toContain("[diff stat truncated: additional content omitted]");
  });
});

function buildInput(diffStat: string, changedFiles = ["src/a.ts"]): BuildInput {
  return {
    taskId: "task-a",
    attemptNumber: 2,
    provider: "test-provider",
    workspacePath: "/tmp/sandbox-workspace",
    originalPrompt: "Original prompt",
    previousFailureReason: "capacity_unavailable",
    snapshot: {
      mode: "git",
      workspacePath: "/tmp/sandbox-workspace",
      capturedAt: new Date("2026-09-05T00:00:00.000Z"),
      dirty: true,
      changedFiles,
      fingerprint: "snapshot-fingerprint",
      summary: "Synthetic workspace summary.",
      diffStat,
    },
  };
}

function renderedDiffStat(message: string, nextSection: string): string {
  return message.split("\nDiff stat:\n", 2)[1]!.split(`\n${nextSection}`, 1)[0]!;
}
