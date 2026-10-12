import type { ResolvedProjectSourceRevision } from "./application/project-control/codex-goal-project-source-revision";
import type {
  ProjectAccessScope,
  ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type {
  CodexProjectControlBrokerInput,
} from "./codex-goal-mcp-project-broker";

export type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export type CodexGoalMcpProjectControlJobsDeps = {
  readonly sealedSource?: ProjectSealedSourcePort;
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly codexProjectControlBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
};

/** A Host-provided seal validator, never caller-supplied launch arguments. */
export interface ProjectSealedSourcePort {
  resolveRevision(input: Readonly<{
    sourceWorkspacePath: string; sourceRef: string; expectedSourceCommit: string;
  }>): Promise<ResolvedProjectSourceRevision>;
}
