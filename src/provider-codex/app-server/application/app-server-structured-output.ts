import type { ManagedRunStorePort } from "@vioxen/subscription-runtime/core";
import type { CodexExecutionResult } from "../../codex-json-execution-engine";
import {
  normalizeCodexStructuredOutput,
  type CodexStructuredOutputSchemaPlan,
} from "../../codex-structured-output-schema";
import { parseStructuredOutput } from "../domain/app-server-errors";
import { failManagedRunForProviderOutput } from "./app-server-managed-run-mapper";

export async function parseCodexAppServerStructuredOutput(input: {
  readonly result: CodexExecutionResult;
  readonly requested: boolean;
  readonly schemaPlan?: CodexStructuredOutputSchemaPlan;
  readonly goalMode: boolean | undefined;
  readonly runId?: string;
  readonly runStore: ManagedRunStorePort;
}): Promise<CodexExecutionResult> {
  if (!input.requested) return input.result;
  try {
    const parsed = parseStructuredOutput(input.result.outputText);
    return {
      ...input.result,
      structuredOutput: input.schemaPlan === undefined
        ? parsed
        : normalizeCodexStructuredOutput(input.schemaPlan, parsed),
    };
  } catch (error) {
    await failManagedRunForProviderOutput({
      goalMode: input.goalMode,
      runId: input.runId,
      runStore: input.runStore,
    });
    throw error;
  }
}
