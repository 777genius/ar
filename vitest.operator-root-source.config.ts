import { configDefaults, defineConfig } from "vitest/config";
import { alias } from "./vitest.config";

/** Real UID/file ownership with projected host DATA; no Native qualification. */
export default defineConfig({
  test: {
    include: ["src/worker-codex/tests/hosted-original-usable-placement-installation.test.ts"],
    exclude: configDefaults.exclude,
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    globals: true,
    testTimeout: 60_000,
  },
  resolve: { alias },
});
