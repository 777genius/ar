import { defineConfig } from "vitest/config";

const alias = {
  "@777genius/subscription-runtime/core": "/src/core/index.ts",
  "@777genius/subscription-runtime/agent-task": "/src/agent-task/index.ts",
  "@777genius/subscription-runtime/provider-codex":
    "/src/provider-codex/index.ts",
  "@777genius/subscription-runtime/provider-claude":
    "/src/provider-claude/index.ts",
  "@777genius/subscription-runtime/worker-core": "/src/worker-core/index.ts",
  "@777genius/subscription-runtime/worker-codex": "/src/worker-codex/index.ts",
  "@777genius/subscription-runtime/worker-claude": "/src/worker-claude/index.ts",
  "@777genius/subscription-runtime/worker-local": "/src/worker-local/index.ts",
  "@777genius/subscription-runtime/queue-core": "/src/queue-core/index.ts",
  "@777genius/subscription-runtime/queue-bullmq": "/src/queue-bullmq/index.ts",
  "@777genius/subscription-runtime/store-local-file":
    "/src/store-local-file/index.ts",
  "@777genius/subscription-runtime/store-github-actions-secret":
    "/src/store-github-actions-secret/index.ts",
  "@777genius/subscription-runtime/runner-github-action":
    "/src/runner-github-action/index.ts",
  "@777genius/subscription-runtime/testing": "/src/testing/index.ts",
  "@777genius/subscription-runtime/testing/contracts":
    "/src/testing/contracts.ts",
  "@777genius/subscription-runtime/testing/fakes": "/src/testing/fakes.ts",
};

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    globals: true,
    testTimeout: 60_000,
  },
  resolve: {
    alias,
  },
});
