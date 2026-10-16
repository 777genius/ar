import { collectCodexGoalStatus, recommendCodexGoalAction, CodexGoalNativeLifecycle, type CodexGoalLaunchInput } from "../codex-goal-ops";
import { reconcileProjectMimoWorker, observeProjectMimoWorker, observeProjectMimoWorkerReadOnly } from "../project-mimo-worker-launch";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-status-input";
import type { CodexGoalObservationContext } from "./codex-goal-observation-context";

export enum CodexGoalObservationMode { Reconcile = "reconcile", ReadOnly = "read_only" }

/** Registered MiMo stages a candidate until native owner settlement. Public
 * observation reconciles that exact attempt before deriving its shared status. */
export async function collectRegisteredCodexGoalJobStatus(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput;
  readonly observation?: CodexGoalObservationContext;
  readonly mode?: CodexGoalObservationMode;
}): Promise<Awaited<ReturnType<typeof collectCodexGoalStatus>>> {
  if (input.mode !== CodexGoalObservationMode.ReadOnly) await reconcileProjectMimoWorker(input);
  const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(input.launch), input.observation);
  const nativeLifecycle = await (input.mode === CodexGoalObservationMode.ReadOnly
    ? observeProjectMimoWorkerReadOnly(input) : observeProjectMimoWorker(input));
  if (input.mode === CodexGoalObservationMode.ReadOnly && nativeLifecycle === CodexGoalNativeLifecycle.Uncertain)
    throw new Error("project_mimo_worker_observation_unproven");
  if (nativeLifecycle === undefined) return status;
  const nativeStatus = { ...status, nativeLifecycle };
  // A progress-PID descendant tree cannot rule out a separate native provider
  // service. Preserve positive observations; an uncovered negative is unknown.
  if (nativeStatus.appServerProcessAlive === false) delete nativeStatus.appServerProcessAlive;
  return { ...nativeStatus,
    recommendedAction: recommendCodexGoalAction({ ...nativeStatus, ...(input.launch.config.accessBoundary === undefined ? {} : { accessBoundary: input.launch.config.accessBoundary }) }) };
}
