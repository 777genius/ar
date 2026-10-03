import {
  RunProcessAliveReason,
  RunProcessSupervisorKind,
} from "@vioxen/subscription-runtime/worker-core";
import {
  inspectCodexGoalProcessSnapshot,
  type CodexGoalProcessSnapshot,
} from "../codex-goal-process-snapshot";

export type CodexGoalDirectStopCommand = {
  readonly preview: string;
  readonly status:
    "terminated" | "process_gone" | "pid_missing" | "untrusted_process";
  readonly pid?: number;
};

export type CodexGoalWorkerLiveness = {
  readonly alive: boolean;
  readonly supervisorKind: RunProcessSupervisorKind;
  readonly aliveReason: RunProcessAliveReason;
  readonly processAlive: boolean;
  readonly freshProgressAlive: boolean;
};

type CodexGoalProcessStatus = {
  readonly tmuxAlive?: boolean;
  readonly progressExists?: boolean;
  readonly progressStatus?: string;
  readonly progressHeartbeatAgeMs?: number;
  readonly progressProcessAlive?: boolean;
  readonly progressCommand?: string;
  readonly progressProcessStartedAt?: string;
  readonly progressProcessTreeIdentities?: readonly {
    readonly pid: number;
    readonly startedAt: string;
  }[];
};

const directStopConfirmationTimeoutMs = 10_000;
const directStopConfirmationPollMs = 50;

type DirectProcessIdentityStatus = Pick<
  CodexGoalProcessStatus,
  "progressProcessStartedAt" | "progressProcessTreeIdentities"
> & { readonly progressPid?: number };

export async function waitForCodexGoalProcessTreeTermination(
  status: DirectProcessIdentityStatus,
  inspectProcess: (
    pid: number,
  ) => Promise<CodexGoalProcessSnapshot> = inspectCodexGoalProcessSnapshot,
  wait: (milliseconds: number) => Promise<void> = async (milliseconds) =>
    await new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  const identities = status.progressProcessTreeIdentities?.length
    ? status.progressProcessTreeIdentities
    : status.progressPid !== undefined && status.progressProcessStartedAt
      ? [
          {
            pid: status.progressPid,
            startedAt: status.progressProcessStartedAt,
          },
        ]
      : [];
  if (identities.length === 0) return;
  const deadline = Date.now() + directStopConfirmationTimeoutMs;
  while (true) {
    const aliveIdentities = await Promise.all(
      identities.map(async (identity) => {
        const snapshot = await inspectProcess(identity.pid);
        const originalIdentityGone = snapshot.alive === false ||
          (snapshot.alive === true &&
            snapshot.supervisorStartedAt !== undefined &&
            snapshot.supervisorStartedAt !== identity.startedAt);
        // Failed observations and missing start identities retain custody.
        return originalIdentityGone ? undefined : identity;
      }),
    );
    if (aliveIdentities.every((identity) => identity === undefined)) return;
    if (Date.now() >= deadline) {
      throw new Error("worker_process_termination_unconfirmed");
    }
    await wait(directStopConfirmationPollMs);
  }
}

export async function stopCodexGoalDirectProcess(
  status: Pick<
    CodexGoalProcessStatus,
    | "progressStatus"
    | "progressProcessAlive"
    | "progressCommand"
    | "progressProcessStartedAt"
    | "progressProcessTreeIdentities"
  > & { readonly progressPid?: number },
  inspectProcess: (
    pid: number,
  ) => Promise<CodexGoalProcessSnapshot> = inspectCodexGoalProcessSnapshot,
  wait: (milliseconds: number) => Promise<void> = async (milliseconds) =>
    await new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<CodexGoalDirectStopCommand> {
  const pid = status.progressPid;
  if (isCodexGoalProcessTerminalProgressStatus(status.progressStatus)) {
    return {
      preview: "terminal progress has no stoppable worker process",
      status: "process_gone",
      ...(pid === undefined ? {} : { pid }),
    };
  }
  if (pid === undefined) {
    return {
      preview: "no direct process pid",
      status: "pid_missing",
    };
  }
  const preview = `kill -TERM ${pid}`;
  // Unknown/dead cached facts cannot authorize success, even when identity
  // fields were unavailable. Affirm absence through the same snapshot reader.
  const observed = status.progressProcessAlive === true
    ? undefined
    : await inspectProcess(pid);
  if (observed?.alive === undefined && observed !== undefined) {
    throw new Error("worker_process_observation_unavailable");
  }
  if (observed?.alive === false) {
    await waitForCodexGoalProcessTreeTermination(status, inspectProcess, wait);
    return { preview: "direct worker process is already gone", status: "process_gone", pid };
  }
  if (!isTrustedCodexGoalDirectStopProcess(status.progressCommand)) {
    return {
      preview,
      status: "untrusted_process",
      pid,
    };
  }
  if (!status.progressProcessStartedAt) {
    return {
      preview,
      status: "untrusted_process",
      pid,
    };
  }
  const current = observed ?? await inspectProcess(pid);
  const currentCommand = current.supervisorCommand ?? current.command;
  if (current.alive === undefined) {
    throw new Error("worker_process_observation_unavailable");
  }
  if (current.alive === false) {
    await waitForCodexGoalProcessTreeTermination(status, inspectProcess, wait);
    return { preview, status: "process_gone", pid };
  }
  if (
    currentCommand !== status.progressCommand ||
    current.supervisorStartedAt !== status.progressProcessStartedAt
  ) {
    return { preview, status: "untrusted_process", pid };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ESRCH"
    ) {
      await waitForCodexGoalProcessTreeTermination(status, inspectProcess, wait);
      return {
        preview,
        status: "process_gone",
        pid,
      };
    }
    throw error;
  }
  await waitForCodexGoalProcessTreeTermination(status, inspectProcess, wait);
  return {
    preview,
    status: "terminated",
    pid,
  };
}

export function resolveCodexGoalWorkerLiveness(input: {
  readonly status: CodexGoalProcessStatus;
  readonly progressStale?: boolean;
}): CodexGoalWorkerLiveness {
  const tmuxAlive = input.status.tmuxAlive === true;
  const terminalProgress = isCodexGoalProcessTerminalProgressStatus(
    input.status.progressStatus,
  );
  const trustedProgressProcessAlive =
    input.status.progressProcessAlive === true &&
    isTrustedCodexGoalProgressProcess(input.status.progressCommand);
  const processAlive =
    !terminalProgress && (tmuxAlive || trustedProgressProcessAlive);
  const explicitSupervisorDead =
    input.status.tmuxAlive === false && !trustedProgressProcessAlive;
  const freshProgressAlive = Boolean(
    !terminalProgress &&
    !explicitSupervisorDead &&
    input.status.progressExists &&
    input.status.progressStatus === "running" &&
    input.status.progressHeartbeatAgeMs !== undefined &&
    input.progressStale !== true,
  );
  const alive = processAlive || freshProgressAlive;
  const supervisorKind = tmuxAlive
    ? RunProcessSupervisorKind.Tmux
    : terminalProgress
      ? RunProcessSupervisorKind.None
      : trustedProgressProcessAlive
        ? RunProcessSupervisorKind.Direct
        : freshProgressAlive
          ? RunProcessSupervisorKind.External
          : RunProcessSupervisorKind.None;
  return {
    alive,
    supervisorKind,
    aliveReason: tmuxAlive
      ? RunProcessAliveReason.Tmux
      : terminalProgress
        ? RunProcessAliveReason.TerminalResult
        : trustedProgressProcessAlive
          ? RunProcessAliveReason.Pid
          : freshProgressAlive
            ? RunProcessAliveReason.FreshProgress
            : input.status.progressStatus === "running" &&
                input.progressStale === true
              ? RunProcessAliveReason.StaleProgress
              : RunProcessAliveReason.Unknown,
    processAlive,
    freshProgressAlive,
  };
}

export function isCodexGoalStoppedProgressStatus(
  status: string | undefined,
): boolean {
  return status === "stopped" || status === "maintenance_paused";
}

function isCodexGoalProcessTerminalProgressStatus(
  status: string | undefined,
): boolean {
  return (
    isCodexGoalStoppedProgressStatus(status) ||
    status === "completed" ||
    status === "partial" ||
    status === "failed"
  );
}

function isTrustedCodexGoalProgressProcess(
  command: string | undefined,
): boolean {
  if (command === undefined) return true;
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  return !(trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function isTrustedCodexGoalDirectStopProcess(
  command: string | undefined,
): boolean {
  if (!isTrustedCodexGoalProgressProcess(command)) return false;
  const trimmed = command?.trim() ?? "";
  return (
    /\bsubscription-runtime-codex-goal\b/.test(trimmed) ||
    /\bcodex-goal-cli\.js\b/.test(trimmed)
  );
}
