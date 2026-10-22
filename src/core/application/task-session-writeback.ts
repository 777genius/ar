import { computeSessionGenerationHash } from "../domain/generation-hash";
import type { CompiledRuntimePolicy, RunContext, RuntimeExecutionPlan, RuntimeEvent, RuntimeWarning, SessionArtifact, SessionEnvelope } from "../domain/types";
import type { RuntimeDeps, SessionExecutionUse, SessionStorePort } from "../ports";

type WritebackInput = Readonly<{sessionEnvelope:SessionEnvelope;sessionUpdate:SessionArtifact;runContext:RunContext}>;
enum TaskSessionWritebackPhase { Acquired="acquired", Finalized="finalized", Started="started", Written="written", Committed="committed" }
type PendingWriteback = {
  readonly source:WritebackInput; readonly nextHash:string;
  readonly intent:Parameters<SessionStorePort["write"]>[0];
  phase:TaskSessionWritebackPhase;
  receipt?:Extract<Awaited<ReturnType<SessionStorePort["write"]>>,{status:"accepted"|"idempotent_replay"}>;
};

/** The application owns only its original write intent, lease and acknowledgements. */
export class TaskSessionWriteback {
  readonly #pending = new Map<SessionExecutionUse,PendingWriteback>();
  constructor(private readonly deps:RuntimeDeps,private readonly policy:CompiledRuntimePolicy,private readonly plan:RuntimeExecutionPlan) {}

  forget(use:SessionExecutionUse):void { this.#pending.delete(use); }

  async write(input:WritebackInput,use?:SessionExecutionUse):Promise<readonly RuntimeWarning[]> {
    if (this.plan.kind !== "rotating-session") return [{code:"task_session_update_ignored",safeMessage:"Task session update was ignored because the runtime session does not rotate."}];
    if (input.sessionUpdate.providerId !== input.sessionEnvelope.providerId) return [{code:"task_session_update_provider_mismatch",safeMessage:"Task session update was ignored because the provider did not match."}];
    const nextHash = computeSessionGenerationHash({artifact:input.sessionUpdate});
    if (nextHash === input.sessionEnvelope.generationHash) return [];
    const sessionStore = this.deps.sessionStore, leaseStore = this.deps.leaseStore;
    if (!sessionStore || !leaseStore) throw new Error("session_store_required");
    let held = use ? this.#pending.get(use) : undefined;
    if (held && (held.nextHash !== nextHash || held.source.sessionUpdate !== input.sessionUpdate ||
        held.source.sessionEnvelope.providerInstanceId !== input.sessionEnvelope.providerInstanceId || held.source.sessionEnvelope.generation !== input.sessionEnvelope.generation ||
        held.source.sessionEnvelope.generationHash !== input.sessionEnvelope.generationHash || held.source.runContext.runId !== input.runContext.runId || held.source.runContext.attempt !== input.runContext.attempt)) throw new Error("task_session_finalization_changed");
    if (!held) {
      const lease = await leaseStore.acquire({providerInstanceId:input.sessionEnvelope.providerInstanceId,runId:input.runContext.runId,attempt:input.runContext.attempt,
        ttlMs:this.policy.timeoutMs,restoredGenerationHash:input.sessionEnvelope.generationHash});
      if (lease.status !== "granted") return [{code:`task_session_update_writeback_${lease.status}`,safeMessage:"Task session update could not be written back because the session lease was unavailable."}];
      const idempotencyKey = `${this.deps.idGenerator.idempotencyKey({providerInstanceId:input.sessionEnvelope.providerInstanceId,runId:input.runContext.runId,
        attempt:input.runContext.attempt,purpose:"writeback"})}:task-session-update:${nextHash.slice(0,16)}`;
      held = {source:Object.freeze({...input,sessionEnvelope:Object.freeze({...input.sessionEnvelope}),runContext:Object.freeze({...input.runContext})}),nextHash,
        intent:Object.freeze({providerInstanceId:input.sessionEnvelope.providerInstanceId,expectedGeneration:input.sessionEnvelope.generation,nextArtifact:input.sessionUpdate,idempotencyKey,leaseId:lease.leaseId}),phase:TaskSessionWritebackPhase.Acquired};
      if (use) this.#pending.set(use,held);
    }
    const selected = held, {intent} = selected;
    try {
      if (selected.phase === TaskSessionWritebackPhase.Acquired) {
        await leaseStore.finalize({leaseId:intent.leaseId!,restoredGenerationHash:selected.source.sessionEnvelope.generationHash});
        selected.phase = TaskSessionWritebackPhase.Finalized;
        this.emit("session.task_update.writeback.started",input.runContext.runId,{leaseId:intent.leaseId!,expectedGeneration:String(intent.expectedGeneration)});
      }
      if (selected.phase === TaskSessionWritebackPhase.Finalized) { await leaseStore.markWritebackStarted({leaseId:intent.leaseId!}); selected.phase = TaskSessionWritebackPhase.Started; }
      if (selected.phase === TaskSessionWritebackPhase.Started) {
        const receipt = await sessionStore.write(intent).catch(error => { if (!sessionStore.capabilities.supportsIdempotency) throw error; return sessionStore.write(intent); });
        if (receipt.status === "stale_generation") return [{code:"task_session_update_writeback_stale_generation",safeMessage:"Task session update was skipped because a newer session generation already exists."}];
        if (receipt.generationHash !== selected.nextHash) throw new Error("task_session_finalization_changed");
        selected.receipt = receipt; selected.phase = TaskSessionWritebackPhase.Written;
      }
      if (selected.phase === TaskSessionWritebackPhase.Written) {
        const committed = await leaseStore.markWritebackCommitted({leaseId:intent.leaseId!,nextGenerationHash:selected.receipt!.generationHash,idempotencyKey:intent.idempotencyKey});
        if (committed.status === "stale_generation") return [{code:"task_session_update_writeback_stale_generation",safeMessage:"Original session lease has not acknowledged this credential generation."}];
        selected.phase = TaskSessionWritebackPhase.Committed;
        this.emit("session.task_update.writeback.completed",input.runContext.runId,{status:selected.receipt!.status,generation:String(selected.receipt!.generation)});
        this.deps.observability.count("subscription_runtime.task_session_update_writeback_success");
      }
      return [];
    } catch {
      this.emit("session.task_update.writeback.failed",input.runContext.runId,{reason:"task_session_finalization_pending"});
      return [{code:"task_session_update_writeback_failed",safeMessage:"Task session update could not be written back after task execution."}];
    } finally {
      if (!use && selected.phase !== TaskSessionWritebackPhase.Committed && leaseStore.release) {
        try { await leaseStore.release({leaseId:intent.leaseId!,reason:"task_session_update_writeback_not_committed"}); }
        catch { this.emit("lease.release.failed",input.runContext.runId,{leaseId:intent.leaseId!,reason:"task_session_update_writeback_not_committed",error:"unknown"}); }
      }
    }
  }
  private emit(name:string,runId:string,metadata:Readonly<Record<string,string>>):void {
    const event:RuntimeEvent = {name,runId,providerId:this.deps.sessionDriver.providerId,agentId:this.deps.agentDriver.agentId,storeId:this.deps.sessionStore?.storeId ?? "none",metadata};
    this.deps.observability.emit(event);
  }
}
