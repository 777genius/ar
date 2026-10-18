import { defaultProjectControlGitPort } from "./adapters/host-command-adapters";

const PATCH_TIMEOUT_MS = 60_000;

/**
 * Retention-only `tracked.diff`: the binary-safe HEAD-to-WORKTREE diff of TRACKED paths and nothing
 * else (additions, deletions, mode changes and binary bytes included). It deliberately does NOT use
 * `captureGitWorkspacePatch`, which also appends a per-file no-index diff for every untracked path;
 * that helper stays unchanged for approved-output and other routes. Untracked and explicitly
 * retained ignored files are preserved as raw bytes and modes in untracked.tar (and the receipt
 * inventory), and the staged side in staged.tar, so no useful file is omitted by this helper.
 *
 * Presentation drivers are disabled (`--no-ext-diff`, `--no-textconv`) and the caller has already
 * passed the existing raw-identity guard (`assertGitWorkspaceRawPatchIdentitySupported`, run by the
 * inventory capture for the same workspace). The output buffer is bounded by the policy's patch
 * limit, so an over-limit patch refuses; it is never truncated.
 */
export async function captureRetainedTrackedPatch(input: {
  readonly workspacePath: string;
  readonly maxBytes: number;
}): Promise<Buffer> {
  try {
    const { stdout } = await defaultProjectControlGitPort.runBuffered({
      args: ["-C", input.workspacePath, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"],
      timeoutMs: PATCH_TIMEOUT_MS,
      maxBuffer: input.maxBytes,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (stdout.length > input.maxBytes) throw new Error("retained_nonqualified_patch_too_large");
    return Buffer.from(stdout);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("retained_nonqualified_patch_too_large", { cause: error });
    }
    throw error;
  }
}
