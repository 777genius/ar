import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexLogicalThreadExecutionResult,
} from "../../codex-json-execution-engine";
import { prepareCodexOutputSchemaPlan } from "../../codex-json-execution-engine";
import type { CodexStructuredOutputSchemaPlan } from "../../codex-structured-output-schema";
import type { AppServerGoalRunner } from "./app-server-goal-runner";
import type { AppServerSlot } from "./app-server-slot-pool";
import { runCodexAppServerLogicalThread } from "./app-server-logical-thread-runner";
import type { AppServerRunResult, AppServerWarning } from "../domain/app-server-types";

export function createAppServerLogicalThreadSlotLifecycle(input: {
  readonly execution: CodexExecutionInput;
  readonly ensureSlot: (input: {
    readonly session: CodexExecutionInput["session"];
    readonly workspacePath: string;
    readonly abortSignal: AbortSignal;
  }) => Promise<AppServerSlot>;
  readonly disposeSessionSlot: (
    session: CodexExecutionInput["session"],
  ) => Promise<void>;
}): {
  readonly runGoal: (
    goalInput: Parameters<AppServerGoalRunner["runLogicalThreadGoal"]>[0],
  ) => ReturnType<AppServerGoalRunner["runLogicalThreadGoal"]>;
  readonly disposeSession: () => Promise<void>;
} {
  let slotAcquired = false;
  return {
    runGoal: async (goalInput) => {
      const slot = await input.ensureSlot({
        session: input.execution.session,
        workspacePath: input.execution.workspacePath,
        abortSignal: input.execution.abortSignal,
      });
      slotAcquired = true;
      return await slot.goalRunner.runLogicalThreadGoal(goalInput);
    },
    disposeSession: async () => {
      if (slotAcquired) {
        await input.disposeSessionSlot(input.execution.session);
      }
    },
  };
}

export async function runCodexAppServerLogicalThreadWithSlot(
  input: CodexExecutionInput & { readonly previousCheckpoint?: string },
  deps: {
    readonly goalMode: boolean;
    readonly timeoutMs: number;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly ensureSlot: (input: {
      readonly session: CodexExecutionInput["session"];
      readonly workspacePath: string;
      readonly abortSignal: AbortSignal;
    }) => Promise<AppServerSlot>;
    readonly disposeSessionSlot: (
      session: CodexExecutionInput["session"],
    ) => Promise<void>;
    readonly redact: (
      result: AppServerRunResult,
      schemaWarnings: readonly AppServerWarning[],
    ) => CodexExecutionResult;
    readonly parse: (
      result: CodexExecutionResult,
      input: CodexExecutionInput,
      schemaPlan: CodexStructuredOutputSchemaPlan | undefined,
    ) => Promise<CodexExecutionResult>;
  },
): Promise<CodexLogicalThreadExecutionResult> {
  const schemaPlan = input.outputSchemaPlan ?? prepareCodexOutputSchemaPlan(input.outputSchema);
  const slotLifecycle = createAppServerLogicalThreadSlotLifecycle({
    execution: input,
    ensureSlot: deps.ensureSlot,
    disposeSessionSlot: deps.disposeSessionSlot,
  });
  return await runCodexAppServerLogicalThread(input, {
    ...(schemaPlan === undefined ? {} : { schemaPlan }),
    goalMode: deps.goalMode,
    timeoutMs: deps.timeoutMs,
    maxGoalTurns: deps.maxGoalTurns,
    goalContinuePrompt: deps.goalContinuePrompt,
    runGoal: slotLifecycle.runGoal,
    redact: deps.redact,
    parse: (result, parseInput) => deps.parse(result, parseInput, schemaPlan),
    disposeSession: slotLifecycle.disposeSession,
  });
}
