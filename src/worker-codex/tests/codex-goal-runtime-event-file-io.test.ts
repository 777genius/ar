import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  )),
  open: mocks.open,
}));

import {
  CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES,
  readLastCodexGoalRuntimeEvent,
} from "../codex-goal-status-files";

describe("Codex goal runtime event bounded file IO", () => {
  it("uses the stat snapshot, enforces the read cap, and closes the handle", async () => {
    const snapshot = Buffer.from(
      `${"x".repeat(CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES)}\n` +
        '{"event":"snapshot"}\n',
    );
    const appended = Buffer.concat([
      snapshot,
      Buffer.from('{"event":"concurrent-append"}\n'),
    ]);
    const close = vi.fn().mockResolvedValue(undefined);
    let totalBytesRead = 0;
    const read = vi.fn(
      async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = appended.copy(
          buffer,
          offset,
          position,
          Math.min(position + length, appended.length),
        );
        totalBytesRead += bytesRead;
        return { bytesRead, buffer };
      },
    );
    mocks.open.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ size: snapshot.length }),
      read,
      close,
    });

    await expect(readLastCodexGoalRuntimeEvent("/fake/events.jsonl")).resolves
      .toEqual({ event: "snapshot" });

    expect(totalBytesRead).toBe(CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[3]).toBe(
      snapshot.length - CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES,
    );
    expect(close).toHaveBeenCalledOnce();
  });

});
