import type { WorkerAccountCapacityStore, WorkerAccountLimitSignal, WorkerCapacitySnapshot } from "@777genius/subscription-runtime/worker-core";
export type LocalFileWorkerAccountCapacityStoreOptions = {
    readonly rootDir: string;
};
export declare class LocalFileWorkerAccountCapacityStore implements WorkerAccountCapacityStore {
    private readonly options;
    constructor(options: LocalFileWorkerAccountCapacityStoreOptions);
    read(input: {
        readonly accountId: string;
        readonly now?: Date;
    }): WorkerCapacitySnapshot | null;
    observe(input: WorkerAccountLimitSignal): void;
    clear(input: {
        readonly accountId: string;
    }): void;
    private readRecord;
    private writeRecord;
    private recordPath;
}
//# sourceMappingURL=local-worker-account-capacity-store.d.ts.map