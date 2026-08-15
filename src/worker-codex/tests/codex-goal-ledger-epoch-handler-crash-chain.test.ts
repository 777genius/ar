import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ledgerEpochUpgradeCrashBoundaries as crashBoundaries,
  ledgerEpochUpgradeCrashBoundaryShards as shards,
} from "./codex-goal-ledger-epoch-handler-crash-boundaries";

describe("exact-211 monotonic public-handler crash chain", () => {
  it("keeps the complete ordered crash-boundary contract", () => {
    expect(crashBoundaries).toHaveLength(211);
    expect(new Set(crashBoundaries)).toHaveLength(211);
    expect(crashBoundaries.slice(0, 3)).toEqual([
      "source-orphan-0000.json",
      "source-orphan-0001.json",
      "source-orphan-0002.json",
    ]);
    expect(crashBoundaries.slice(-6)).toEqual([
      "plan.json",
      "owner.json",
      "state.json",
      "receipt.json",
      "final-sidecar",
      "intent",
    ]);
    expect(crashBoundaries[204]).toBe("source-orphan-0204.json");
    expect(crashBoundaries[205]).toBe("plan.json");
  });

  it("discovers an exact, gap-free executable shard for every boundary", async () => {
    expect(crashBoundaries).toHaveLength(211);
    expect(shards).toHaveLength(53);
    expect(shards[0]).toEqual([0, 4]);
    expect(shards[52]).toEqual([208, 211]);
    for (const [index, [start, end]] of shards.entries()) {
      expect(start, `shard ${index} start`).toBe(index * 4);
      expect(end, `shard ${index} end`).toBe(Math.min(index * 4 + 4, 211));
      expect(end - start, `shard ${index} width`).toBe(index === 52 ? 3 : 4);
      if (index > 0) {
        expect(start, `shard ${index} adjacency`).toBe(shards[index - 1]?.[1]);
      }
    }
    const expectedWrapperNames = Array.from(
      { length: 53 },
      (_, index) => `codex-goal-ledger-epoch-handler-crash-shard-${index}.test.ts`,
    );
    const wrapperNames = (await readdir(import.meta.dirname))
      .filter((name) => /^codex-goal-ledger-epoch-handler-crash-shard-\d+\.test\.ts$/.test(name))
      .sort((left, right) => Number(left.match(/\d+/g)?.at(-1)) -
        Number(right.match(/\d+/g)?.at(-1)));
    expect(wrapperNames).toEqual(expectedWrapperNames);
    const assignedBoundaries: number[] = [];
    await Promise.all(shards.map(async ([expectedStart, expectedEnd], index) => {
      const wrapperPath = join(
        import.meta.dirname,
        `codex-goal-ledger-epoch-handler-crash-shard-${index}.test.ts`,
      );
      await expect(access(wrapperPath)).resolves.toBeUndefined();
      const wrapper = await readFile(wrapperPath, "utf8");
      expect(wrapper, wrapperPath).toBe(
        "import { certifyLedgerEpochCrashBoundaryShard } from\n" +
        "  \"./codex-goal-ledger-epoch-handler-crash-shard-support\";\n" +
        `certifyLedgerEpochCrashBoundaryShard({ shard: ${index}, ` +
        `start: ${expectedStart}, end: ${expectedEnd} });\n`,
      );
      const invocation = wrapper.match(
        /certifyLedgerEpochCrashBoundaryShard\(\{([\s\S]*?)\}\);/,
      );
      expect(invocation, wrapperPath).not.toBeNull();
      if (!invocation) throw new Error(`missing shard invocation: ${wrapperPath}`);
      const invocationBody = invocation[1];
      if (invocationBody === undefined) {
        throw new Error(`missing shard invocation body: ${wrapperPath}`);
      }
      const field = (name: string) => Number(invocationBody.match(
        new RegExp(`\\b${name}:\\s*(\\d+)`),
      )?.[1]);
      const start = field("start");
      const end = field("end");
      expect(field("shard"), wrapperPath).toBe(index);
      expect([start, end], wrapperPath).toEqual([expectedStart, expectedEnd]);
      expect(wrapper.includes("completesActivation"), wrapperPath).toBe(false);
      assignedBoundaries.push(...Array.from(
        { length: end - start },
        (_, offset) => start + offset,
      ));
    }));
    assignedBoundaries.sort((left, right) => left - right);
    expect(assignedBoundaries).toEqual(
      Array.from({ length: crashBoundaries.length }, (_, index) => index),
    );
    expect(new Set(assignedBoundaries)).toHaveLength(crashBoundaries.length);
    await expect(access(join(
      import.meta.dirname,
      "codex-goal-ledger-epoch-handler-production.test.ts",
    ))).resolves.toBeUndefined();
  });

});
