import { defineConfig } from "vitest/config";
import { alias } from "../../../../vitest.config";

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["src/worker-codex/tests/research-native-codex-enclosure.native.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
