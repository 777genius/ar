import type {
  CodexAppServerCommandApprovalDecision,
  CodexAppServerCommandApprovalInput,
} from "../domain/app-server-types";
import type { AppServerWarning } from "../domain/app-server-types";

export function tryHandleAppServerApprovalRequest(input: {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown> | null;
  readonly reviewCommand: (
    request: CodexAppServerCommandApprovalInput,
  ) => CodexAppServerCommandApprovalDecision;
  readonly warn: (warning: AppServerWarning) => void;
  readonly respond: (id: number, result: Record<string, unknown>) => void;
  readonly respondError: (id: number, message: string) => void;
}): boolean {
  if (input.method === "item/commandExecution/requestApproval") {
    const commandText = stringField(input.params, "command") ?? undefined;
    const cwd = stringField(input.params, "cwd") ?? undefined;
    const decision = input.reviewCommand({
      source: "command_execution",
      ...(commandText === undefined ? {} : { commandText }),
      ...(cwd === undefined ? {} : { cwd }),
    });
    input.respond(input.id, {
      decision: decision.approved ? "accept" : "decline",
    });
    return true;
  }
  if (input.method === "execCommandApproval") {
    const command = stringArrayField(input.params, "command") ?? undefined;
    const cwd = stringField(input.params, "cwd") ?? undefined;
    const decision = input.reviewCommand({
      source: "legacy_exec",
      ...(command === undefined ? {} : { command }),
      ...(cwd === undefined ? {} : { cwd }),
    });
    input.respond(input.id, {
      decision: decision.approved ? "approved" : "denied",
    });
    return true;
  }
  if (input.method === "item/fileChange/requestApproval") {
    input.warn({
      code: "codex_app_server_file_change_approval_denied",
      safeMessage:
        "Codex app-server requested file change approval; subscription-runtime denies provider-side file grants.",
    });
    input.respond(input.id, { decision: "decline" });
    return true;
  }
  if (input.method === "applyPatchApproval") {
    input.warn({
      code: "codex_app_server_apply_patch_approval_denied",
      safeMessage:
        "Codex app-server requested patch approval; subscription-runtime denies provider-side patch grants.",
    });
    input.respond(input.id, { decision: "denied" });
    return true;
  }
  if (input.method === "item/permissions/requestApproval") {
    input.warn({
      code: "codex_app_server_permission_request_denied",
      safeMessage:
        "Codex app-server requested additional permissions; subscription-runtime denies provider-side permission expansion.",
    });
    input.respondError(input.id, "codex_app_server_permission_request_denied");
    return true;
  }
  return false;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  return typeof record?.[key] === "string" ? record[key] : null;
}

function stringArrayField(
  record: Record<string, unknown> | null,
  key: string,
): readonly string[] | null {
  const value = record?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}
