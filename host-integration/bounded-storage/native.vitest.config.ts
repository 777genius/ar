import { defineConfig } from "vitest/config";

/** Explicit NEW TEST operator selection only; never ordinary CI discovery. */
export default defineConfig({ test: {
  include: ["host-integration/bounded-storage/native-backend.test.ts"],
  fileParallelism: false, maxWorkers: 1, testTimeout: 300000, hookTimeout: 300000,
} });
