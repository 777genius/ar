import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const CODEX_FEATURE_ABSENCE_RETRY_DELAY_MS = 100;
const CODEX_FEATURE_PROBE_TIMEOUT_MS = 30_000;

export enum CodexRuntimeFeature {
  Goals = "goals",
  RolloutBudget = "rollout_budget",
}

export interface CodexRuntimeFeatureProbe {
  supports(input: {
    readonly binaryPath: string;
    readonly feature: CodexRuntimeFeature;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }): Promise<boolean>;
}

interface CodexCliRuntimeFeatureProbeOptions {
  readonly readFeatureList?: typeof execFileText;
  readonly waitBeforeAbsenceRetry?: (signal: AbortSignal) => Promise<void>;
}

export class CodexCliRuntimeFeatureProbe implements CodexRuntimeFeatureProbe {
  private readonly readFeatureList: typeof execFileText;
  private readonly waitBeforeAbsenceRetry: (
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(options: CodexCliRuntimeFeatureProbeOptions = {}) {
    this.readFeatureList = options.readFeatureList ?? execFileText;
    this.waitBeforeAbsenceRetry =
      options.waitBeforeAbsenceRetry ?? waitBeforeAbsenceRetry;
  }

  async supports(input: {
    readonly binaryPath: string;
    readonly feature: CodexRuntimeFeature;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }): Promise<boolean> {
    const firstObservation = await this.readFeatureList(
      input.binaryPath,
      ["features", "list"],
      input.env,
      input.signal,
    );
    if (featureListContains(firstObservation, input.feature)) return true;
    const firstObservationWasEmpty = firstObservation.trim().length === 0;

    await this.waitBeforeAbsenceRetry(input.signal);
    const secondObservation = await this.readFeatureList(
      input.binaryPath,
      ["features", "list"],
      input.env,
      input.signal,
    );
    if (featureListContains(secondObservation, input.feature)) return true;
    if (firstObservationWasEmpty || secondObservation.trim().length === 0) {
      throw new Error("Codex runtime returned an empty feature-list observation.");
    }
    return false;
  }
}

function featureListContains(
  stdout: string,
  feature: CodexRuntimeFeature,
): boolean {
  return stdout
    .split(/\r?\n/u)
    .some((line) => line.trimStart().startsWith(`${feature} `));
}

async function waitBeforeAbsenceRetry(signal: AbortSignal): Promise<void> {
  await delay(CODEX_FEATURE_ABSENCE_RETRY_DELAY_MS, undefined, { signal });
}

function execFileText(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        env: { ...env },
        maxBuffer: 256 * 1024,
        timeout: CODEX_FEATURE_PROBE_TIMEOUT_MS,
        signal,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
