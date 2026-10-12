import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { defaultStartupTimeoutMs } from "../provider-codex/app-server/domain/app-server-types";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { parseResearchOperatorRequest } from "./research-launch-contract";
import { authorizeResearchProjectLaunch } from "./research-project-launch-authorization";
import { grantProjectResearchLaunch, startProjectResearchLaunch } from "./research-launch-owner";
import { researchJobAuthority } from "./research-launch-admission";
import { researchHash, researchPublish, researchRead } from "./research-launch-files";

/** Prepare under the broker's publication fence; submit only after it releases.
 * The original reservation object is mandatory, never its checkpoint projection. */
export async function prepareProjectResearchLaunch(input: {
  registryRootDir: string; controllerJobId: string; reservedLaunch: CodexGoalLaunchInput;
}): Promise<(() => Promise<Awaited<ReturnType<typeof startProjectResearchLaunch>>>) | undefined> {
  const c = input.reservedLaunch.config;
  if (c.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) return undefined;
  const request = parseResearchOperatorRequest({ schemaVersion: 1,
    jobId: c.jobId, taskId: c.taskId, jobRootDir: c.jobRootDir, workspacePath: c.workspacePath,
    promptPath: c.promptPath, authRootDir: c.authRootDir, accounts: c.accounts.map(account => account.name),
    codexBinaryPath: c.codexBinaryPath, modelBackend: c.modelBackend, model: c.model,
    reasoningEffort: c.reasoningEffort, serviceTier: c.serviceTier, taskTimeoutMs: c.taskTimeoutMs,
    projectId: c.projectAccessScope?.projectId, maxAccountCycles: c.maxAccountCycles,
    prewarmOnStart: c.prewarmOnStart ?? false, appServerStartupTimeoutMs: c.appServerStartupTimeoutMs ?? defaultStartupTimeoutMs,
  });
  const authorization = await authorizeResearchProjectLaunch({ ...input, request });
  let used = false;
  return async () => {
    if (used) throw new Error("project_control_native_launch_already_submitted");
    used = true;
    await grantProjectResearchLaunch(authorization);
    const path = join(researchJobAuthority(request.jobId), `project-request-${randomUUID()}.json`);
    researchPublish(path, authorization.request, true);
    return await startProjectResearchLaunch(path, researchHash(researchRead(path)));
  };
}
