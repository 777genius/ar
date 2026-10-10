import { pathToFileURL } from "node:url";

// TEST-only child: independent compiled production modules and private metadata
// root. It exits after the real fsynced full-Q claim, during kernel preparation.
const storeModule = await import(pathToFileURL(process.argv[2]!).href) as typeof import("../../index");
const core = await import(pathToFileURL(process.argv[3]!).href) as typeof import("../../../../worker-core/job-storage-exposure/index");
const filesystem = core.parseStorageFilesystem(JSON.parse(process.argv[5]!));
const store = await storeModule.LocalStorageExposureStore.open({ rootPath: process.argv[4]!, filesystem });
const kernel: import("../../../../worker-core/job-storage-exposure/index").StorageExposureKernelPort = {
  ...core.unsupportedStorageExposureKernel(),
  async prepareOrVerifyQuota() { process.exit(23); },
};
const accounting = new core.StorageExposureAccounting(filesystem, store, {
  async readCapacity() { return { filesystem, available: { bytes: "34359738368", inodes: "100000" }, rootAvailableBytes: "8589934592" }; },
}, kernel);
const pending = await accounting.reserve({ filesystem,
  generation: { jobId: "test-crashed-claim", generationId: "d0f2cac1-2009-4e9d-a710-e156f417938f", projectId: 1 },
  operationId: "b0f2cac1-2009-4e9d-a710-e156f417938f", baseline: { bytes: "6442450944", inodes: "600" },
  growth: { bytes: "2147483648", inodes: "200" }, cap: { bytes: "8589934592", inodes: "800" } });
await accounting.activate(pending.generation, pending.revision);
process.exit(24); // Reaching here means the intended crash boundary disappeared.
