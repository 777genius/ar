import {
  collectCodexGoalStatus,
  stopCodexGoalDirectProcess,
  stopCodexGoalTmux,
  waitForCodexGoalProcessTreeTermination,
  type CodexGoalLaunchInput,
  type CodexGoalStatus,
} from "./codex-goal-ops";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import { tryMaterializeTerminalCodexGoalHandoff } from "./codex-goal-terminal-handoff-materialization";

export async function preserveTerminalCodexGoalHandoffBeforeStop(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly status: CodexGoalStatus;
  readonly forceAfterMaterializationFailure: boolean;
}) {
  const { launch, status } = input;
  const stopDirect = async (fresh: CodexGoalStatus) => {
    const command = await stopCodexGoalDirectProcess(fresh);
    if (command.status === "untrusted_process") {
      throw new Error("project_control_stop_untrusted_process");
    }
    if (command.status === "pid_missing" && fresh.progressStatus === "running") {
      throw new Error("worker_process_observation_unavailable");
    }
    // A fresh snapshot must not erase descendants captured before the stop.
    await waitForCodexGoalProcessTreeTermination(status);
    return command;
  };
  return preserveTerminalHandoffBeforeForcedStop({
    materialize: () => tryMaterializeTerminalCodexGoalHandoff(launch.config),
    stop: async () => {
      if (!launch.tmuxSession) return stopDirect(status);
      if (status.tmuxAlive === false) {
        const statusAfter = await collectCodexGoalStatus(statusInput(launch));
        return stopDirect(statusAfter);
      }

      try {
        const command = await stopCodexGoalTmux(launch.tmuxSession);
        await waitForCodexGoalProcessTreeTermination(status);
        return command;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (!/can't find session|no server running/i.test(message)) {
          throw error;
        }
        const statusAfter = await collectCodexGoalStatus(statusInput(launch));
        if (statusAfter.tmuxAlive !== false) throw error;
        return stopDirect(statusAfter);
      }
    },
    forceAfterMaterializationFailure: input.forceAfterMaterializationFailure,
  });
}

export type DurableStopHandoffEvidence = {
  readonly packetPath?: string;
  readonly manifestSha256?: string;
  readonly errorCode?: string;
};

type VerifiedDurableStopHandoff<THandoff extends DurableStopHandoffEvidence> =
  THandoff & {
    readonly packetPath: string;
    readonly manifestSha256: string;
  };

export class DurableHandoffStopError<
  THandoff extends DurableStopHandoffEvidence = DurableStopHandoffEvidence,
> extends Error {
  readonly handoff: VerifiedDurableStopHandoff<THandoff>;
  readonly stopError: unknown;

  constructor(
    handoff: VerifiedDurableStopHandoff<THandoff>,
    stopError: unknown,
  ) {
    super(stopError instanceof Error ? stopError.message : "worker_stop_failed");
    this.name = "DurableHandoffStopError";
    this.handoff = handoff;
    this.stopError = stopError;
  }
}

export class DurableHandoffPostStopError<
  T,
  THandoff extends DurableStopHandoffEvidence = DurableStopHandoffEvidence,
> extends Error {
  readonly preStopHandoff: VerifiedDurableStopHandoff<THandoff>;
  readonly stopResult: T;
  readonly materializationError: unknown;

  constructor(
    preStopHandoff: VerifiedDurableStopHandoff<THandoff>,
    stopResult: T,
    materializationError: unknown,
  ) {
    const message = materializationError instanceof Error
      ? materializationError.message
      : "terminal_handoff_materialization_failed";
    super(message);
    this.name = "DurableHandoffPostStopError";
    this.preStopHandoff = preStopHandoff;
    this.stopResult = stopResult;
    this.materializationError = materializationError;
  }
}

export async function preserveTerminalHandoffBeforeStop<
  T,
  THandoff extends DurableStopHandoffEvidence,
>(input: {
  readonly materialize: () => Promise<THandoff>;
  readonly stop: () => Promise<T> | T;
}): Promise<{
  readonly handoff: VerifiedDurableStopHandoff<THandoff>;
  readonly stopResult: T;
}> {
  const preStopHandoff = await input.materialize();
  if (!preStopHandoff.packetPath || !preStopHandoff.manifestSha256) {
    throw new Error(
      `durable_handoff_materialization_failed:${preStopHandoff.errorCode ?? "unknown"}`,
    );
  }
  const verifiedPreStopHandoff = preStopHandoff as
    VerifiedDurableStopHandoff<THandoff>;
  let stopResult: T;
  try {
    stopResult = await input.stop();
  } catch (error) {
    throw new DurableHandoffStopError(verifiedPreStopHandoff, error);
  }
  let terminalHandoff: THandoff;
  try {
    terminalHandoff = await input.materialize();
  } catch (error) {
    throw new DurableHandoffPostStopError(
      verifiedPreStopHandoff,
      stopResult,
      error,
    );
  }
  if (!terminalHandoff.packetPath || !terminalHandoff.manifestSha256) {
    throw new DurableHandoffPostStopError(
      verifiedPreStopHandoff,
      stopResult,
      new Error(
        `durable_terminal_handoff_materialization_failed:${terminalHandoff.errorCode ?? "unknown"}`,
      ),
    );
  }
  return {
    handoff: terminalHandoff as VerifiedDurableStopHandoff<THandoff>,
    stopResult,
  };
}

export async function preserveTerminalHandoffBeforeForcedStop<
  T,
  THandoff extends DurableStopHandoffEvidence,
>(input: {
  readonly materialize: () => Promise<THandoff>;
  readonly stop: () => Promise<T> | T;
  readonly forceAfterMaterializationFailure: boolean;
}): Promise<{
  readonly handoff?: VerifiedDurableStopHandoff<THandoff>;
  readonly stopResult: T;
  readonly preservationError?: string;
}> {
  try {
    return await preserveTerminalHandoffBeforeStop(input);
  } catch (error) {
    if (error instanceof DurableHandoffStopError) {
      throw error;
    }
    if (error instanceof DurableHandoffPostStopError) {
      if (!input.forceAfterMaterializationFailure) throw error;
      return {
        handoff: error.preStopHandoff as VerifiedDurableStopHandoff<THandoff>,
        stopResult: error.stopResult,
        preservationError: error.message,
      };
    }
    if (!input.forceAfterMaterializationFailure) throw error;
    const stopResult = await input.stop();
    try {
      const handoff = await input.materialize();
      if (handoff.packetPath && handoff.manifestSha256) {
        return {
          handoff: handoff as VerifiedDurableStopHandoff<THandoff>,
          stopResult,
        };
      }
    } catch {
      // The force override intentionally permits a degraded stop when terminal
      // preservation remains impossible after the worker is gone.
    }
    return {
      stopResult,
      preservationError: error instanceof Error ? error.message : "unknown",
    };
  }
}

export function durableHandoffStopEvidence(input: {
  readonly handoff?: {
    readonly packetPath: string;
    readonly manifestSha256: string;
  };
  readonly preservationError?: string;
}): Readonly<Record<string, string>> {
  return {
    ...(input.handoff
      ? {
          handoffPacketPath: input.handoff.packetPath,
          handoffManifestSha256: input.handoff.manifestSha256,
        }
      : {}),
    ...(input.preservationError
      ? {
          handoffPreservationError: input.preservationError,
          preservationDegraded: "true",
        }
      : {}),
  };
}
