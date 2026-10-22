/** Observed text only: a provider can imitate these public bootstrap labels.
 * This fact grants no producer identity, launch authority or retry decision. */
export enum AppServerLaunchStderrFact {
  BlockingOutputFailed = "blocking_output_failed",
  ChildSpawnFailed = "child_spawn_failed",
  ChildStdinFailed = "child_stdin_failed",
  CodingConfigInvalid = "coding_config_invalid",
  CodingModeInvalid = "coding_mode_invalid",
  DescriptorBoundaryInvalid = "descriptor_boundary_invalid",
  LaunchFrameInvalid = "launch_frame_invalid",
  LaunchFrameMissing = "launch_frame_missing",
  LaunchFrameTooLarge = "launch_frame_too_large",
  LaunchModeInvalid = "launch_mode_invalid",
  ResearchBootstrapDeadline = "research_bootstrap_deadline",
  ResearchInputFailed = "research_input_failed",
  ResearchReadyFailed = "research_ready_failed",
  ScratchBoundaryInvalid = "scratch_boundary_invalid",
  OriginalStorageInvalid = "original_storage_invalid",
}

// Exact fixed fail() lines owned by hosted-app-server-launcher. No captures.
const labels: ReadonlyMap<string, AppServerLaunchStderrFact> = new Map([
  ["hosted_app_server_blocking_output_failed\n", AppServerLaunchStderrFact.BlockingOutputFailed],
  ["hosted_app_server_child_spawn_failed\n", AppServerLaunchStderrFact.ChildSpawnFailed],
  ["hosted_app_server_child_stdin_failed\n", AppServerLaunchStderrFact.ChildStdinFailed],
  ["hosted_app_server_coding_config_invalid\n", AppServerLaunchStderrFact.CodingConfigInvalid],
  ["hosted_app_server_coding_mode_invalid\n", AppServerLaunchStderrFact.CodingModeInvalid],
  ["hosted_app_server_descriptor_boundary_invalid\n", AppServerLaunchStderrFact.DescriptorBoundaryInvalid],
  ["hosted_app_server_launch_frame_invalid\n", AppServerLaunchStderrFact.LaunchFrameInvalid],
  ["hosted_app_server_launch_frame_missing\n", AppServerLaunchStderrFact.LaunchFrameMissing],
  ["hosted_app_server_launch_frame_too_large\n", AppServerLaunchStderrFact.LaunchFrameTooLarge],
  ["hosted_app_server_launch_mode_invalid\n", AppServerLaunchStderrFact.LaunchModeInvalid],
  ["hosted_app_server_research_bootstrap_timeout\n", AppServerLaunchStderrFact.ResearchBootstrapDeadline],
  ["hosted_app_server_research_input_failed\n", AppServerLaunchStderrFact.ResearchInputFailed],
  ["hosted_app_server_research_ready_failed\n", AppServerLaunchStderrFact.ResearchReadyFailed],
  ["hosted_provider_scratch_boundary_invalid\n", AppServerLaunchStderrFact.ScratchBoundaryInvalid],
  ["original_provider_storage_context_invalid\n", AppServerLaunchStderrFact.OriginalStorageInvalid],
]);
const observations = new WeakMap<object, AppServerLaunchStderrFact>();
const factMessage = (fact: AppServerLaunchStderrFact): string => `app_server_stderr label=${fact}`;

/** Only our exact snapshot object is eligible. The one-hop own-data lookup
 * invokes no cause getter and reads no cause message or recursive chain. */
export function appServerLaunchStderrCauseFact(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const cause = Object.getOwnPropertyDescriptor(error, "cause")?.value as unknown;
    if (typeof cause !== "object" || cause === null) return undefined;
    const fact = observations.get(cause);
    return fact === undefined ? undefined : factMessage(fact);
  } catch { return undefined; }
}

export function createAppServerLaunchStderrObservation(): Readonly<{
  observe(chunk: unknown): void;
  snapshotCause(): Error | undefined;
}> {
  let text = "", refused = false;
  return {
    observe(chunk): void {
      if (refused) return;
      if (typeof chunk !== "string" || text.length + chunk.length > 128 || /[^\x20-\x7e\n]/.test(chunk)) {
        refused = true; text = ""; return;
      }
      text += chunk;
      if (![...labels.keys()].some(label => label.startsWith(text))) { refused = true; text = ""; }
    },
    snapshotCause(): Error | undefined {
      const fact = refused ? undefined : labels.get(text);
      // Snapshot only bytes already seen at the existing exit event. Do not
      // wait for EOF or infer that no later private stderr bytes can arrive.
      if (fact === undefined) return undefined;
      const cause = new Error(factMessage(fact)); observations.set(cause, fact); return cause;
    },
  };
}
