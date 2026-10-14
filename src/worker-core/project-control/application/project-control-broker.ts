import {
  AccessDecisionReason,
  ProjectAuthorityMode,
  ProjectToolCapability,
  ProjectOperation,
  createAccessPolicyService,
  type AccessPolicyContext,
  type AccessPolicyService,
  type PolicyDecision,
  type ProjectGitAccessRequest,
  type ProjectJobAccessRequest,
  type ProjectWorktreeAccessRequest,
} from "../../access-control";
import {
  ProjectAdmissionDecisionReason,
  ProjectAdmissionDecisionStatus,
  normalizeProjectAdmissionWorkerRole,
  type ProjectAdmissionDecision,
  type ProjectAdmissionGate,
  type ProjectAdmissionSummary,
  type ProjectAdmissionWorkerRole,
} from "../domain/project-admission";
import {
  adoptProjectAuthorityTuple,
  type AdoptProjectAuthorityTupleInput,
} from "./adopt-project-authority-tuple";
import type { ProjectAuthorityTupleStorePort } from
  "../ports/project-authority-tuple-store-port";

export enum ProjectControlAuditEventType {
  DecisionRecorded = "project_control.decision_recorded",
  AdmissionDecisionRecorded = "project_control.admission_decision_recorded",
}

export type ProjectControlOperationResult = {
  readonly status: "applied" | "noop";
  readonly safeMessage?: string;
  readonly admission?: ProjectAdmissionSummary;
  readonly resourceId?: string;
  readonly evidence?: Readonly<Record<string, string>>;
};

export type ProjectControlCreateJobInput = ProjectJobAccessRequest & {
  readonly promptPath?: string;
  readonly accounts?: readonly string[];
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
  readonly ownedPaths?: readonly string[];
};

export type ProjectControlWriteReviewMarkerInput = ProjectJobAccessRequest & {
  readonly markerType: "review" | "stop" | "maintenance_pause" | "handoff";
  readonly note?: string;
};

export type ProjectControlAdmissionMetadata = {
  readonly jobId?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
  readonly ownedPaths?: readonly string[];
};

export type ProjectControlCreateWorktreeInput =
  ProjectWorktreeAccessRequest & ProjectControlAdmissionMetadata;

export type ProjectResolvedWorktreeSource = {
  readonly revision: string;
  readonly sourceRealPath: string;
};

export type ProjectControlStartWorkerInput =
  ProjectJobAccessRequest & ProjectControlAdmissionMetadata & {
    readonly accounts?: readonly string[];
  };

export type ProjectControlPolicyBrokerEvent = {
  readonly schemaVersion: 1;
  readonly type: ProjectControlAuditEventType.DecisionRecorded;
  readonly occurredAt: string;
  readonly operation: ProjectOperation;
  readonly decision: PolicyDecision;
};

export type ProjectControlAdmissionBrokerEvent = {
  readonly schemaVersion: 1;
  readonly type: ProjectControlAuditEventType.AdmissionDecisionRecorded;
  readonly occurredAt: string;
  readonly operation: ProjectOperation;
  readonly decision: ProjectAdmissionDecision;
};

export type ProjectControlBrokerEvent =
  | ProjectControlPolicyBrokerEvent
  | ProjectControlAdmissionBrokerEvent;

export interface ProjectControlAuditPort {
  record(event: ProjectControlBrokerEvent): Promise<void> | void;
}

export interface ProjectJobRegistryPort {
  createJob(input: ProjectControlCreateJobInput): Promise<ProjectControlOperationResult>;
  writeReviewMarker(
    input: ProjectControlWriteReviewMarkerInput,
  ): Promise<ProjectControlOperationResult>;
}

export interface ProjectWorkerSupervisorPort {
  /**
   * Publishes the durable launch claim under the short admission coordination
   * section. The actual provider submission remains outside that section.
   */
  prepareStartWorker?(
    input: ProjectControlStartWorkerInput,
  ): Promise<void>;
  startWorker(input: ProjectControlStartWorkerInput): Promise<ProjectControlOperationResult>;
  stopWorker(input: ProjectJobAccessRequest): Promise<ProjectControlOperationResult>;
}

export interface ProjectWorkspacePort {
  resolveRevision?(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectResolvedWorktreeSource>;
  createWorktree(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectControlOperationResult>;
}

export interface ProjectGitPort {
  integrateCommit(input: ProjectGitAccessRequest): Promise<ProjectControlOperationResult>;
  pushBranch(input: ProjectGitAccessRequest): Promise<ProjectControlOperationResult>;
}

export type ProjectControlAdmissionCoordination = {
  withPublication<T>(
    input: {
      readonly operation: ProjectOperation;
      readonly request: ProjectControlAdmissionMetadata & {
        readonly jobId?: string;
        readonly workspacePath?: string;
      };
    },
    effect: () => Promise<T>,
  ): Promise<T>;
};

export type ProjectControlBrokerPorts = {
  readonly registry: ProjectJobRegistryPort;
  readonly supervisor: ProjectWorkerSupervisorPort;
  readonly workspace: ProjectWorkspacePort;
  readonly git: ProjectGitPort;
  readonly authority: ProjectAuthorityTupleStorePort;
  readonly admission?: ProjectAdmissionGate;
  readonly admissionCoordination?: ProjectControlAdmissionCoordination;
  readonly audit?: ProjectControlAuditPort;
  readonly clock?: { now(): Date };
};

export class ProjectControlDeniedError extends Error {
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super(`project_control_denied:${decision.reason}`);
    this.name = "ProjectControlDeniedError";
    this.decision = decision;
  }
}

export class ProjectControlAdmissionDeniedError extends Error {
  readonly decision: ProjectAdmissionDecision;

  constructor(decision: ProjectAdmissionDecision) {
    super(`project_control_admission_denied:${decision.reason}`);
    this.name = "ProjectControlAdmissionDeniedError";
    this.decision = decision;
  }
}

/** A provider effect may exist; callers must retain capacity and launch claims. */
export class ProjectControlSubmissionUncertainError extends Error {
  constructor(cause: unknown) {
    super("project_control_submission_outcome_unknown", { cause });
    this.name = "ProjectControlSubmissionUncertainError";
  }
}

export class ProjectControlBroker {
  private readonly policy: AccessPolicyService;
  private readonly clock: { now(): Date };
  private readonly authorityMode: ProjectAuthorityMode | undefined;

  constructor(
    context: AccessPolicyContext | AccessPolicyService,
    private readonly ports: ProjectControlBrokerPorts,
  ) {
    this.authorityMode = isPolicyService(context)
      ? undefined
      : context.scope?.preStartAdmission?.authorityMode;
    this.policy = isPolicyService(context)
      ? context
      : createAccessPolicyService(context);
    this.clock = ports.clock ?? { now: () => new Date() };
  }

  async createJob(
    input: ProjectControlCreateJobInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canCreateJob(input));
    for (const accountId of input.accounts ?? []) {
      await this.authorize(this.policy.canUseAccount({ accountId }));
    }
    const gate = await this.prepareAdmission(ProjectOperation.CreateJob, input);
    return this.withAdmissionPublication(
      ProjectOperation.CreateJob,
      input,
      async () => {
        const decision = await this.admit(ProjectOperation.CreateJob, input, gate);
        return this.withAdmissionSummary(await this.ports.registry.createJob(input), decision);
      },
    );
  }

  async startWorker(
    input: ProjectControlStartWorkerInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canStartWorker(input));
    for (const accountId of input.accounts ?? []) {
      await this.authorize(this.policy.canUseAccount({ accountId }));
    }
    const gate = await this.prepareAdmission(ProjectOperation.StartWorker, input);
    if (this.ports.supervisor.prepareStartWorker) {
      let decision: ProjectAdmissionDecision | undefined;
      await this.withAdmissionPublication(
        ProjectOperation.StartWorker,
        input,
        async () => {
          decision = await this.admit(ProjectOperation.StartWorker, input, gate);
          await this.ports.supervisor.prepareStartWorker!(input);
        },
      );
      // Only the provider adapter knows whether submission happened. A thrown
      // timeout must not erase a published claim and permit a duplicate launch.
      return this.withAdmissionSummary(await this.ports.supervisor.startWorker(input), decision);
    }
    if (this.ports.admissionCoordination) {
      throw new Error("project_control_launch_publication_required");
    }
    const decision = await this.admit(ProjectOperation.StartWorker, input, gate);
    return this.withAdmissionSummary(await this.ports.supervisor.startWorker(input), decision);
  }

  async stopWorker(
    input: ProjectJobAccessRequest,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canStopWorker(input));
    return this.ports.supervisor.stopWorker(input);
  }

  async createWorktree(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canCreateWorktree(input));
    const admissionInput = {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      workspacePath: input.path,
      ...(input.workerRole ? { workerRole: input.workerRole } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.ownedPaths ? { ownedPaths: input.ownedPaths } : {}),
    };
    const gate = await this.prepareAdmission(ProjectOperation.CreateWorktree, admissionInput);
    return this.withAdmissionPublication(
      ProjectOperation.CreateWorktree,
      admissionInput,
      async () => {
        const decision = await this.admit(ProjectOperation.CreateWorktree, admissionInput, gate);
        return this.withAdmissionSummary(await this.ports.workspace.createWorktree(input), decision);
      },
    );
  }

  async resolveWorktreeRevision(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectResolvedWorktreeSource> {
    await this.authorize(this.policy.canCreateWorktree(input));
    if (!this.ports.workspace.resolveRevision) {
      throw new Error("project_control_worktree_revision_resolver_unavailable");
    }
    return this.ports.workspace.resolveRevision(input);
  }

  async writeReviewMarker(
    input: ProjectControlWriteReviewMarkerInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canWriteReviewMarker(input));
    return this.ports.registry.writeReviewMarker(input);
  }

  async integrateCommit(
    input: ProjectGitAccessRequest,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canIntegrateCommit(input));
    return this.ports.git.integrateCommit(input);
  }

  async pushBranch(
    input: ProjectGitAccessRequest,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canPushBranch(input));
    return this.ports.git.pushBranch(input);
  }

  async adoptAuthorityTuple(
    input: AdoptProjectAuthorityTupleInput,
  ): Promise<ProjectControlOperationResult> {
    if (this.authorityMode !== ProjectAuthorityMode.HostedWebCoreV1) {
      throw new Error("project_authority_explicit_mode_required");
    }
    await this.authorize(this.policy.canUseTool({
      tool: ProjectToolCapability.ProjectControlBroker,
    }));
    const status = await adoptProjectAuthorityTuple(this.ports.authority, input);
    return { status };
  }

  private withAdmissionSummary(
    result: ProjectControlOperationResult,
    decision: ProjectAdmissionDecision | undefined,
  ): ProjectControlOperationResult {
    return decision?.summary ? { ...result, admission: decision.summary } : result;
  }

  private async withAdmissionPublication<T>(
    operation: ProjectOperation,
    request: ProjectControlAdmissionMetadata & {
      readonly jobId?: string;
      readonly workspacePath?: string;
    },
    effect: () => Promise<T>,
  ): Promise<T> {
    if (!this.ports.admissionCoordination) return await effect();
    return await this.ports.admissionCoordination.withPublication(
      { operation, request },
      effect,
    );
  }

  private async authorize(decision: PolicyDecision): Promise<void> {
    await this.ports.audit?.record({
      schemaVersion: 1,
      type: ProjectControlAuditEventType.DecisionRecorded,
      occurredAt: this.clock.now().toISOString(),
      operation: decision.operation,
      decision,
    });
    if (!decision.allowed) throw new ProjectControlDeniedError(decision);
  }

  private async prepareAdmission(
    operation: ProjectOperation.CreateJob | ProjectOperation.StartWorker | ProjectOperation.CreateWorktree,
    input: ProjectControlAdmissionMetadata & {
      readonly jobId?: string;
      readonly workspacePath?: string;
    },
  ): Promise<ProjectAdmissionGate | undefined> {
    const gate = this.ports.admission;
    return gate?.prepare ? await gate.prepare({
      operation,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.workerRole ? { workerRole: input.workerRole } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.ownedPaths ? { ownedPaths: input.ownedPaths } : {}),
    }) : gate;
  }

  private async admit(
    operation: ProjectOperation.CreateJob | ProjectOperation.StartWorker | ProjectOperation.CreateWorktree,
    input: ProjectControlAdmissionMetadata & {
      readonly jobId?: string;
      readonly workspacePath?: string;
    },
    gate: ProjectAdmissionGate | undefined,
  ): Promise<ProjectAdmissionDecision> {
    const request = {
      operation,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.workerRole ? { workerRole: input.workerRole } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.ownedPaths ? { ownedPaths: input.ownedPaths } : {}),
    };
    const decision = gate
      ? await gate.evaluate(request)
      : missingAdmissionDecision(request);
    await this.ports.audit?.record({
      schemaVersion: 1,
      type: ProjectControlAuditEventType.AdmissionDecisionRecorded,
      occurredAt: this.clock.now().toISOString(),
      operation,
      decision,
    });
    if (!decision.allowed) {
      throw new ProjectControlAdmissionDeniedError(decision);
    }
    return decision;
  }
}

export function projectControlDeniedReason(error: unknown): AccessDecisionReason | null {
  return error instanceof ProjectControlDeniedError
    ? error.decision.reason
    : null;
}

export function projectControlAdmissionDeniedReason(
  error: unknown,
): ProjectAdmissionDecisionReason | null {
  return error instanceof ProjectControlAdmissionDeniedError
    ? error.decision.reason
    : null;
}

function missingAdmissionDecision(input: {
  readonly operation: ProjectOperation;
  readonly jobId?: string;
  readonly workspacePath?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
  readonly ownedPaths?: readonly string[];
}): ProjectAdmissionDecision {
  return {
    operation: input.operation,
    workerRole: normalizeProjectAdmissionWorkerRole(input.workerRole, input.tags),
    status: ProjectAdmissionDecisionStatus.Denied,
    allowed: false,
    reason: ProjectAdmissionDecisionReason.SnapshotUnavailable,
    evidence: ["project admission gate is not configured"],
    debt: [],
  };
}

function isPolicyService(value: unknown): value is AccessPolicyService {
  return Boolean(
    value &&
      typeof value === "object" &&
      "canCreateJob" in value &&
      "canStartWorker" in value &&
      "canPushBranch" in value,
  );
}
