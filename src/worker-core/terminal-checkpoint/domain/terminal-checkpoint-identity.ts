export type TerminalCheckpointClaimIdentity = {
  readonly projectId: string;
  readonly workstreamId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly executionGeneration: string;
  readonly attemptNumber: number;
  readonly ownershipEpoch: number;
  readonly runtimeSha: string;
  readonly registryRevisionSha256: string;
};

export function assertTerminalCheckpointClaimIdentity(identity: TerminalCheckpointClaimIdentity): void {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (![identity.projectId, identity.workstreamId, identity.jobId, identity.taskId,
    identity.executionGeneration].every((value) => id.test(value)) ||
    !Number.isSafeInteger(identity.attemptNumber) || identity.attemptNumber < 1 ||
    !Number.isSafeInteger(identity.ownershipEpoch) || identity.ownershipEpoch < 0 ||
    !/^[a-f0-9]{40}$/.test(identity.runtimeSha) ||
    !/^[a-f0-9]{64}$/.test(identity.registryRevisionSha256)) {
    throw new Error("terminal_checkpoint_claim_identity_invalid");
  }
}
