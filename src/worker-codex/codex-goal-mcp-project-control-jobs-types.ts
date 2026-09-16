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
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly codexProjectControlBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
};
