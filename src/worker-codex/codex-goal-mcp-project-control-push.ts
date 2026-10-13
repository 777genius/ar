import type { CodexGoalMcpProjectControlActionsDeps } from "./codex-goal-mcp-project-control-actions";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { projectControlAuditPath, type CodexGoalProjectPushBranchInput } from "./codex-goal-mcp-project-broker";
import { projectControlPathArg, projectControlRealPathOutsideWorkspaceScope } from "./codex-goal-mcp-project-scope";
import { assertSafeGitRefName, assertSafeGitRemoteName } from "./codex-goal-mcp-project-git";
import { resolveProjectExternalRewriteRecovery } from "./application/project-control/codex-goal-project-external-rewrite-recovery";
import { booleanValue, requiredRawString, stringValue } from "./codex-goal-mcp-values";

type JsonObject = Readonly<Record<string, unknown>>;

export async function projectControlPushBranchView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const workspacePath = projectControlPathArg(
    args,
    args.workspacePath,
    "workspacePath",
  );
  const branch = requiredRawString(args.branch, "branch");
  const remote = stringValue(args.remote) ?? "origin";
  const force = booleanValue(args.force) ?? false;
  const expectedRemoteCommit = stringValue(args.expectedRemoteCommit);
  const expectedLocalCommit = stringValue(args.expectedLocalCommit);
  const confirmExternalRewriteRecovery =
    booleanValue(args.confirmExternalRewriteRecovery) ?? false;
  assertSafeGitRefName(branch, "branch");
  assertSafeGitRemoteName(remote, "remote");
  const recovery = resolveProjectExternalRewriteRecovery({
    force,
    expectedRemoteCommit,
    expectedLocalCommit,
    confirmExternalRewriteRecovery,
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    workspacePath,
    controller.scope,
  );
  const pushBranchInput: CodexGoalProjectPushBranchInput = {
    workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    branch,
    remote,
    force,
    ...(expectedRemoteCommit ? { expectedRemoteCommit } : {}),
    ...(expectedLocalCommit ? { expectedLocalCommit } : {}),
    ...(confirmExternalRewriteRecovery
      ? { confirmExternalRewriteRecovery: true }
      : {}),
  };
  if (!args.confirmPush) {
    return {
      ok: false,
      reason: "confirm_push_required",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      commandPreview: [
        "git",
        "-C",
        workspacePath,
        "push",
        ...(recovery
          ? [
              `--force-with-lease=refs/heads/${branch}:${recovery.expectedRemoteCommit}`,
            ]
          : force
            ? ["--force-with-lease"]
            : []),
        remote,
        `HEAD:refs/heads/${branch}`,
      ],
    };
  }

  const broker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    pushBranchInput,
  });
  const result = await broker.pushBranch(pushBranchInput);
  return {
    ok: true,
    mode: "project_control_push_branch",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    result: result as unknown as JsonObject,
  };
}
