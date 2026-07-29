import { pathToFileURL } from "node:url";
import {
  AgentRuntimeFailureCode,
  AgentRuntimeTaskEventType,
  AgentRuntimeTaskResultStatus,
  type ProviderTaskEvent,
  type ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeFailureLifecycleState,
  AgentRuntimeTaskProtocolError,
  agentRuntimeTaskProtocolVersionV1,
  makeAgentRuntimeTaskFailure,
  parseAgentRuntimeTaskEvent,
  parseAgentRuntimeTaskRequest,
  parseAgentRuntimeTaskResult,
  providerTaskEventToAgentRuntimeTaskEvent,
  providerTaskResultToAgentRuntimeTaskResult,
  type AgentRuntimeTaskBridgeRunResult,
  type AgentRuntimeTaskEvent,
  type AgentRuntimeTaskRequest,
  type AgentRuntimeTaskResult,
  type AgentRuntimeTaskProtocolVersion,
} from "./task-codec";
import {
  type AgentRuntimeTaskHandler,
  type AgentRuntimeTaskHandlerContext,
  type AgentRuntimeTaskRunFunction,
  type AgentRuntimeTaskStreamFunction,
} from "./task-codec/ports";

export type AgentRuntimeTaskBridgeOptions = {
  readonly abortSignal?: AbortSignal;
  readonly now?: () => Date;
  onEvent?(event: AgentRuntimeTaskEvent): void | Promise<void>;
};

export async function runAgentRuntimeTaskBridge(
  requestValue: unknown,
  handler: AgentRuntimeTaskHandler | AgentRuntimeTaskRunFunction,
  options: AgentRuntimeTaskBridgeOptions = {},
): Promise<AgentRuntimeTaskBridgeRunResult> {
  const request = parseAgentRuntimeTaskRequest(requestValue);
  const normalizedHandler = normalizeHandler(handler);
  const deadline = new AgentRuntimeTaskBridgeDeadline(
    request.timeoutMs,
    options.abortSignal,
  );
  const events: AgentRuntimeTaskEvent[] = [];
  let startedEmitted = false;
  let terminalFromEmit: AgentRuntimeTaskResult | null = null;
  const recordEvent = (event: AgentRuntimeTaskEvent): void => {
    if (event.type === AgentRuntimeTaskEventType.Started) startedEmitted = true;
    if (event.type === AgentRuntimeTaskEventType.Completed) {
      terminalFromEmit = event.result;
    }
    events.push(event);
  };
  const emit = async (
    event: AgentRuntimeTaskEvent | ProviderTaskEvent,
  ): Promise<void> => {
    deadline.throwIfAborted();
    const normalized = normalizeEvent(event, request.protocolVersion);
    await deadline.race(Promise.resolve(options.onEvent?.(normalized)));
    deadline.throwIfAborted();
    recordEvent(normalized);
  };
  const emitStarted = async (occurredAt = nowIso(options)): Promise<void> => {
    if (startedEmitted) return;
    await emit({
      protocolVersion: request.protocolVersion,
      type: AgentRuntimeTaskEventType.Started,
      occurredAt,
    });
  };
  const context = createContext({ abortSignal: deadline.signal, emit });

  try {
    if (normalizedHandler.streamTask) {
      let yieldedTerminal: AgentRuntimeTaskResult | null = null;
      const stream = normalizedHandler.streamTask(request, context);
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await deadline.race(iterator.next());
        if (next.done) break;
        const event = next.value;
        const normalized = normalizeEvent(event, request.protocolVersion);
        if (
          normalized.type === AgentRuntimeTaskEventType.Started &&
          startedEmitted
        ) {
          continue;
        }
        if (normalized.type === AgentRuntimeTaskEventType.Started) {
          await emit(normalized);
          continue;
        }
        await emitStarted(normalized.occurredAt);
        await emit(normalized);
        if (normalized.type === AgentRuntimeTaskEventType.Completed) {
          yieldedTerminal = normalized.result;
        }
      }
      const terminal = yieldedTerminal ?? terminalFromEmit;
      if (terminal) return { request, result: terminal, events: [...events] };
      await emitStarted();
      const result = makeBridgeFailure(
        request.protocolVersion,
        true,
        "provider_output_invalid",
        "Stream ended without a completed event.",
      );
      await emit({
        protocolVersion: request.protocolVersion,
        type: AgentRuntimeTaskEventType.Completed,
        occurredAt: nowIso(options),
        result,
      } as AgentRuntimeTaskEvent);
      return {
        request,
        result,
        events: [...events],
      };
    }

    await emitStarted();
    if (!normalizedHandler.runTask) {
      return {
        request,
        result: makeBridgeFailure(
          request.protocolVersion,
          true,
          "provider_output_invalid",
          "Agent runtime task handler has no runTask implementation.",
        ),
        events: [...events],
      };
    }

    const result = normalizeResult(
      await deadline.race(
        Promise.resolve(normalizedHandler.runTask(request, context)),
      ),
      request.protocolVersion,
    );
    await emit({
      protocolVersion: request.protocolVersion,
      type: AgentRuntimeTaskEventType.Completed,
      occurredAt: nowIso(options),
      result,
    } as AgentRuntimeTaskEvent);
    return { request, result, events: [...events] };
  } catch (error) {
    const result = bridgeFailureFromError(
      error,
      request.protocolVersion,
      startedEmitted,
    );
    appendFailureEvents({
      events,
      recordEvent,
      result,
      startedEmitted,
      options,
      protocolVersion: request.protocolVersion,
    });
    return { request, result, events: [...events] };
  } finally {
    deadline.dispose();
  }
}

export async function* streamAgentRuntimeTaskBridge(
  requestValue: unknown,
  handler: AgentRuntimeTaskHandler | AgentRuntimeTaskRunFunction,
  options: Omit<AgentRuntimeTaskBridgeOptions, "onEvent"> = {},
): AsyncIterable<AgentRuntimeTaskEvent> {
  const queued: AgentRuntimeTaskEvent[] = [];
  let done = false;
  let failed: unknown;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };

  const run = runAgentRuntimeTaskBridge(requestValue, handler, {
    ...options,
    onEvent: (event) => {
      queued.push(event);
      notify();
    },
  }).then(
    () => {
      done = true;
      notify();
    },
    (error: unknown) => {
      failed = error;
      done = true;
      notify();
    },
  );

  while (!done || queued.length > 0) {
    if (queued.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queued.shift() as AgentRuntimeTaskEvent;
  }

  await run;
  if (failed !== undefined) {
    throw failed;
  }
}

export async function loadAgentRuntimeTaskHandler(
  specifier: string,
  input?: { readonly cwd?: string },
): Promise<AgentRuntimeTaskHandler | AgentRuntimeTaskRunFunction> {
  const module = await import(resolveImportSpecifier(specifier, input?.cwd));
  const candidate =
    module.runAgentRuntimeTask ??
    module.handler ??
    module.default ??
    module.runTask ??
    module.streamTask;
  if (typeof candidate === "function") return candidate as AgentRuntimeTaskRunFunction;
  if (candidate && typeof candidate === "object") {
    const maybeHandler = candidate as Partial<AgentRuntimeTaskHandler>;
    if (
      typeof maybeHandler.runTask === "function" ||
      typeof maybeHandler.streamTask === "function"
    ) {
      return maybeHandler as AgentRuntimeTaskHandler;
    }
  }
  if (
    typeof module.runTask === "function" ||
    typeof module.streamTask === "function"
  ) {
    return {
      ...(typeof module.runTask === "function"
        ? { runTask: module.runTask as AgentRuntimeTaskRunFunction }
        : {}),
      ...(typeof module.streamTask === "function"
        ? { streamTask: module.streamTask as AgentRuntimeTaskStreamFunction }
        : {}),
    };
  }
  throw new AgentRuntimeTaskProtocolError(
    "agent_runtime_task_handler_invalid",
    "Handler module must export runAgentRuntimeTask, handler, default, runTask, or streamTask.",
  );
}

function normalizeHandler(
  handler: AgentRuntimeTaskHandler | AgentRuntimeTaskRunFunction,
): AgentRuntimeTaskHandler {
  if (typeof handler === "function") return { runTask: handler };
  if (
    typeof handler.runTask === "function" ||
    typeof handler.streamTask === "function"
  ) {
    return handler;
  }
  throw new AgentRuntimeTaskProtocolError(
    "agent_runtime_task_handler_invalid",
    "Agent runtime task handler must be a function or an object with runTask/streamTask.",
  );
}

function createContext(input: {
  readonly abortSignal?: AbortSignal;
  emit(event: AgentRuntimeTaskEvent | ProviderTaskEvent): Promise<void>;
}): AgentRuntimeTaskHandlerContext {
  return {
    abortSignal: input.abortSignal ?? new AbortController().signal,
    emit: input.emit,
  };
}

function normalizeResult(
  value: AgentRuntimeTaskResult | ProviderTaskResult,
  protocolVersion: AgentRuntimeTaskProtocolVersion,
): AgentRuntimeTaskResult {
  if (isAgentRuntimeTaskResultLike(value)) {
    const result = parseAgentRuntimeTaskResult(value);
    if (result.protocolVersion !== protocolVersion) {
      throw new AgentRuntimeTaskProtocolError(
        "agent_runtime_task_result_invalid",
        "Handler result protocolVersion must match request.protocolVersion.",
      );
    }
    return result;
  }
  return providerTaskResultToAgentRuntimeTaskResult(value, { protocolVersion });
}

function normalizeEvent(
  value: AgentRuntimeTaskEvent | ProviderTaskEvent,
  protocolVersion: AgentRuntimeTaskProtocolVersion,
): AgentRuntimeTaskEvent {
  if (isAgentRuntimeTaskEventLike(value)) {
    const event = parseAgentRuntimeTaskEvent(value);
    if (event.protocolVersion !== protocolVersion) {
      throw new AgentRuntimeTaskProtocolError(
        "agent_runtime_task_event_invalid",
        "Handler event protocolVersion must match request.protocolVersion.",
      );
    }
    return event;
  }
  return providerTaskEventToAgentRuntimeTaskEvent(value, protocolVersion);
}

function isAgentRuntimeTaskResultLike(value: unknown): value is AgentRuntimeTaskResult {
  return hasProtocolVersion(value) && hasStringProperty(value, "status");
}

function isAgentRuntimeTaskEventLike(value: unknown): value is AgentRuntimeTaskEvent {
  return hasProtocolVersion(value) && hasStringProperty(value, "type");
}

function hasProtocolVersion(
  value: unknown,
): value is { readonly protocolVersion: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value
  );
}

function hasStringProperty(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

function makeBridgeFailure(
  protocolVersion: AgentRuntimeTaskProtocolVersion,
  taskStarted: boolean,
  code: Parameters<typeof makeAgentRuntimeTaskFailure>[0],
  safeMessage: string,
): AgentRuntimeTaskResult {
  return {
    protocolVersion,
    status: AgentRuntimeTaskResultStatus.Failed,
    failure: makeAgentRuntimeTaskFailure(code, safeMessage),
    ...(protocolVersion !== agentRuntimeTaskProtocolVersionV1
      ? {
          lifecycle: taskStarted
            ? {
                state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
                taskStarted: true as const,
              }
            : {
                state: AgentRuntimeFailureLifecycleState.PreflightFailed,
                taskStarted: false as const,
              },
        }
      : {}),
    warnings: [],
  } as AgentRuntimeTaskResult;
}

function bridgeFailureFromError(
  error: unknown,
  protocolVersion: AgentRuntimeTaskProtocolVersion,
  taskStarted: boolean,
): AgentRuntimeTaskResult {
  if (error instanceof AgentRuntimeTaskBridgeTimeoutError) {
    return makeBridgeFailure(
      protocolVersion,
      taskStarted,
      AgentRuntimeFailureCode.TaskTimeout,
      error.message,
    );
  }
  if (error instanceof AgentRuntimeTaskBridgeCancelledError) {
    return makeBridgeFailure(
      protocolVersion,
      taskStarted,
      AgentRuntimeFailureCode.TaskCancelled,
      error.message,
    );
  }
  return makeBridgeFailure(
    protocolVersion,
    taskStarted,
    error instanceof AgentRuntimeTaskProtocolError
      ? AgentRuntimeFailureCode.ProviderOutputInvalid
      : AgentRuntimeFailureCode.UnknownRuntimeFailure,
    error instanceof Error ? error.message : "Agent runtime task handler failed.",
  );
}

function appendFailureEvents(input: {
  readonly events: AgentRuntimeTaskEvent[];
  readonly recordEvent: (event: AgentRuntimeTaskEvent) => void;
  readonly result: AgentRuntimeTaskResult;
  readonly startedEmitted: boolean;
  readonly options: AgentRuntimeTaskBridgeOptions;
  readonly protocolVersion: AgentRuntimeTaskProtocolVersion;
}): void {
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    if (input.events[index]?.type === AgentRuntimeTaskEventType.Completed) {
      input.events.splice(index, 1);
    }
  }
  if (!input.startedEmitted) {
    const started = {
      protocolVersion: input.protocolVersion,
      type: AgentRuntimeTaskEventType.Started,
      occurredAt: nowIso(input.options),
    } as AgentRuntimeTaskEvent;
    input.recordEvent(started);
    notifyEventBestEffort(input.options, started);
  }
  const completed = {
    protocolVersion: input.protocolVersion,
    type: AgentRuntimeTaskEventType.Completed,
    occurredAt: nowIso(input.options),
    result: input.result,
  } as AgentRuntimeTaskEvent;
  input.recordEvent(completed);
  notifyEventBestEffort(input.options, completed);
}

function notifyEventBestEffort(
  options: AgentRuntimeTaskBridgeOptions,
  event: AgentRuntimeTaskEvent,
): void {
  try {
    void Promise.resolve(options.onEvent?.(event)).catch(() => undefined);
  } catch {
    // The terminal result must not be held hostage by a broken event observer.
  }
}

class AgentRuntimeTaskBridgeDeadline {
  readonly signal: AbortSignal;

  private readonly abortController = new AbortController();
  private readonly aborted: Promise<never>;
  private abortListener: (() => void) | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;

  constructor(
    private readonly timeoutMs: number | undefined,
    parentSignal: AbortSignal | undefined,
  ) {
    this.signal = parentSignal
      ? AbortSignal.any([parentSignal, this.abortController.signal])
      : this.abortController.signal;
    this.aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(this.abortError());
      this.abortListener = onAbort;
      if (this.signal.aborted) onAbort();
      else this.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (timeoutMs !== undefined) {
      this.timeout = setTimeout(() => {
        this.timedOut = true;
        this.abortController.abort();
      }, timeoutMs);
    }
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    this.throwIfAborted();
    return await Promise.race([operation, this.aborted]);
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw this.abortError();
  }

  dispose(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    if (this.abortListener) {
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
  }

  private abortError(): Error {
    return this.timedOut && this.timeoutMs !== undefined
      ? new AgentRuntimeTaskBridgeTimeoutError(this.timeoutMs)
      : new AgentRuntimeTaskBridgeCancelledError();
  }
}

class AgentRuntimeTaskBridgeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent runtime task timed out after ${timeoutMs}ms.`);
    this.name = "AgentRuntimeTaskBridgeTimeoutError";
  }
}

class AgentRuntimeTaskBridgeCancelledError extends Error {
  constructor() {
    super("Agent runtime task was cancelled.");
    this.name = "AgentRuntimeTaskBridgeCancelledError";
  }
}

function nowIso(options: AgentRuntimeTaskBridgeOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function resolveImportSpecifier(specifier: string, cwd = process.cwd()): string {
  if (
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("data:") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)
  ) {
    return specifier;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const path = specifier.startsWith("/")
      ? specifier
      : new URL(specifier, pathToFileURL(`${cwd}/`)).pathname;
    return pathToFileURL(path).href;
  }
  return specifier;
}
