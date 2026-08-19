import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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

export async function withHandoffLiveIndexSnapshot<T>(input: {
  readonly sourceIndexPath: string;
  readonly sharedIndexPath?: string;
  readonly operation: (snapshot: {
    readonly temporaryDirectory: string;
    readonly indexPath: string;
  }) => Promise<T>;
}): Promise<T> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "subscription-runtime-handoff-index-"),
  );
  const indexPath = join(temporaryDirectory, "index");
  try {
    await writeFile(indexPath, await readFile(input.sourceIndexPath), {
      mode: 0o600,
    });
    if (input.sharedIndexPath) {
      const entry = basename(input.sharedIndexPath);
      if (!/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(entry)) {
        throw new Error("handoff_shared_index_path_invalid");
      }
      await writeFile(
        join(dirname(indexPath), entry),
        await readFile(input.sharedIndexPath),
        { mode: 0o600 },
      );
    }
    return await input.operation({ temporaryDirectory, indexPath });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
