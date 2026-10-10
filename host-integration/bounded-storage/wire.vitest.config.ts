import { defineConfig } from "vitest/config";

/** Lightweight protocol regression, no native/backend/filesystem effects. */
export default defineConfig({ test: {
  include: ["host-integration/bounded-storage/native-wire.test.ts"],
  fileParallelism: false, maxWorkers: 1,
} });
