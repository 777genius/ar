import {
  ProjectAuthorityMode,
  type AdoptProjectAuthorityTupleInput,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexProjectControlBrokerInput } from
  "./codex-goal-mcp-project-broker";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { requiredRawString } from "./codex-goal-mcp-values";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";

type JsonObject = Readonly<Record<string, unknown>>;
type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};


export type CodexGoalMcpProjectAuthorityDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly codexProjectControlBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
};

export async function projectControlAdoptAuthorityTupleView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectAuthorityDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const input: AdoptProjectAuthorityTupleInput = {
    packetRevision: requiredRawString(args.packetRevision, "packetRevision"),
    baseSha: requiredRawString(args.baseSha, "baseSha"),
    phaseStartSha: requiredRawString(args.phaseStartSha, "phaseStartSha"),
    inputPatchHash: requiredRawString(args.inputPatchHash, "inputPatchHash"),
    reviewReceipt: requiredRawString(args.reviewReceipt, "reviewReceipt"),
    reviewReceiptSha256: requiredRawString(
      args.reviewReceiptSha256,
      "reviewReceiptSha256",
    ),
  };
  if (args.confirmAuthorityAdoption !== true) {
    return {
      ok: false,
      reason: "confirm_authority_adoption_required",
      controllerJobId: controller.controller.jobId,
      projectId: controller.scope.projectId,
      tuple: {
        packetRevision: input.packetRevision,
        baseSha: input.baseSha,
        phaseStartSha: input.phaseStartSha,
        inputPatchHash: input.inputPatchHash,
        reviewReceiptSha256: input.reviewReceiptSha256,
      },
    };
  }
  if (controller.scope.preStartAdmission?.authorityMode !==
      ProjectAuthorityMode.HostedWebCoreV1) {
    throw new Error("project_authority_explicit_mode_required");
  }
  const broker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
  });
  const result = await broker.adoptAuthorityTuple(input);
  return {
    ok: true,
    mode: "project_control_adopt_authority_tuple",
    controllerJobId: controller.controller.jobId,
    projectId: controller.scope.projectId,
    result: result as unknown as JsonObject,
  };
}
