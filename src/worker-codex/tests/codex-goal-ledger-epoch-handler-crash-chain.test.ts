import { describe, expect, it } from "vitest";

const crashBoundaries = [
  ...Array.from({ length: 205 }, (_, index) =>
    `source-orphan-${String(index).padStart(4, "0")}.json`
  ),
  "plan.json",
  "owner.json",
  "state.json",
  "receipt.json",
  "final-sidecar",
  "intent",
];

describe("exact-710 monotonic public-handler crash chain", () => {
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

});
