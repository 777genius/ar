import type {
  LogicalThreadExecutionRecord,
  LogicalThreadState,
  ProviderThreadExecutionInput,
  ProviderThreadExecutionResult,
} from "./domain";

export interface LogicalThreadTransaction {
  readState(): LogicalThreadState | null;
  readExecution(
    executionId: string,
  ): Promise<LogicalThreadExecutionRecord | null>;
  writeState(state: LogicalThreadState): Promise<void>;
  writeExecution(record: LogicalThreadExecutionRecord): Promise<void>;
}

export interface LogicalThreadStore {
  withExclusive<T>(input: {
    readonly threadId: string;
    readonly action: (transaction: LogicalThreadTransaction) => Promise<T>;
  }): Promise<T>;
}

export interface ProviderThreadPort {
  execute(
    input: ProviderThreadExecutionInput,
  ): Promise<ProviderThreadExecutionResult>;
}
