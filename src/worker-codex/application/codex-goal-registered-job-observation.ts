import { collectCodexGoalStatus, type CodexGoalLaunchInput } from "../codex-goal-ops";
import { reconcileProjectMimoWorker } from "../project-mimo-worker-launch";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-status-input";
import type { CodexGoalObservationContext } from "./codex-goal-observation-context";

/** Registered MiMo stages a candidate until native owner settlement. Public
 * observation reconciles that exact attempt before deriving its shared status. */
export async function collectRegisteredCodexGoalJobStatus(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput;
  readonly observation?: CodexGoalObservationContext;
}): Promise<Awaited<ReturnType<typeof collectCodexGoalStatus>>> {
  await reconcileProjectMimoWorker(input);
  return await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(input.launch), input.observation);
}
