import { deriveRuntimeStorageRoots, deriveRuntimeJobLayout } from "@vioxen/subscription-runtime/core";
import { MANAGED_MARKER_ENV, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV } from "./managed-job-layout";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePath } from "./codex-goal-job-manifest-parse-primitives";

export type CodexGoalJobRegistryInput = {
  readonly storageRootDir?: string | undefined;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly registryRootDir?: string | undefined;
  readonly cwd?: string;
};

export function defaultCodexGoalJobRegistryRoot(): string {
  return join(homedir(), ".cache", "subscription-runtime", "codex-goal-jobs");
}

export function resolveCodexGoalJobRegistryRoot(
  input: CodexGoalJobRegistryInput = {},
): string {
  const cwd = input.cwd ?? process.cwd();
  if (input.storageRootDir === "") throw new Error("Invalid runtime storageRootDir");
  const roots = input.storageRootDir === undefined ? undefined : deriveRuntimeStorageRoots(resolvePath(cwd, input.storageRootDir));
  const env = input.sourceEnv ?? {};
  if (env[MANAGED_MARKER_ENV] !== undefined) {
    if (env[MANAGED_MARKER_ENV] !== "1" || !env[MANAGED_JOB_ROOT_ENV] || !env[MANAGED_JOB_ID_ENV]) throw new Error("Managed host requires root-owned launcher");
    const layout = deriveRuntimeJobLayout(env[MANAGED_JOB_ROOT_ENV]!, env[MANAGED_JOB_ID_ENV]!);
    const fixed = join(layout.state, "registry");
    if (input.registryRootDir !== undefined && resolvePath(cwd, input.registryRootDir) !== fixed) throw new Error("Managed writable override rejected: registryRootDir");
    return fixed;
  }
  return resolvePath(cwd, input.registryRootDir ?? (roots ? join(roots.stateRootDir, "codex-goal-jobs") : defaultCodexGoalJobRegistryRoot()));
}
