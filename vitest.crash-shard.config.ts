import { configDefaults, defineConfig } from "vitest/config";
import { alias } from "./vitest.config";

export default defineConfig({
  test: {
    include: [
      "src/worker-codex/tests/codex-goal-ledger-epoch-handler-crash-shard-*.test.ts",
    ],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    globals: true,
    testTimeout: 60_000,
  },
  resolve: { alias },
});
