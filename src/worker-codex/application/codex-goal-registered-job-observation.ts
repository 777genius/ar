import { collectCodexGoalStatus, recommendCodexGoalAction, type CodexGoalLaunchInput } from "../codex-goal-ops";
import { reconcileProjectMimoWorker, observeProjectMimoWorker } from "../project-mimo-worker-launch";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-status-input";
import type { CodexGoalObservationContext } from "./codex-goal-observation-context";

/** Registered MiMo stages a candidate until native owner settlement. Public
 * observation reconciles that exact attempt before deriving its shared status. */
export async function collectRegisteredCodexGoalJobStatus(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput;
  readonly observation?: CodexGoalObservationContext;
}): Promise<Awaited<ReturnType<typeof collectCodexGoalStatus>>> {
  await reconcileProjectMimoWorker(input);
  const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(input.launch), input.observation);
  const nativeLifecycle = await observeProjectMimoWorker(input);
  if (nativeLifecycle === undefined) return status;
  const nativeStatus = { ...status, nativeLifecycle };
  // A progress-PID descendant tree cannot rule out a separate native provider
  // service. Preserve positive observations; an uncovered negative is unknown.
  if (nativeStatus.appServerProcessAlive === false) delete nativeStatus.appServerProcessAlive;
  return { ...nativeStatus,
    recommendedAction: recommendCodexGoalAction({ ...nativeStatus, ...(input.launch.config.accessBoundary === undefined ? {} : { accessBoundary: input.launch.config.accessBoundary }) }) };
}
