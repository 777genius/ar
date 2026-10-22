import { assertHostedOrdinaryEffectPaths } from "../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CodexGoalProgressSnapshot } from "./codex-goal-runner";

export async function writeCodexGoalProgress(
  path: string,
  snapshot: CodexGoalProgressSnapshot,
): Promise<void> {
  assertHostedOrdinaryEffectPaths([path]);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  assertHostedOrdinaryEffectPaths([path, tempPath]);
  // The heartbeat may run beside a launch census. Close its private temporary
  // write before yielding, so the census cannot observe an in-flight file FD.
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600,
  });
  assertHostedOrdinaryEffectPaths([path, tempPath]);
  renameSync(tempPath, path);
}
