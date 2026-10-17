import type { SessionArtifact, RedactorPort, ProviderSessionDriver, SessionExecutionUse } from "@vioxen/subscription-runtime/core";
import type { CodexSessionMaterializer } from "../provider-codex/codex-session-materializer";
import { codexAuthJsonFromArtifact } from "../provider-codex/codex-auth-json-codec";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { prepareCurrentHostedDependencySessionCache, materializeCurrentHostedDependencySession,
  readCurrentHostedDependencyExecutionUseHome, ensureCurrentHostedDependencySessionModel, finishCurrentHostedDependencySessionRefresh, requestStopCurrentHostedDependencySessionRefresh,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
/** Scheduling view only. All home/use/credential provenance lives in original contexts. */
export class HostedManagedDependencySessionMaterializer implements CodexSessionMaterializer {
  readonly mode = "worker-cache" as const;
  readonly #origin:CurrentHostedDependencyOrigin;
  constructor(origin:CurrentHostedDependencyOrigin) {
    this.#origin = origin; prepareCurrentHostedDependencySessionCache(origin); Object.freeze(this);
  }
  async materialize(input:Readonly<{session:SessionArtifact;redactor:RedactorPort;sessionExecutionUse?:SessionExecutionUse}>) {
    return materializeCurrentHostedDependencySession(this.#origin,input);
  }
  async refresh(input:Parameters<ProviderSessionDriver["refreshSession"]>[0]) {
    const materialized = await this.materialize(input);
    const home = readCurrentHostedDependencyExecutionUseHome(this.#origin,materialized.sessionExecutionUse);
    const cancel = () => { try { requestStopCurrentHostedDependencySessionRefresh(home); } catch { /* Unknown owner remains held. */ } };
    try {
      if (input.abortSignal.aborted) throw new Error("hosted_dependency_session_refresh_cancelled");
      await ensureCurrentHostedDependencySessionModel(home);
      if (input.abortSignal.aborted) throw new Error("hosted_dependency_session_refresh_cancelled");
      new HostedReadonlySupervisorHost().startDependencySessionRefresh(home);
      input.abortSignal.addEventListener("abort",cancel,{once:true}); if (input.abortSignal.aborted) cancel();
      await finishCurrentHostedDependencySessionRefresh(home);
      if (input.abortSignal.aborted) throw new Error("hosted_dependency_session_refresh_cancelled");
      const artifact = await materialized.snapshotSession();
      return {artifact,providerState:codexAuthJsonFromArtifact(artifact) === codexAuthJsonFromArtifact(input.session) ? "unchanged" as const : "refreshed" as const,warnings:[]};
    } finally { input.abortSignal.removeEventListener("abort",cancel); await materialized.release(); }
  }
}
Object.freeze(HostedManagedDependencySessionMaterializer); Object.freeze(HostedManagedDependencySessionMaterializer.prototype);
