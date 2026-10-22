/** Execution lifetime scheduling. Adapters independently prove discharge;
 * a domain handle never grants provider, filesystem or credential authority. */
export enum SessionExecutionUseDisposition {
  Discharged = "discharged",
  Retained = "retained",
}
export interface SessionExecutionUse {
  complete(): Promise<SessionExecutionUseDisposition>;
}
export interface SessionExecutionLifecyclePort {
  begin(): Promise<SessionExecutionUse>;
}
