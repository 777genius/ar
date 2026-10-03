/** Shared bounded read model for application and provider transport. */
export enum KeyedChildState {
  Claimed = "claimed", Materializing = "materializing", Prepared = "prepared",
  DispatchIntent = "dispatch_intent", Submitted = "submitted", Running = "running",
  StopRequested = "stop_requested", Terminal = "terminal", Uncertain = "uncertain",
}
export enum KeyedLaunchReason { None = "none", Held = "held", TerminationUnresolved = "termination_unresolved" }
export interface KeyedLaunchView {
  readonly operationHandle: string;
  readonly childHandle: string;
  readonly state: KeyedChildState;
  readonly occupied: boolean;
  readonly stopRequested: boolean;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  readonly reason: KeyedLaunchReason;
}
