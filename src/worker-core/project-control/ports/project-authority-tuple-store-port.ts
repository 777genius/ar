export type ProjectAuthorityPreState = {
  readonly packetRevision: string;
  readonly baseSha: string;
  readonly phaseStartSha: null;
  readonly inputPatchHash: string;
};

export type ProjectAuthorityTuple = Omit<ProjectAuthorityPreState, "phaseStartSha"> & {
  readonly phaseStartSha: string;
  readonly reviewReceiptSha256: string;
};

export enum ProjectAuthorityCasStatus {
  Applied = "applied",
  Noop = "noop",
}

export enum ProjectAuthorityInitializeStatus {
  Initialized = "initialized",
  Noop = "noop",
}

export interface ProjectAuthorityTupleStorePort {
  initialize(
    expected: ProjectAuthorityPreState,
  ): Promise<ProjectAuthorityInitializeStatus>;
  compareAndSet(input: {
    readonly expected: ProjectAuthorityPreState;
    readonly desired: ProjectAuthorityTuple;
  }): Promise<ProjectAuthorityCasStatus>;
}
