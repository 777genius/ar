import { assertResearchWritableInputsSafe } from "./research-provider-root";
import { recordRawGoalStateOrigin } from "./application/project-control/codex-goal-controller-state-location";
import { trustedResearchRuntimeLaunch } from "./trusted-custody-systemd-launch";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertResearchMimoProfileMatch, parseResearchGrant, parseResearchOperatorRequest, researchHashRequest, type ResearchProjectLaunchBinding, type ResearchRegisteredHandoff, type ResearchStartSpec } from "./research-launch-contract";
import { assertResearchProjectGrantNotRevoked, installedResearchRuntimeDirectory, researchCurrentStart, researchJobAuthority } from "./research-launch-admission";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand, researchExecutableDigest } from "./research-launch-host";
import { assertResearchDirectory, researchArtifactDigest, researchAuthorityRoot, researchDirectoryIdentity,
  researchHash, researchId, researchInvalid, researchJson, researchPath, researchPrivateDirectory, researchPublish, researchRead, researchCustody, researchPromptBytes } from "./research-launch-files";
import { CodexProviderEgressProfileId, CodexModelBackend, HostedMimoProfile } from "@vioxen/subscription-runtime/provider-codex";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { terminalResearchStart } from "./research-launch-lifecycle";
import { annotateResearchLaunchStage, ResearchLaunchStage } from "./research-launch-diagnostics";
import { assertRegisteredResearchHandoffCurrent, consumeRegisteredResearchHandoffAuthorization, type RegisteredResearchHandoffAuthorization } from "./research-registered-handoff";
import { assertResearchDurableDirectory, researchDurableDirectory, sameResearchDurableBacking } from "./research-durable-handoff-directory";
import { withResearchJobMutation, withResearchJobMutationAsync } from "./research-job-mutation-lock";
import { assertResearchProjectLaunchBindingCurrent, consumeResearchProjectLaunchAuthorization, type ResearchProjectLaunchAuthorization } from "./research-project-launch-authorization";

/** Initial-host-root only. The request is closed operator data, never a worker
 * environment, managed/TEST grant, project tag or pre-start observation. */
export function grantResearchLaunch(jobId: string, jobRootDir: string, workspacePath: string): void {
  withResearchJobMutation(jobId, () => publishResearchGrant(jobId, jobRootDir, workspacePath), true);
}
/** Explicit standalone worker authority. Never grants controller or registered execution. */
export function grantOwnedMimoWorkerLaunch(jobId: string, jobRootDir: string, workspacePath: string): void {
  withResearchJobMutation(jobId, () => publishResearchGrant(jobId, jobRootDir, workspacePath, undefined, HostedMimoProfile.Worker), true);
}
/** Separate capability-only port; the legacy operator CLI has no free sink arg. */
export async function grantRegisteredResearchLaunch(authorization: RegisteredResearchHandoffAuthorization): Promise<void> {
  const registryRootDir = researchPath(authorization.registryRootDir), registry = researchDurableDirectory(registryRootDir);
  await withResearchJobMutationAsync(authorization.request.jobId, async () => {
    await withCodexGoalRegistryMutation({ registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
      assertResearchDurableDirectory(registry);
      await consumeRegisteredResearchHandoffAuthorization(authorization, (binding, assertAuthorityBytes) => {
        if (binding.registryRootDir !== registryRootDir) researchInvalid();
        const { request } = authorization;
        publishResearchGrant(request.jobId, request.jobRootDir, request.workspacePath, binding,
          request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan ? request.hostedProfile ?? HostedMimoProfile.Worker : undefined,
          undefined, assertAuthorityBytes);
      });
    } });
  }, true);
}
/** Native project authority comes only from the original broker reservation.
 * Consume after both publication mutex waits; no awaited work follows it. */
export async function grantProjectResearchLaunch(authorization: ResearchProjectLaunchAuthorization): Promise<void> {
  assertResearchInitialRoot(true);
  const registryRootDir = researchPath(authorization.registryRootDir), registry = researchDurableDirectory(registryRootDir);
  await withResearchJobMutationAsync(authorization.request.jobId, async () => {
    await withCodexGoalRegistryMutation({ registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
      assertResearchDurableDirectory(registry);
      const binding = await consumeResearchProjectLaunchAuthorization(authorization);
      if (binding.registryRootDir !== registryRootDir) researchInvalid();
      const { request } = authorization;
      publishResearchGrant(request.jobId, request.jobRootDir, request.workspacePath, undefined, HostedMimoProfile.Worker, binding);
    } });
  }, true);
}
function publishResearchGrant(jobId: string, jobRootDir: string, workspacePath: string, registeredHandoff?: ResearchRegisteredHandoff,
  mimoProfile?: HostedMimoProfile.Worker | HostedMimoProfile.CodingV1, projectLaunchBinding?: ResearchProjectLaunchBinding,
  assertAuthorityBytes: () => void = () => {}): void {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  researchId(jobId);
  const jobDirectory = researchDirectoryIdentity(jobRootDir), workspaceDirectory = researchDirectoryIdentity(workspacePath);
  if (jobRootDir === workspacePath || jobRootDir.startsWith(workspacePath + "/")) researchInvalid();
  assertResearchWritableInputsSafe(jobRootDir, workspacePath);
  assertResearchDirectory(jobDirectory); assertResearchDirectory(workspaceDirectory);
  // Per-root arbitration also covers a different jobId targeting this root.
  assertAuthorityBytes(); recordRawGoalStateOrigin(jobRootDir);
  assertAuthorityBytes();
  researchPrivateDirectory(researchAuthorityRoot);
  assertAuthorityBytes();
  const job = researchJobAuthority(jobId); researchPrivateDirectory(job);
  if (existsSync(join(job, "active.json"))) researchInvalid();
  if (existsSync(join(job, "grant.json"))) {
    const previous = parseResearchGrant(researchJson(researchRead(join(job, "grant.json"))));
    if ((!registeredHandoff && previous.registeredHandoff) ||
        (previous.projectLaunchBinding && (!projectLaunchBinding || previous.projectLaunchBinding.receiptSha256 === projectLaunchBinding.receiptSha256))) researchInvalid();
  }
  // A unique grant identity makes revoke/regrant different even for the same tuple.
  assertAuthorityBytes();
  researchPublish(join(job, "grant.json"), { schemaVersion: 1, jobId, jobRootDir, workspacePath,
    ...(registeredHandoff ? { registeredHandoff } : {}),
    ...(projectLaunchBinding ? { projectLaunchBinding } : {}),
    profileId: mimoProfile ? CodexProviderEgressProfileId.MimoTokenPlan : CodexProviderEgressProfileId.FullInternetV1,
    ...(mimoProfile ? { hostedProfile: mimoProfile } : {}), grantId: randomUUID(), jobDirectory, workspaceDirectory });
}
export function revokeResearchLaunch(jobId: string): void {
  withResearchJobMutation(jobId, () => revokeResearchLaunchUnlocked(jobId));
}
/** Idempotent enrolled standalone revocation cannot revoke a replacement grant. */
export function revokeEnrolledResearchLaunch(jobId: string, expectedGrantSha256: string): void {
  withResearchJobMutation(jobId, () => {
    assertResearchInitialRoot(true);
    if (!/^[a-f0-9]{64}$/.test(expectedGrantSha256)) researchInvalid();
    const path = join(researchJobAuthority(jobId), "grant.json");
    if (!existsSync(path)) return;
    const bytes = researchRead(path), grant = parseResearchGrant(researchJson(bytes));
    if (grant.registeredHandoff || grant.projectLaunchBinding || researchHash(bytes) !== expectedGrantSha256) researchInvalid();
    unlinkSync(path); // Retain active ownership for verified cancellation.
  });
}
function revokeResearchLaunchUnlocked(jobId: string): void {
  assertResearchInitialRoot(true);
  const path = join(researchJobAuthority(jobId), "grant.json");
  const grant = parseResearchGrant(researchJson(researchRead(path)));
  if (grant.registeredHandoff || grant.projectLaunchBinding) researchInvalid();
  unlinkSync(path); // Active ownership is retained for verified cancel.
}
/** Exact-grant revocation shares publication's registry mutex. It deliberately
 * does not depend on a receipt/scope which may already have been invalidated. */
export async function revokeRegisteredResearchLaunch(jobId: string, expectedGrantSha256: string): Promise<void> {
  await withResearchJobMutationAsync(jobId, () => revokeRegisteredResearchLaunchUnlocked(jobId, expectedGrantSha256));
}
async function revokeRegisteredResearchLaunchUnlocked(jobId: string, expectedGrantSha256: string): Promise<void> {
  assertResearchInitialRoot(true);
  const path = join(researchJobAuthority(jobId), "grant.json"), bytes = researchRead(path);
  const grant = parseResearchGrant(researchJson(bytes));
  if (!grant.registeredHandoff || researchHash(bytes) !== expectedGrantSha256) researchInvalid();
  researchCustody(grant.registeredHandoff.registryRootDir);
  await withCodexGoalRegistryMutation({ registryRootDir: grant.registeredHandoff.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
    researchCustody(grant.registeredHandoff!.registryRootDir);
    if (!researchRead(path).equals(bytes)) researchInvalid();
    unlinkSync(path); // No owned mounts/active uncertainty is discarded.
  } });
}
/** Preserve the protected project origin across revoke, including before the
 * first start. Unlinking it would allow a standalone regrant to lose the fence. */
export async function revokeProjectResearchLaunch(jobId: string, expectedGrantSha256: string): Promise<void> {
  await withResearchJobMutationAsync(jobId, async () => {
    assertResearchInitialRoot(true);
    const job = researchJobAuthority(jobId), path = join(job, "grant.json"), bytes = researchRead(path);
    const grant = parseResearchGrant(researchJson(bytes)), binding = grant.projectLaunchBinding;
    if (!binding || researchHash(bytes) !== expectedGrantSha256) researchInvalid();
    await withCodexGoalRegistryMutation({ registryRootDir: binding.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
      researchCustody(binding.registryRootDir);
      if (!researchRead(path).equals(bytes)) researchInvalid();
      researchPublish(join(job, "revoked-project-grant.json"), { schemaVersion: 1, grantSha256: expectedGrantSha256 });
    } });
  });
}
export function startResearchLaunch(requestPath: string, expectedRequestSha256: string): { jobId: string; unit: string; startId: string; specSha256: string } {
  const jobId = researchStartMutationJobId(requestPath, expectedRequestSha256);
  return withResearchJobMutation(jobId, () => prepareResearchLaunchInternal(requestPath, expectedRequestSha256).submit());
}
/** Enrollment's exact grant is rechecked inside the original submission fence. */
export function startEnrolledResearchLaunch(requestPath: string, expectedRequestSha256: string, expectedGrantSha256: string): ReturnType<typeof startResearchLaunch> {
  const jobId = researchStartMutationJobId(requestPath, expectedRequestSha256);
  return withResearchJobMutation(jobId, () => {
    if (researchHash(researchRead(join(researchJobAuthority(jobId), "grant.json"))) !== expectedGrantSha256) researchInvalid();
    return prepareResearchLaunchInternal(requestPath, expectedRequestSha256).submit();
  });
}
export async function startRegisteredResearchLaunch(requestPath: string, expectedRequestSha256: string): Promise<ReturnType<typeof startResearchLaunch>> {
  const jobId = researchStartMutationJobId(requestPath, expectedRequestSha256);
  return await withResearchJobMutationAsync(jobId, () => startRegisteredResearchLaunchUnlocked(requestPath, expectedRequestSha256));
}
export async function startProjectResearchLaunch(requestPath: string, expectedRequestSha256: string): Promise<ReturnType<typeof startResearchLaunch>> {
  const jobId = researchStartMutationJobId(requestPath, expectedRequestSha256);
  return await withResearchJobMutationAsync(jobId, async () => {
    assertResearchInitialRoot(true); assertResearchSharedHost();
    const bytes = researchRead(researchPath(requestPath));
    if (researchHash(bytes) !== expectedRequestSha256) researchInvalid();
    const request = parseResearchOperatorRequest(researchJson(bytes)), grantPath = join(researchJobAuthority(jobId), "grant.json");
    const grantBytes = researchRead(grantPath), grant = parseResearchGrant(researchJson(grantBytes)), binding = grant.projectLaunchBinding;
    if (!binding || request.durableHandoffRootDir !== undefined) researchInvalid();
    return await withCodexGoalRegistryMutation({ registryRootDir: binding.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
      if (!researchRead(grantPath).equals(grantBytes) || !researchRead(requestPath).equals(bytes)) researchInvalid();
      assertResearchProjectGrantNotRevoked(jobId, researchHash(grantBytes));
      let assertAuthorityBytes = await assertResearchProjectLaunchBindingCurrent(binding, request);
      const prepared = prepareResearchLaunchInternal(requestPath, expectedRequestSha256, undefined, {
        binding, grantSha256: researchHash(grantBytes), assertAuthorityBytes: () => assertAuthorityBytes(),
      });
      // Pin/material preparation may block. Finish its fresh async observation
      // with the synchronous byte fence inside submit, immediately before exec.
      assertAuthorityBytes = await assertResearchProjectLaunchBindingCurrent(binding, request);
      return prepared.submit();
    } });
  });
}
function researchStartMutationJobId(requestPath: string, expectedRequestSha256: string): string {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const bytes = researchRead(researchPath(requestPath));
  if (researchHash(bytes) !== expectedRequestSha256) researchInvalid();
  return parseResearchOperatorRequest(researchJson(bytes)).jobId;
}
async function startRegisteredResearchLaunchUnlocked(requestPath: string, expectedRequestSha256: string): Promise<ReturnType<typeof startResearchLaunch>> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const bytes = researchRead(researchPath(requestPath));
  if (researchHash(bytes) !== expectedRequestSha256) researchInvalid();
  const request = parseResearchOperatorRequest(researchJson(bytes));
  const grantBytes = researchRead(join(researchJobAuthority(request.jobId), "grant.json"));
  const grant = parseResearchGrant(researchJson(grantBytes));
  if (!grant.registeredHandoff || request.durableHandoffRootDir === undefined) researchInvalid();
  return await withCodexGoalRegistryMutation({ registryRootDir: grant.registeredHandoff.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
    // A cancel/revoke cannot settle while this exact submitter still owns the
    // critical preparation/submission/readback phase.
    if (!researchRead(join(researchJobAuthority(request.jobId), "grant.json")).equals(grantBytes) ||
        !researchRead(requestPath).equals(bytes)) researchInvalid();
    let assertAuthorityBytes = await assertRegisteredResearchHandoffCurrent(grant.registeredHandoff!, request);
    const prepared = prepareResearchLaunchInternal(requestPath, expectedRequestSha256, {
      binding: grant.registeredHandoff!, grantSha256: researchHash(grantBytes), assertAuthorityBytes: () => assertAuthorityBytes(),
    });
    // Retain pins/authority on any registered drift during blocking preparation.
    assertAuthorityBytes = await assertRegisteredResearchHandoffCurrent(grant.registeredHandoff!, request);
    return prepared.submit();
  } });
}
function prepareResearchLaunchInternal(requestPath: string, expectedRequestSha256: string,
  registered?: { readonly binding: ResearchRegisteredHandoff; readonly grantSha256: string; readonly assertAuthorityBytes: () => void },
  project?: { readonly binding: ResearchProjectLaunchBinding; readonly grantSha256: string; readonly assertAuthorityBytes: () => void }): { submit: () => ReturnType<typeof startResearchLaunch> } {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  researchPath(requestPath);
  const requestBytes = researchRead(requestPath);
  if (researchHash(requestBytes) !== expectedRequestSha256) researchInvalid();
  const request = parseResearchOperatorRequest(researchJson(requestBytes)), job = researchJobAuthority(request.jobId);
  if (!existsSync(join(job, "active.json")) && existsSync(join(job, "last-terminal.json"))) {
    const terminal = terminalResearchStart(request.jobId);
    if (project && terminal.spec.projectLaunchBinding?.receiptSha256 === project.binding.receiptSha256) researchInvalid();
  }
  const grantBytes = researchRead(join(job, "grant.json"));
  const grant = parseResearchGrant(researchJson(grantBytes));
  if (registered ? (researchHash(grantBytes) !== registered.grantSha256 ||
      researchHashRequest(request) !== registered.binding.requestSha256 ||
      JSON.stringify(grant.registeredHandoff) !== JSON.stringify(registered.binding))
    : project ? (researchHash(grantBytes) !== project.grantSha256 || researchHashRequest(request) !== project.binding.requestSha256 ||
      JSON.stringify(grant.projectLaunchBinding) !== JSON.stringify(project.binding))
    : (grant.registeredHandoff !== undefined || grant.projectLaunchBinding !== undefined || request.durableHandoffRootDir !== undefined)) researchInvalid();
  if ((request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) !== (grant.profileId === CodexProviderEgressProfileId.MimoTokenPlan)) researchInvalid();
  assertResearchMimoProfileMatch(request, grant);
  if (grant.jobId !== request.jobId || grant.jobRootDir !== request.jobRootDir || grant.workspacePath !== request.workspacePath) researchInvalid();
  assertResearchDirectory(grant.jobDirectory); assertResearchDirectory(grant.workspaceDirectory);
  assertResearchWritableInputsSafe(request.jobRootDir, request.workspacePath, request.authRootDir);
  assertResearchDirectory(grant.jobDirectory); assertResearchDirectory(grant.workspaceDirectory);
  const assertOwnerBytes = (): void => {
    const owner = project ?? registered;
    if (!owner) return;
    if (!researchRead(join(job, "grant.json")).equals(grantBytes) || !researchRead(requestPath).equals(requestBytes)) researchInvalid();
    if (project) assertResearchProjectGrantNotRevoked(request.jobId, project.grantSha256);
    owner.assertAuthorityBytes();
    if (!researchRead(join(job, "grant.json")).equals(grantBytes) || !researchRead(requestPath).equals(requestBytes)) researchInvalid();
  };
  // Old grants must not bypass the newer controller creation fence.
  assertOwnerBytes(); recordRawGoalStateOrigin(request.jobRootDir);
  const runtimeDirectory = installedResearchRuntimeDirectory();
  const artifactSha256 = researchArtifactDigest(runtimeDirectory);
  const nodeSha256 = researchExecutableDigest(process.execPath), codexSha256 = researchExecutableDigest(request.codexBinaryPath);
  researchPromptBytes(researchDirectoryIdentity(request.jobRootDir), request.promptPath);
  // Auth roots are trust inputs, not provider-readable writable workspaces.
  researchCustody(request.authRootDir);
  // Material hashing and custody reads must not leave a stale mount observation.
  assertResearchWritableInputsSafe(request.jobRootDir, request.workspacePath, request.authRootDir);
  assertResearchDirectory(grant.jobDirectory); assertResearchDirectory(grant.workspaceDirectory);
  const startId = randomUUID(), unit = `subscription-runtime-research-${startId}.service`;
  assertOwnerBytes();
  researchPrivateDirectory(join(job, "starts"));
  assertOwnerBytes();
  const directory = join(job, "starts", startId); researchPrivateDirectory(directory);
  assertOwnerBytes();
  researchPrivateDirectory(join(directory, "providers"));
  assertOwnerBytes();
  researchPrivateDirectory(join(directory, "pins"));
  const jobDirectory = researchDirectoryIdentity(request.jobRootDir), workspaceDirectory = researchDirectoryIdentity(request.workspacePath);
  const spec: ResearchStartSpec = { schemaVersion: 1, startId, runtimeDirectory, artifactSha256, nodeSha256, codexSha256,
    ...(registered ? { registeredHandoff: registered.binding } : {}),
    ...(project ? { projectLaunchBinding: project.binding } : {}),
    grantSha256: researchHash(grantBytes), request, requestSha256: expectedRequestSha256, unit, jobDirectory, workspaceDirectory };
  // Acquire the per-job active slot exclusively before any mount/service effect.
  const specBytes = Buffer.from(JSON.stringify(spec) + "\n"), specSha256 = researchHash(specBytes);
  assertOwnerBytes();
  researchPublish(join(directory, "spec.json"), spec, true);
  assertOwnerBytes();
  researchPublish(join(job, "active.json"), { schemaVersion: 1, startId, specSha256 }, true);
  // Never undo an uncertain launch. The retained active slot identifies exactly
  // what status/cancel must reconcile; no replacement job or shared-scope kill.
  let stage = ResearchLaunchStage.PinPreparation;
  try {
    for (const [name, identity] of [["job", jobDirectory], ["workspace", workspaceDirectory]] as const) {
      const pin = join(directory, "pins", name);
      assertOwnerBytes();
      researchPrivateDirectory(pin);
      assertResearchDirectory(identity);
      assertOwnerBytes();
      researchCommand("/usr/bin/mount", ["--bind", identity.path, pin]);
      assertResearchDirectory(identity); assertResearchDirectory(identity, pin);
      assertOwnerBytes();
      researchCommand("/usr/bin/mount", ["--make-private", pin]);
    }
    if (registered) {
      const identity = registered.binding.durableDirectory, pin = join(directory, "pins", "durable-handoff");
      assertOwnerBytes();
      researchPrivateDirectory(pin);
      assertResearchDurableDirectory(identity);
      assertOwnerBytes();
      researchCommand("/usr/bin/mount", ["--bind", identity.path, pin]);
      assertResearchDurableDirectory(identity);
      assertOwnerBytes();
      researchCommand("/usr/bin/mount", ["--make-private", pin]);
      const witness = researchDurableDirectory(pin);
      if (!sameResearchDurableBacking(identity, witness)) researchInvalid();
      assertOwnerBytes();
      researchPublish(join(directory, "durable-pin.json"), { schemaVersion: 1, specSha256, pin: witness }, true);
    }
    stage = ResearchLaunchStage.InputPreparation;
    researchPromptBytes(jobDirectory, request.promptPath, join(directory, "pins", "job"));
    for (const name of ["state", "home", "tmp"]) {
      const path = join(directory, "pins", "job", name);
      assertOwnerBytes();
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      researchDirectoryIdentity(path);
    }
    stage = ResearchLaunchStage.LaunchPlan;
    const launch = trustedResearchRuntimeLaunch(spec, specSha256);
    return { submit: () => {
      try {
        if (registered) assertResearchDurableDirectory(registered.binding.durableDirectory);
        stage = ResearchLaunchStage.HostSubmission;
        assertResearchSharedHost();
        const before = researchCurrentStart(request.jobId);
        if (!before.bytes.equals(specBytes) || existsSync(join(directory, "closing.json")) ||
            !researchRead(join(job, "grant.json")).equals(grantBytes)) researchInvalid();
        assertOwnerBytes();
        researchCommand(launch.command, launch.args);
        // A successful submission is a request, not provider/turn success.
        stage = ResearchLaunchStage.StartReadback;
        const current = researchCurrentStart(request.jobId);
        if (!current.bytes.equals(specBytes)) researchInvalid();
        assertOwnerBytes();
        return { jobId: request.jobId, unit, startId, specSha256 };
      } catch (error) { throw annotateResearchLaunchStage(error, stage); }
    } };
  } catch (error) { throw annotateResearchLaunchStage(error, stage); }
}
