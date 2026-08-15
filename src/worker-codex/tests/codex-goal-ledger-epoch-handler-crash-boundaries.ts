export const ledgerEpochUpgradeCrashBoundaries = [
  ...Array.from({ length: 205 }, (_, index) =>
    `source-orphan-${String(index).padStart(4, "0")}.json`
  ),
  "plan.json",
  "owner.json",
  "state.json",
  "receipt.json",
  "final-sidecar",
  "intent",
] as const;

export const ledgerEpochUpgradeCrashBoundaryShards = [
  [0, 8], [8, 16], [16, 24], [24, 32], [32, 40], [40, 48], [48, 56], [56, 64], [64, 72], [72, 80], [80, 88], [88, 96], [96, 104], [104, 112], [112, 120], [120, 128], [128, 136], [136, 144], [144, 152], [152, 160], [160, 168], [168, 176], [176, 184], [184, 192], [192, 200], [200, 208], [208, 211],
] as const;
