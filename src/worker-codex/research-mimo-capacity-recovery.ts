import type { FileBackendCodexSafeExecutorOptions } from "./file-backend-codex-safe-executor";
import type { FileBackendCodexWorker, FileBackendCodexWorkerJob, FileBackendCodexWorkerResult } from "./file-backend-codex-worker";
import type { HostedMimoCurrentCredentialBinding, HostedMimoCapacityRecoveryProof } from "../provider-codex/codex-json-agent-driver";
import { WorkerAccountCapacitySignalScope, type WorkerAccountCapacityStore, type WorkerCapacitySnapshot, type SubscriptionWorkerRunOptions } from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import { codexAccountCapacityStore } from "./application/codex-account-capacity-store";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { HostedMimoProfile, type CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import type { WorkerAccountRecoveryTask, WorkerRuntimeDemand } from "@vioxen/subscription-runtime/worker-core";
import { ownedMimoWorkerStart, researchCurrentStart, researchProviderAdmissionGuard, researchProviderRetainedAuthorityGuard } from "./research-launch-admission";
import type { ResearchStartSpec } from "./research-launch-contract";
import { researchHash, researchInvalid } from "./research-launch-files";
import { codexSafeExecutorId } from "./codex-account-identity";

export type ResearchMimoTaskRecoveryOwner = Readonly<{ task: WorkerAccountRecoveryTask; assertCurrent(): void; assertRetainedCurrent(): void }>;
const issued = new WeakSet<ResearchMimoTaskRecoveryOwner>();

export function researchMimoRecoveryDemand(spec: ResearchStartSpec): WorkerRuntimeDemand {
  return { provider: "codex", model: spec.request.model, reasoningEffort: spec.request.reasoningEffort, serviceTier: spec.request.serviceTier };
}

export function researchMimoRecoveryTask(spec: ResearchStartSpec, specSha256: string): WorkerAccountRecoveryTask {
  return Object.freeze({ jobId: spec.request.jobId, startId: spec.startId, specSha256,
    requestSha256: spec.requestSha256, workerId: codexSafeExecutorId(spec.request.workspacePath) + ":slot-1",
    runtimeArtifactSha256: spec.artifactSha256 });
}

/** Only the admitted original Coding factory can prepare the one-task passage. */
export function researchMimoTaskRecoveryOwner(factory: CodexAppServerProcessFactory | undefined): ResearchMimoTaskRecoveryOwner | undefined {
  const spec = ownedMimoWorkerStart(factory);
  if (!spec || spec.request.hostedProfile !== HostedMimoProfile.CodingV1) return;
  const guard = researchProviderAdmissionGuard(factory)!, retained = researchProviderRetainedAuthorityGuard(factory);
  if (!retained) researchInvalid();
  const current = researchCurrentStart(spec.request.jobId);
  const owner = Object.freeze({ task: researchMimoRecoveryTask(spec, researchHash(current.bytes)), assertCurrent: (): void => {
    guard(); if (!researchCurrentStart(spec.request.jobId).bytes.equals(current.bytes)) researchInvalid();
  }, assertRetainedCurrent: (): void => { retained!(); } });
  issued.add(owner); return owner;
}

export function assertResearchMimoTaskRecoveryOwner(owner: ResearchMimoTaskRecoveryOwner): void {
  if (!issued.has(owner)) researchInvalid();
  owner.assertCurrent();
}
function assertRetainedRecoveryOwner(owner: ResearchMimoTaskRecoveryOwner): void {
  if (!issued.has(owner)) researchInvalid();
  owner.assertRetainedCurrent();
}

/** Called only by the existing terminal publication boundary, under its leases. */
export async function settleResearchMimoCapacityRecovery(current: ReturnType<typeof researchCurrentStart>, authority: Readonly<{
  assertTerminal(): void; withPublication<T>(effect: () => Promise<T>): Promise<T>;
}>): Promise<void> {
  const store = codexAccountCapacityStore(current.spec.request.authRootDir, { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan });
  if (store instanceof LocalFileWorkerAccountCapacityStore) await store.originalTaskRecovery().settle({
    task: researchMimoRecoveryTask(current.spec, researchHash(current.bytes)),
    assertCurrent: authority.assertTerminal, assertTerminal: authority.assertTerminal, withPublication: authority.withPublication,
  }, researchMimoRecoveryDemand(current.spec));
}

/** One source-owned task, composed through the existing accounted pool. */
export class ResearchMimoTaskRecoveryExecution {
  private taskRecovery: ReturnType<ReturnType<LocalFileWorkerAccountCapacityStore["originalTaskRecovery"]>["consume"]> | undefined;
  private taskRecoveryRunSucceeded = false;
  private taskRecoveryRunEntered = false;
  private taskRecoveryRunFinished = false;
  constructor(private readonly input: Readonly<{
    owner: ResearchMimoTaskRecoveryOwner; store: WorkerAccountCapacityStore;
    options: Pick<FileBackendCodexSafeExecutorOptions, "accounts" | "executionLifetime" | "maxAccountCycles" | "prewarmOnStart" | "clock">;
    worker(): FileBackendCodexWorker | undefined; accountId(): string;
  }>) {}

  readonly bindCredential = async (credential: HostedMimoCurrentCredentialBinding): Promise<() => void> => {
    assertResearchMimoTaskRecoveryOwner(this.input.owner);
    if (!this.taskRecovery) return () => {}; // Existing material/origin/key fences remain authoritative.
    return await this.taskRecovery.bindCredential(credential);
  };
  responseBeforeDispose(): HostedMimoCapacityRecoveryProof | undefined {
    return this.taskRecoveryRunSucceeded ? this.input.worker()?.capacityRecoveryProof() : undefined;
  }
  afterDispose(response: HostedMimoCapacityRecoveryProof | undefined): void {
    if (this.taskRecovery && this.taskRecoveryRunSucceeded) {
      try { this.taskRecovery.accepted(response); } catch { this.failed(); }
    }
  }
  capacity(): WorkerCapacitySnapshot | undefined {
    const owner = this.input.owner, store = this.input.store;
    if (!owner || !(store instanceof LocalFileWorkerAccountCapacityStore)) return;
    assertRetainedRecoveryOwner(owner);
    if (this.taskRecoveryRunEntered) return { availability: this.taskRecoveryRunFinished ? "disabled" : "busy", reason: "task_recovery_consumed" };
    const account = this.input.options.accounts[0]!;
    const demand = { provider: "codex", ...(account.worker.model ? { model: account.worker.model } : {}),
      ...(account.worker.reasoningEffort ? { reasoningEffort: account.worker.reasoningEffort } : {}),
      ...(account.worker.serviceTier ? { serviceTier: account.worker.serviceTier } : {}) };
    const preparation = store.originalTaskRecovery().prepareAdmission(demand, this.input.options.clock?.now() ?? new Date());
    return preparation ? { availability: "cooldown", reason: "task_recovery_pending", recoveryPending: preparation } : undefined;
  }

  async run(job: FileBackendCodexWorkerJob, options?: SubscriptionWorkerRunOptions): Promise<FileBackendCodexWorkerResult> {
    const owner = this.input.owner, store = this.input.store;
    const preparation = this.capacity()?.recoveryPending, worker = this.input.worker();
    if (!(store instanceof LocalFileWorkerAccountCapacityStore) || !preparation || !worker || worker.workerId !== owner.task.workerId ||
        this.input.options.accounts.length !== 1 || !this.input.options.executionLifetime || this.input.options.maxAccountCycles !== 1 || this.input.options.prewarmOnStart ||
        this.taskRecoveryRunEntered) throw new Error("worker_account_task_recovery_profile_denied");
    assertResearchMimoTaskRecoveryOwner(owner);
    this.taskRecoveryRunEntered = true;
    this.taskRecovery = store.originalTaskRecovery().consume(preparation, owner.task, () => assertRetainedRecoveryOwner(owner));
    try {
      const result = await worker.run(job, options);
      this.taskRecoveryRunSucceeded = true;
      return result;
    } catch (error) {
      const capacity = worker.capacity(), account = this.input.options.accounts[0]!;
      if (capacity.availability !== "available") {
        try { this.taskRecovery.store.observe({ accountId: this.input.accountId(),
          scope: WorkerAccountCapacitySignalScope.AccountWide, capacity, observedAt: new Date(), sourceWorkerId: worker.workerId }); }
        catch { /* The durable claim remains closed if limit recording is uncertain. */ }
      }
      this.failed(); throw error;
    } finally { this.taskRecoveryRunFinished = true; }
  }

  failed(): void {
    try { this.taskRecovery?.failed(); } catch { /* The durable consumed claim remains closed. */ }
  }

}
