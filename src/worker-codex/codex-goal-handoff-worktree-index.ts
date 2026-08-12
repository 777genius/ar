import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withHandoffWorktreeIndex<T>(input: {
  readonly initialize: (env: NodeJS.ProcessEnv) => Promise<void>;
  readonly operation: (env: NodeJS.ProcessEnv) => Promise<T>;
}): Promise<T> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "subscription-runtime-handoff-worktree-index-"),
  );
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryDirectory, "index"),
  };
  try {
    await input.initialize(env);
    return await input.operation(env);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
