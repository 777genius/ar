import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertManagedDependencyGitContext, assertUnmanagedDependencyGitRoute,
  resolveManagedDependencyGitContext, type HostedDependencyRootPurposeContext } from "./managed-dependency-git";
import { prepareHostedDependencyPrivateScratch, managedDependencyPrivateIndexEnvironment } from "./hosted-dependency-private-scratch";

export async function withHandoffWorktreeIndex<T>(input: {
  readonly managedContext?: HostedDependencyRootPurposeContext;
  readonly initialize: (env: NodeJS.ProcessEnv) => Promise<void>;
  readonly operation: (env: NodeJS.ProcessEnv) => Promise<T>;
}): Promise<T> {
  const context = resolveManagedDependencyGitContext(undefined, input.managedContext);
  if (context !== undefined) {
    const scratch = prepareHostedDependencyPrivateScratch(context);
    const env = managedDependencyPrivateIndexEnvironment(context, scratch);
    try {
      assertManagedDependencyGitContext(context);
      await input.initialize(env); assertManagedDependencyGitContext(context);
      const result = await input.operation(env); assertManagedDependencyGitContext(context);
      return result;
    } finally { scratch.close(context); }
  }
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "subscription-runtime-handoff-worktree-index-"),
  );
  try {
    assertUnmanagedDependencyGitRoute();
    const env = { ...process.env, GIT_INDEX_FILE: join(temporaryDirectory, "index") };
    await input.initialize(env);
    assertUnmanagedDependencyGitRoute();
    const result = await input.operation(env);
    assertUnmanagedDependencyGitRoute(); return result;
  } finally {
    assertUnmanagedDependencyGitRoute();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function withHandoffLiveIndexSnapshot<T>(input: {
  readonly managedContext?: HostedDependencyRootPurposeContext;
  readonly sourceIndexPath: string;
  readonly sharedIndexPath?: string;
  readonly operation: (snapshot: {
    readonly temporaryDirectory: string;
    readonly indexPath: string;
    readonly env?: NodeJS.ProcessEnv;
  }) => Promise<T>;
}): Promise<T> {
  const sourceWorkspace = input.sourceIndexPath.endsWith("/.git/index") ? dirname(dirname(input.sourceIndexPath)) : undefined;
  const context = resolveManagedDependencyGitContext(sourceWorkspace, input.managedContext);
  if (context !== undefined) {
    const scope = assertManagedDependencyGitContext(context);
    if (input.sourceIndexPath !== join(scope.workspace.canonicalPath, ".git/index")) throw new Error("dependency_host_git_scope_mismatch");
    const scratch = prepareHostedDependencyPrivateScratch(context);
    try {
      scratch.copyLiveIndex(context, input.sourceIndexPath, input.sharedIndexPath);
      const paths = scratch.paths(context);
      const result = await input.operation({ temporaryDirectory: paths.temporaryDirectory,
        indexPath: paths.indexPath, env: managedDependencyPrivateIndexEnvironment(context, scratch) });
      assertManagedDependencyGitContext(context); return result;
    } finally { scratch.close(context); }
  }
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "subscription-runtime-handoff-index-"),
  );
  const indexPath = join(temporaryDirectory, "index");
  try {
    assertUnmanagedDependencyGitRoute();
    const source = await readFile(input.sourceIndexPath);
    assertUnmanagedDependencyGitRoute();
    await writeFile(indexPath, source, { mode: 0o600 });
    assertUnmanagedDependencyGitRoute();
    if (input.sharedIndexPath) {
      const entry = basename(input.sharedIndexPath);
      if (!/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(entry)) {
        throw new Error("handoff_shared_index_path_invalid");
      }
      const shared = await readFile(input.sharedIndexPath);
      assertUnmanagedDependencyGitRoute();
      await writeFile(join(dirname(indexPath), entry), shared, { mode: 0o600 });
      assertUnmanagedDependencyGitRoute();
    }
    const result = await input.operation({ temporaryDirectory, indexPath });
    assertUnmanagedDependencyGitRoute(); return result;
  } finally {
    assertUnmanagedDependencyGitRoute();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
