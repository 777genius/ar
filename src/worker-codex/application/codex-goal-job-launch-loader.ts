import { join } from "node:path";

import {
  codexGoalJobToArgs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { goalLaunchInput } from "./codex-goal-launch-input";
import { requiredRawString } from "./codex-goal-input-values";
import {
  registryRootFromInput,
  type CodexGoalJobIdInput,
} from "./codex-goal-use-case-inputs";

export type LoadedCodexGoalJobLaunch = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

/** The sink a stored job publishes its terminal handoff packets into. */
export function codexGoalJobDurableHandoffRootDir(manifest: CodexGoalJobManifest, registryRootDir: string): string {
  return manifest.durableHandoffRootDir ??
    join(manifest.storage ? manifest.jobRootDir : registryRootDir, "durable-handoffs");
}

/** A closed or retired job is never loaded for an effect; Status and Stop
 * answer such jobs from their records before reaching this loader. Only a
 * read-only observation passes `includeRetired`, never from tool arguments. */
export async function loadJobLaunch(
  args: CodexGoalJobIdInput,
  options: { readonly includeRetired?: true } = {},
): Promise<LoadedCodexGoalJobLaunch> {
  const registryRootDir = registryRootFromInput(args);
  // The reader refuses a closed or retired job.
  const manifest = await readCodexGoalJob({ registryRootDir, jobId: requiredRawString(args.jobId, "jobId"), ...options });
  return {
    registryRootDir,
    manifest,
    launch: await goalLaunchInput({
      ...codexGoalJobToArgs(manifest),
      ...(args.sourceEnv === undefined ? {} : { sourceEnv: args.sourceEnv }),
      durableHandoffRootDir: codexGoalJobDurableHandoffRootDir(manifest, registryRootDir),
    }),
  };
}
