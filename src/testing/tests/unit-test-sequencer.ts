import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

import { unitTestDurationsMs } from "./unit-test-durations.js";

// Short files and new files still pay module-loading and isolated-fork costs.
const fallbackDurationMs = 1_000;

/** Balance only the files Vitest discovers, including any CLI file filters. */
export class DurationBalancedSequencer extends BaseSequencer {
  private duration(file: TestSpecification): number {
    const path = relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");
    return unitTestDurationsMs[path] ?? fallbackDurationMs;
  }

  private heavyFirst(files: TestSpecification[]): TestSpecification[] {
    return [...files].sort((a, b) => {
      const durationDifference = this.duration(b) - this.duration(a);
      if (durationDifference !== 0) return durationDifference;
      // Avoid locale-dependent ordering and keep assignments stable across roots.
      return a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0;
    });
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;

    const lanes = Array.from({ length: shard.count }, () => ({
      files: [] as TestSpecification[],
      durationMs: 0,
    }));
    for (const file of this.heavyFirst(files)) {
      // Equal estimated loads choose the lowest shard index deterministically.
      let lightest = lanes[0]!;
      for (const lane of lanes) {
        if (lane.durationMs < lightest.durationMs) lightest = lane;
      }
      lightest.files.push(file);
      lightest.durationMs += this.duration(file);
    }
    return lanes[shard.index - 1]!.files;
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Preserve Vitest's failed-first/cache ordering for ordinary local runs.
    return this.ctx.config.shard ? this.heavyFirst(files) : super.sort(files);
  }
}
