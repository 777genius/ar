import type { CodexAppServerCommandApprovalPolicy } from "../domain/app-server-types";

export function appServerApprovalPolicy(
  policy: CodexAppServerCommandApprovalPolicy | undefined,
): unknown {
  if (policy === undefined) return "never";
  return {
    granular: {
      mcp_elicitations: false,
      request_permissions: false,
      rules: true,
      sandbox_approval: true,
      skill_approval: false,
    },
  };
}
