/** The lease is opaque to application code and is returned only to its issuer. */
export interface ConsumedOutputLedgerMutationLockPort {
  acquire(input: {
    readonly ledgerRoots: readonly string[];
    readonly owner: string;
    readonly custodyRoot?: string;
  }): Promise<object>;
  release(lease: object): Promise<void>;
}
