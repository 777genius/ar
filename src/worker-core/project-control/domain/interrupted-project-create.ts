/** Settlement reports a proven termination; it never grants another execution. */
export enum InterruptedProjectCreateTermination {
  RuntimeTimeout = "runtime_timeout",
}

export enum InterruptedProjectCreateDisposition {
  RetainedUnregisteredFailure = "retained_unregistered_failure",
}

export enum InterruptedProjectCreateErrorCode {
  RuntimeTimeout = "project_control_interrupted_create_timeout",
  ReconciliationRefused = "project_control_interrupted_create_reconciliation_refused",
}

export type InterruptedProjectCreateOutcome = Readonly<{
  termination: InterruptedProjectCreateTermination.RuntimeTimeout;
  disposition: InterruptedProjectCreateDisposition.RetainedUnregisteredFailure;
  registrationPublished: false;
  payloadStarted: false;
  partialsPreserved: true;
}>;
