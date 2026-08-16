import { createHash } from "node:crypto";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";

export function manifestFingerprint(manifest: CodexGoalJobManifest): string {
  return sha256Json(manifest);
}

export function stableControllerFingerprint(
  manifest: CodexGoalJobManifest,
): string {
  const projectAccessScope = manifest.projectAccessScope
    ? { ...manifest.projectAccessScope, consumedOutputLedgerRoots: undefined }
    : undefined;
  return sha256Json({ ...manifest, updatedAt: undefined, projectAccessScope });
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
