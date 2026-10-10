import { createHash } from "node:crypto";
import { CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA } from "./codex-goal-continuation-workspace-fingerprint";

/** Pure fingerprint/error mapping over captured content and validation results.
 * These functions neither read sources nor authorize protected IO. */
export function continuationWorkspaceFingerprint(input: {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patch: string;
}): string {
  const hash = createHash("sha256");
  hash.update(CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA);
  hash.update("\0");
  hash.update(input.baseCommit);
  for (const path of input.changedPaths) hash.update(`\0${path}`);
  hash.update("\0");
  hash.update(input.patch);
  return hash.digest("hex");
}

export function handoffGitBlobError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes("blob_limit")) {
      return new Error("handoff_file_byte_limit_exceeded");
    }
    if (
      error.message.includes("total_limit") ||
      error.message.includes("output_limit")
    ) {
      return new Error("handoff_total_byte_limit_exceeded");
    }
  }
  return new Error("handoff_base_blob_unreadable");
}

export function handoffPatchValidationError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.startsWith("git_patch_secret_like_content:")) {
      return new Error(
        error.message.replace(
          "git_patch_secret_like_content:",
          "handoff_raw_secret_rejected:",
        ),
      );
    }
    if (error.message === "git_patch_secret_file_limit_exceeded") {
      return new Error("handoff_file_byte_limit_exceeded");
    }
    if (error.message === "git_patch_secret_total_limit_exceeded") {
      return new Error("handoff_total_byte_limit_exceeded");
    }
    if (error.message === "git_patch_secret_changed_paths_mismatch") {
      return new Error("handoff_patch_changed_paths_mismatch");
    }
    if (error.message === "git_patch_secret_changed_blob_missing") {
      return new Error("handoff_changed_blob_missing");
    }
  }
  return new Error("handoff_patch_validation_failed");
}
