import type {
  AppServerWarning,
  CodexAppServerCommandApprovalDecision,
  CodexAppServerCommandApprovalInput,
  CodexAppServerCommandApprovalPolicy,
} from "../domain/app-server-types";
import { safeMessage } from "../domain/app-server-errors";
import { tryHandleAppServerApprovalRequest } from "./app-server-approval-request-handler";

export function handleAppServerServerRequest(input: {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown> | null;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly warn: (warning: AppServerWarning) => void;
  readonly respond: (id: number, result: Record<string, unknown>) => void;
  readonly respondError: (id: number, message: string) => void;
}): void {
  if (tryHandleAppServerApprovalRequest({
    id: input.id,
    method: input.method,
    params: input.params,
    reviewCommand: (request) => reviewCommandApproval(input, request),
    warn: input.warn,
    respond: input.respond,
    respondError: input.respondError,
  })) return;
  input.warn({
    code: "codex_app_server_unsupported_request",
    safeMessage: "Codex app-server requested an unsupported client method.",
  });
  input.respondError(input.id, `unsupported_server_request:${input.method}`);
}

function reviewCommandApproval(
  input: Parameters<typeof handleAppServerServerRequest>[0],
  request: CodexAppServerCommandApprovalInput,
): CodexAppServerCommandApprovalDecision {
  const decision = input.commandApprovalPolicy?.reviewCommand(request) ?? {
    approved: false,
    reason: "approval_policy_not_configured",
  };
  if (!decision.approved) {
    input.warn({
      code: "codex_app_server_command_approval_denied",
      safeMessage: `Codex app-server command approval denied: ${safeMessage(decision.reason ?? "unknown")}`,
    });
  }
  return decision;
}
