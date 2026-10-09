import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";

import { unitTestDurationsMs } from "./unit-test-durations.js";
import { DurationBalancedSequencer } from "./unit-test-sequencer.js";

const root = "/test/unit-root";
const heavyPaths = [
  "src/worker-codex/tests/codex-goal-ledger-epoch-handler-safety.test.ts",
  "src/worker-codex/tests/codex-goal-project-retained-disjoint-admission.test.ts",
  "src/worker-codex/tests/keyed-child-application.test.ts",
  "src/worker-codex/tests/codex-goal-ledger-epoch-handler-crash-chain.test.ts",
];

function specification(path: string, testRoot = root): TestSpecification {
  return { moduleId: resolve(testRoot, path) } as TestSpecification;
}

function sequencer(index: number, count = 4, testRoot = root): DurationBalancedSequencer {
  return new DurationBalancedSequencer({
    config: { root: testRoot, shard: { index, count } },
  } as Vitest);
}

async function partition(files: TestSpecification[], count = 4, testRoot = root) {
  return Promise.all(Array.from({ length: count }, (_, i) =>
    sequencer(i + 1, count, testRoot).shard(files)));
}

function paths(lanes: TestSpecification[][]): string[][] {
  return lanes.map(lane => lane.map(file => file.moduleId));
}

describe("duration-balanced unit sharding", () => {
  it("preserves every discovered specification once, including new and filtered files", async () => {
    const files = [
      ...Object.keys(unitTestDurationsMs).map(path => specification(path)),
      ...Array.from({ length: 19 }, (_, i) => specification(`src/new/${i}.test.ts`)),
    ];
    const originalOrder = [...files];
    for (const count of [1, 3, 4, 7]) {
      const assigned = (await partition(files, count)).flat();
      expect(assigned).toHaveLength(files.length);
      expect(new Set(assigned)).toEqual(new Set(files));
    }
    const filtered = [files[0]!, files.at(-1)!];
    expect(new Set((await partition(filtered)).flat())).toEqual(new Set(filtered));
    expect(files).toEqual(originalOrder);
  });

  it("spreads the four longest files and begins each shard with its expensive file", async () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => specification(`src/new/${i}.test.ts`)),
      ...heavyPaths.map(path => specification(path)),
    ];
    const lanes = await partition(files);
    expect(lanes.map(lane => lane[0]!.moduleId)).toEqual(
      heavyPaths.map(path => resolve(root, path)),
    );
    for (const lane of lanes) {
      expect(lane.filter(file => heavyPaths.some(path => file.moduleId.endsWith(path))))
        .toHaveLength(1);
      const sorted = await sequencer(1).sort([...lane].reverse());
      expect(sorted[0]).toBe(lane[0]);
    }
  });

  it("is deterministic across discovery order and checkout roots, with balanced new-file fallback", async () => {
    const relativePaths = Array.from({ length: 12 }, (_, i) => `src/new/${i}.test.ts`);
    const files = relativePaths.map(path => specification(path));
    const lanes = await partition(files);
    expect(paths(await partition([...files].reverse()))).toEqual(paths(lanes));
    expect(lanes.map(lane => lane.length)).toEqual([3, 3, 3, 3]);
    const otherRoot = "/other/private-test-root";
    const otherLanes = await partition(
      [...heavyPaths, ...relativePaths].map(path => specification(path, otherRoot)), 4, otherRoot,
    );
    expect(paths(otherLanes).map(lane => lane.map(path => path.slice(otherRoot.length))))
      .toEqual(paths(await partition([...heavyPaths, ...relativePaths].map(path => specification(path))))
        .map(lane => lane.map(path => path.slice(root.length))));
  });

  it("retains Vitest failed-first ordering when no shard is requested", async () => {
    const failed = specification("src/new/failed.test.ts");
    const slowPassed = specification(heavyPaths[0]!);
    const project = { name: "unit", config: { sequence: { groupOrder: 0 }, isolate: true } };
    Object.assign(failed, { project });
    Object.assign(slowPassed, { project });
    const unsharded = new DurationBalancedSequencer({
      config: { root },
      cache: {
        getFileTestResults: (key: string) => ({
          failed: key.endsWith("failed.test.ts"), duration: 1,
        }),
      },
    } as unknown as Vitest);
    expect(await unsharded.sort([slowPassed, failed])).toEqual([failed, slowPassed]);
  });
});
