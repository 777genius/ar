import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { loadJobLaunch } from "./codex-goal-mcp-project-control-deps";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { assertCodexProjectReservedLaunchAuthority, assertCodexProjectReservedAccountReceiptCurrent,
  consumeCodexProjectReservedLaunchAuthority } from "./application/project-control/codex-goal-project-account-reservation";
import { parseResearchOperatorRequest, type ResearchOperatorRequest, type ResearchProjectLaunchBinding } from "./research-launch-contract";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchHash, researchId, researchInvalid, researchPath } from "./research-launch-files";
import { assertResearchDurableDirectory, researchDurableDirectory } from "./research-durable-handoff-directory";
import { researchProjectLaunchInputs } from "./research-project-launch-inputs";
import { assertMimoProjectResearchExecutionSupported, researchRegisteredExecutionFromReservation } from "./research-registered-execution";

/** An original broker reservation, not a parsed binding, grants this single use.
 * Caller holds its existing workspace/activity publication fences. */
export type ResearchProjectLaunchAuthorization = Readonly<{ request: ResearchOperatorRequest; registryRootDir: string }>;
const authorizations = new WeakMap<ResearchProjectLaunchAuthorization, {
  binding: ResearchProjectLaunchBinding; manifest: Awaited<ReturnType<typeof loadJobLaunch>>["manifest"]; reservedLaunch: CodexGoalLaunchInput;
}>();
const digest = (value: unknown): string => researchHash(JSON.stringify(value));
async function currentProjectLaunch(binding: Pick<ResearchProjectLaunchBinding, "registryRootDir" | "controllerJobId" | "registeredExecution">,
  request: ResearchOperatorRequest, preStart = false) {
  return await researchProjectLaunchInputs({ registryRootDir: binding.registryRootDir,
    controllerJobId: binding.controllerJobId, request, preStart,
    ...(binding.registeredExecution ? { execution: binding.registeredExecution } : {}),
    bindSupportedRequest: ({ manifest, launch }, controller) => {
      assertMimoProjectResearchExecutionSupported({ registryRootDir: binding.registryRootDir,
        manifest, controller: controller.controller, launch, request, execution: binding.registeredExecution });
      return request;
    },
  });
}
export async function authorizeResearchProjectLaunch(input: {
  readonly registryRootDir: string; readonly controllerJobId: string;
  readonly request: ResearchOperatorRequest; readonly reservedLaunch: CodexGoalLaunchInput;
}): Promise<ResearchProjectLaunchAuthorization> {
  assertResearchInitialRoot(true);
  const request = parseResearchOperatorRequest(input.request);
  const registryRootDir = researchPath(input.registryRootDir), controllerJobId = researchId(input.controllerJobId);
  const registry = researchDurableDirectory(registryRootDir);
  return await withCodexGoalRegistryMutation({ registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
    assertResearchDurableDirectory(registry);
    const loaded = await loadJobLaunch({ registryRootDir, jobId: request.jobId });
    const reserved = { manifest: loaded.manifest, sourceLaunch: loaded.launch, reservedLaunch: input.reservedLaunch };
    const authority = assertCodexProjectReservedLaunchAuthority(reserved);
    const registeredExecution = researchRegisteredExecutionFromReservation(authority, input.reservedLaunch);
    const current = await currentProjectLaunch({ registryRootDir, controllerJobId, registeredExecution }, request, true);
    // Selection can change while the current receipt/manifest is read. Finish
    // with the live account receipt and the same synchronous owner byte fence.
    await assertCodexProjectReservedAccountReceiptCurrent({ manifest: loaded.manifest, reservedLaunch: input.reservedLaunch });
    assertResearchDurableDirectory(registry);
    current.assertAuthorityBytes();
    consumeCodexProjectReservedLaunchAuthority(reserved);
    const authorization = Object.freeze({ request: current.request, registryRootDir });
    authorizations.set(authorization, { binding: current.binding, manifest: loaded.manifest, reservedLaunch: input.reservedLaunch });
    return authorization;
  } });
}
export async function assertResearchProjectLaunchBindingCurrent(binding: ResearchProjectLaunchBinding,
  request: ResearchOperatorRequest, assertRoot: () => void = assertResearchInitialRoot): Promise<() => void> {
  assertRoot();
  const current = await currentProjectLaunch(binding, request);
  if (digest(current.binding) !== digest(binding)) researchInvalid();
  assertRoot();
  current.assertAuthorityBytes();
  return current.assertAuthorityBytes;
}
export async function consumeResearchProjectLaunchAuthorization(authorization: ResearchProjectLaunchAuthorization): Promise<ResearchProjectLaunchBinding> {
  assertResearchInitialRoot(true);
  const retained = authorizations.get(authorization);
  if (!retained) researchInvalid();
  authorizations.delete(authorization);
  const assertAuthorityBytes = await assertResearchProjectLaunchBindingCurrent(retained.binding, authorization.request);
  await assertCodexProjectReservedAccountReceiptCurrent({ manifest: retained.manifest, reservedLaunch: retained.reservedLaunch });
  assertAuthorityBytes();
  return retained.binding;
}
