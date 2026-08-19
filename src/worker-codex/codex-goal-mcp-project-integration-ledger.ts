import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ProjectIntegrationMcpArgs,
  ProjectIntegrationMcpLoadController,
  ProjectIntegrationMcpToolHandler,
} from "./project-integration-mcp";

export async function projectIntegrationPushApprovedCommitWithConsumedLedger(input: {
  readonly args: unknown;
  readonly loadController: ProjectIntegrationMcpLoadController;
  readonly pushApprovedCommitHandler: ProjectIntegrationMcpToolHandler;
}): Promise<CallToolResult> {
  const controller = await input.loadController(
    input.args as ProjectIntegrationMcpArgs,
  );
  if ((controller.scope.consumedOutputLedgerRoots ?? []).length !== 1) {
    throw new Error("project_integration_consumed_output_ledger_required");
  }
  if ((controller.scope.consumedOutputEvidenceRoots ?? []).length === 0) {
    throw new Error("project_integration_consumed_output_evidence_root_required");
  }
  return await input.pushApprovedCommitHandler(input.args);
}
