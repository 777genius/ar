import { pathToFileURL } from "node:url";
import type { JobStorageAdmissionReceipt } from "../../../../worker-core/job-storage/domain/job-storage";
import type { JobStorageGenerationAuthority } from "../../../../worker-core/job-storage/ports/job-storage-ports";

// Independent NEW TEST process, production durable adapter and actual settlement
// service. Native authority/receipt double is intentionally not qualification.
const module = await import(pathToFileURL(process.argv[2]!).href) as typeof import("../../index");
const controlRoot = JSON.parse(process.argv[3]!) as import("../../index").RegisteredSettlementRoot;
const receipt = JSON.parse(process.argv[4]!) as JobStorageAdmissionReceipt;
const identity = { jobId: receipt.jobId, generationId: receipt.generationId, receiptSha256: receipt.receiptSha256 };
const authority: JobStorageGenerationAuthority = {
  async withGenerationFence(_identity, effect) { return effect(); },
  async verifyNativeDrain() { throw new Error("TEST must crash before drain"); },
};
const store = await module.LocalJobStorageSettlementStore.open({ controlRoot, identity, authority,
  async readAuthenticatedReceipt() { return receipt; } });
await store.createService({ async verify() { process.exit(23); } }).close(identity, 1, "NEWTEST-handoff", "NEWTEST-drain");
process.exit(24); // Reaching here means the intended crash boundary disappeared.
