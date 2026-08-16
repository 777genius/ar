import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";

export async function exactTreeBytes(root: string): Promise<readonly string[]> {
  const values: string[] = [];
  const visit = async (path: string, relativePath: string): Promise<void> => {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      values.push(`d\0${relativePath}\0${metadata.mode}`);
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name),
          relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    const bytes = await readFile(path);
    values.push(`f\0${relativePath}\0${bytes.length}\0${createHash("sha256")
      .update(bytes).digest("hex")}`);
  };
  await visit(root, "");
  return values;
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
