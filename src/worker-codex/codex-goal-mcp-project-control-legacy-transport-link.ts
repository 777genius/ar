import {
  acquireLocalControllerMaintenanceFence,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import { mcpJson } from "./codex-goal-mcp-response";
import { loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { readCodexGoalConsumedOutputLedgers } from
  "./application/project-control/codex-goal-consumed-output-ledger-io";
import { linkLegacyIntegrationTransport } from
  "./application/project-control/codex-goal-legacy-integration-transport-link";

export type LegacyTransportLinkMcpArgs = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
  readonly controllerJobId: string;
  readonly oldAttemptId: string;
  readonly expectedOldAttemptSha256: string;
  readonly adoptedAttemptId: string;
  readonly expectedAdoptedAttemptSha256: string;
  readonly commitSha: string;
  readonly confirmLink?: boolean;
};

export async function projectControlLinkLegacyIntegrationTransport(
  args: LegacyTransportLinkMcpArgs,
) {
  const controller = await loadProjectControlController(args);
  if (!args.confirmLink) {
    return mcpJson({ ok: false, reason: "confirm_link_required",
      mode: "project_link_legacy_integration_transport" });
  }
  if (process.geteuid?.() !== 0) {
    throw new Error("legacy_integration_transport_link_root_required");
  }
  if (controller.scope.consumedOutputLedgerRoots?.length !== 1 ||
      !controller.scope.consumedOutputEvidenceRoots?.length) {
    throw new Error("legacy_integration_transport_link_ledger_scope_required");
  }
  const fence = await acquireLocalControllerMaintenanceFence({
    controllerJobRootDir: controller.controller.jobRootDir,
    owner: `legacy-integration-transport-link:${args.oldAttemptId}`,
  });
  try {
    const ledger = await readCodexGoalConsumedOutputLedgers({
      roots: controller.scope.consumedOutputLedgerRoots,
      evidenceRoots: controller.scope.consumedOutputEvidenceRoots,
    });
    const linked = await linkLegacyIntegrationTransport({
      controllerJobRootDir: controller.controller.jobRootDir,
      controllerJobId: controller.controller.jobId,
      projectId: controller.scope.projectId,
      oldAttemptId: args.oldAttemptId,
      expectedOldAttemptSha256: args.expectedOldAttemptSha256,
      adoptedAttemptId: args.adoptedAttemptId,
      expectedAdoptedAttemptSha256: args.expectedAdoptedAttemptSha256,
      commitSha: args.commitSha,
      ledger,
    });
    return mcpJson({ ok: true, mode: "project_link_legacy_integration_transport",
      receiptPath: linked.path, receipt: linked.receipt,
      oldAttemptStatusUnchanged: "checks_passed", ledgerMutation: false });
  } finally {
    await releaseLocalControllerMaintenanceFence(fence);
  }
}
