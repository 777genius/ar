import type { CodexReasoningEffort, CodexServiceTier } from "../../codex-json-execution-engine";
import type { CodexAppServerCommandApprovalPolicy, CodexAppServerSandboxPolicy } from "../domain/app-server-types";
import { appServerApprovalPolicy } from "./app-server-approval-policy";

export function appServerTurnStartParams(input: {
  readonly threadId: string;
  readonly prompt: string;
  readonly model: string;
  readonly serviceTier?: CodexServiceTier;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly outputSchema?: unknown;
}, policy: {
  readonly disableTools: boolean;
  readonly disableNativeEnvironments: boolean;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly sandboxPolicy: CodexAppServerSandboxPolicy;
}): Record<string, unknown> {
  const { disableTools, disableNativeEnvironments } = policy;
  return {
    threadId: input.threadId,
    input: [
      {
        type: "text",
        text: input.prompt,
        text_elements: [],
      },
    ],
    responsesapiClientMetadata: null,
    additionalContext: null,
    ...(disableTools || disableNativeEnvironments
      ? { environments: [] }
      : {}),
    cwd: null,
    runtimeWorkspaceRoots: null,
    approvalPolicy: appServerApprovalPolicy(policy.commandApprovalPolicy),
    approvalsReviewer: null,
    sandboxPolicy: policy.sandboxPolicy,
    model: input.model,
    serviceTier: input.serviceTier ?? null,
    effort: input.reasoningEffort,
    summary: "none",
    personality: null,
    outputSchema: input.outputSchema ?? null,
    collaborationMode: null,
  };
}
