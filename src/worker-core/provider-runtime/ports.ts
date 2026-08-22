import type { RunEventProviderKind } from "../run-provider-kind";
import type {
  RunObservationPort,
  RunObservationSnapshot,
} from "../run-observability";
import type { ControlledAgentProviderPort } from "../controlled-agent";
import type { ControlledAgentProviderEnforcementCapabilities } from "../controlled-agent";
import type { ProjectAccessScope } from "../access-control";

type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Provider-neutral enforcement capabilities the controlled-agent launch plan
 * reasons over. Re-exported under a neutral name so port consumers do not need
 * to spell out the controlled-agent domain type.
 */
export type ProviderEnforcementCapabilities =
  ControlledAgentProviderEnforcementCapabilities;

/**
 * A controlled-agent controller profile expressed without provider branching.
 *
 * Replaces the discriminated `CodexControlledAgentProfile |
 * ClaudeControlledAgentProfile` union that the goal-mcp project-control code
 * used to switch on. `rawProfile` keeps the concrete provider profile available
 * to the provider factory adapter that produced it; callers outside the owning
 * adapter must treat it as opaque.
 */
export interface ProviderControllerProfile {
  readonly kind: RunEventProviderKind;
  readonly enforcement: ProviderEnforcementCapabilities;
  allowedTools(): readonly string[];
  /** Full controlled-agent session id for a controller job (job id + suffix). */
  sessionId(controllerJobId: string): string;
  readyJson(): JsonObject;
  /** Opaque concrete provider profile; only the owning adapter may narrow it. */
  readonly rawProfile: unknown;
}

/** Neutral inputs shared by every provider controller-profile builder. */
export interface ProviderControllerProfileInput {
  readonly stateDir: string;
  readonly mcpServerName?: string;
  readonly mcpCommand?: string;
  readonly mcpArgs?: readonly string[];
  readonly mcpCwd?: string;
  readonly rawShellMode?: "disabled-by-provider" | "sandboxed-deny-rules-only";
}

/**
 * Neutral inputs for constructing a controlled-agent provider. Provider-specific
 * material (codex binary path, claude session artifact path, accounts, ...) is
 * carried in the opaque `launch`/`controllerOptions` payloads and extracted by
 * the adapter that understands them.
 */
export interface ProviderControlledAgentInput {
  readonly profile: ProviderControllerProfile;
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
  // Lazy objective factory. Adapters must invoke it only after their own
  // fail-closed credential/scope validations pass, so a missing account or
  // session artifact is reported before the objective prompt is read.
  readonly controllerObjective: () => Promise<string>;
  readonly cwd: string;
  /** Opaque goal launch payload; the adapter narrows it to its launch type. */
  readonly launch: unknown;
  /** Opaque controller options; the adapter narrows it to its option type. */
  readonly controllerOptions: unknown;
}

export interface ProviderControlledAgentResult {
  readonly provider: ControlledAgentProviderPort;
  readonly account?: JsonObject;
  readonly sessionArtifact?: JsonObject;
  readonly safeMessage: string;
}

/** Neutral inputs for building a run-observation adapter for one watch call. */
export interface ProviderRunObservationInput {
  readonly registryRootDir: string;
  readonly stateRootDir?: string;
  readonly runArtifactsRootDir?: string;
  readonly cwd?: string;
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
  readonly includeLogTail: boolean;
}

export interface ProviderFailedRunObservationInput {
  readonly runId: string;
  readonly error: unknown;
}

/**
 * A run-observation port plus the provider-specific extras the shared watch
 * flow needs: the response locator fields (e.g. `registryRootDir`) and an
 * optional fallback for runs that fail normal observation (e.g. codex orphan
 * artifact runs).
 */
export interface ProviderRunObservation extends RunObservationPort {
  readonly responseLocator: JsonObject;
  observeFailedRun?(
    input: ProviderFailedRunObservationInput,
  ): Promise<RunObservationSnapshot>;
}

/**
 * A single provider's ability to take part in goal orchestration. Slice 1
 * covers exactly the three existing branching sites; further capabilities
 * (account reservation, prewarm) arrive in later slices.
 */
export interface ProviderRuntimeAdapter {
  readonly kind: RunEventProviderKind;
  observation(input: ProviderRunObservationInput): ProviderRunObservation;
  controllerProfile(
    input: ProviderControllerProfileInput,
  ): ProviderControllerProfile;
  controlledAgentProvider(
    input: ProviderControlledAgentInput,
  ): Promise<ProviderControlledAgentResult>;
}

export interface ProviderRuntimeRegistry {
  /** Returns the adapter for `kind` or throws {@link ProviderRuntimeUnsupportedError}. */
  get(kind: RunEventProviderKind): ProviderRuntimeAdapter;
  supported(): readonly RunEventProviderKind[];
}

export class ProviderRuntimeUnsupportedError extends Error {
  readonly kind: RunEventProviderKind;
  readonly supported: readonly RunEventProviderKind[];

  constructor(
    kind: RunEventProviderKind,
    supported: readonly RunEventProviderKind[],
  ) {
    super(`provider_runtime_unsupported:${kind}`);
    this.name = "ProviderRuntimeUnsupportedError";
    this.kind = kind;
    this.supported = supported;
  }
}
