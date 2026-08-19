import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ledgerEpochUpgradeCrashBoundaries as crashBoundaries,
  ledgerEpochUpgradeCrashBoundaryShards as shards,
} from "./codex-goal-ledger-epoch-handler-crash-boundaries";

describe("exact-213 monotonic public-handler interruption chain", () => {
  it("keeps the complete ordered crash-boundary contract", () => {
    expect(crashBoundaries).toHaveLength(213);
    expect(new Set(crashBoundaries)).toHaveLength(213);
    expect(crashBoundaries.slice(0, 4)).toEqual([
      "intent.json",
      "source-orphan-0000.json",
      "source-orphan-0001.json",
      "source-orphan-0002.json",
    ]);
    expect(crashBoundaries.slice(-7)).toEqual([
      "plan.json",
      "owner.json",
      "state.json",
      "receipt.json",
      "manifest.json",
      "final-sidecar",
      "intent",
    ]);
    expect(crashBoundaries[205]).toBe("source-orphan-0204.json");
    expect(crashBoundaries[206]).toBe("plan.json");
  });

  it("discovers an exact, gap-free executable shard for every boundary", async () => {
    expect(crashBoundaries).toHaveLength(213);
    expect(shards).toHaveLength(54);
    expect(shards[0]).toEqual([0, 4]);
    expect(shards[53]).toEqual([212, 213]);
    for (const [index, [start, end]] of shards.entries()) {
      expect(start, `shard ${index} start`).toBe(index * 4);
      expect(end, `shard ${index} end`).toBe(Math.min(index * 4 + 4, 213));
      expect(end - start, `shard ${index} width`).toBe(index === 53 ? 1 : 4);
      if (index > 0) {
        expect(start, `shard ${index} adjacency`).toBe(shards[index - 1]?.[1]);
      }
    }
    const expectedWrapperNames = Array.from(
      { length: 54 },
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

  it.runIf(process.platform !== "win32")(
    "reclaims dead-owner locks after a real public-handler SIGKILL and restart",
    async () => {
      process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY = "1";
      let fixture: Awaited<ReturnType<
        typeof import("./codex-goal-ledger-epoch-handler.test").handlerFixture
      >> | undefined;
      try {
        const { handlerFixture } = await import(
          "./codex-goal-ledger-epoch-handler.test"
        );
        fixture = await handlerFixture(676, true, true);
        const plan = await fixture.seedPreparedV1();
        const crashMarkerPath = join(fixture.root, "process-crash-before-kill.marker");
        const crashed = await runProcessCrashChild({
          mode: "crash",
          root: fixture.root,
          planSha256: plan.planSha256,
          markerPath: crashMarkerPath,
        });
        expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
        await expect(readFile(crashMarkerPath, "utf8"))
          .resolves.toBe("final-sidecar\n");

        const resumed = await runProcessCrashChild({
          mode: "resume",
          root: fixture.root,
          planSha256: plan.planSha256,
        });
        expect(resumed, resumed.stderr).toMatchObject({
          code: 0,
          signal: null,
        });
      } finally {
        delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY;
        await fixture?.cleanup();
      }
    },
    300_000,
  );

});

async function runProcessCrashChild(input: {
  readonly mode: "crash" | "resume";
  readonly root: string;
  readonly planSha256: string;
  readonly markerPath?: string;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const childTest = join(
    import.meta.dirname,
    "codex-goal-ledger-epoch-handler-process-crash-child.mjs",
  );
  const child = spawn(process.execPath, [childTest], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY: "1",
      CODEX_LEDGER_EPOCH_PROCESS_CRASH_MODE: input.mode,
      CODEX_LEDGER_EPOCH_PROCESS_CRASH_ROOT: input.root,
      CODEX_LEDGER_EPOCH_PROCESS_CRASH_PLAN_SHA256: input.planSha256,
      ...(input.markerPath
        ? { CODEX_LEDGER_EPOCH_PROCESS_CRASH_MARKER: input.markerPath }
        : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}
