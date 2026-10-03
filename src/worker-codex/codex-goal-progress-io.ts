import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexGoalProgressSnapshot } from "./codex-goal-runner";

export async function writeCodexGoalProgress(
  path: string,
  snapshot: CodexGoalProgressSnapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600,
  });
  await rename(tempPath, path);
}
