import { defineConfig } from "vitest/config";
/** Finite C parser TEST only; never native-backend.test.ts. */
export default defineConfig({ test: {
  include: ["host-integration/bounded-storage/mountinfo.test.ts"],
  fileParallelism: false, maxWorkers: 1, testTimeout: 30000,
} });
