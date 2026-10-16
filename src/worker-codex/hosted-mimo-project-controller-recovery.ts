import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { assertResearchInitialRoot, assertResearchSharedHost } from "./research-launch-host";
import { researchAuthorityRoot, researchCustody, researchHash, researchPublish } from "./research-launch-files";
import { hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { createCodexGoalJob, parseStoredCodexGoalJobManifest, type CodexGoalJobManifest } from "./codex-goal-jobs";
import { assertNoWorkstreamRetirement } from "./job-retirement/job-retirement-records";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { durableReplaceJsonFile } from "./project-control-operation-file-store";
import { hostedMimoSealedSourcePort } from "./hosted-mimo-project-source";
import { controllerHistoricalAttestationSchema } from "./application/project-control/codex-goal-controller-historical-attestation";
import { assertControllerRelocationIdle } from "./application/project-control/codex-goal-controller-relocation-idle";
import { observeProtectedCodexGoalJobBirth, withProtectedCodexGoalJobBirthPublication } from "./protected-job-birth";
import { assertHostedMimoRecoveryOperationsSettled } from "./hosted-mimo-project-bridge-operation";
import { hostedOrdinaryWriterAuthorityAbsent } from "./hosted-ordinary-writer-authority";
import { observeResearchJobWriterAuthority } from "./research-writer-observation";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.object({ schemaVersion: z.literal(1), projectId: z.string(), workstreamId: z.string(), machineId: z.string(),
  expectedBindingSha256: sha, expectedControllerManifestSha256: sha, newControllerJobId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  attestation: controllerHistoricalAttestationSchema.omit({ destinationWorkspacePath: true }).extend({
    confirmation: z.literal("I attest complete never-run controller history through this recovery maintenance fence"),
  }),
}).strict();
const fail = (): never => { throw new Error("mimo_project_bridge_recovery_denied"); };
function privateDirectory(path: string): void {
  if (!existsSync(path)) { researchCustody(dirname(path)); mkdirSync(path, { mode: 0o700 }); }
  researchCustody(path, true);
}
function syncDirectory(path: string): void {
  researchCustody(path, true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
function assertNoControllerAuthority(manifest: CodexGoalJobManifest): void {
  researchCustody(manifest.jobRootDir, true);
  const stat = lstatSync(manifest.jobRootDir);
  for (const root of [researchAuthorityRoot, "/var/lib/subscription-runtime-host-policy"]) {
    if (!absent(root)) researchCustody(root, true); else researchCustody(dirname(root));
  }
  // A retained native namespace or ordinary host policy is never an absence
  // proof. This bounded operator path does not adopt any previously run job.
  if (!absent(join(researchAuthorityRoot, researchHash(manifest.jobId))) ||
      !hostedOrdinaryWriterAuthorityAbsent(manifest.jobId)) fail();
  const birth = join(researchAuthorityRoot, "job-births");
  if (!absent(birth)) researchCustody(birth, true);
  for (const key of [researchHash(manifest.jobRootDir), `physical-${stat.dev}-${stat.ino}`])
    if (!absent(join(birth, key + ".first-effect.json"))) fail();
}

/** Operator-only registration retirement. Old authority remains unknown;
 * normal canonical publication certifies an entirely fresh controller root.
 * The immutable guard closes ingress across crashes until exact-plan replay. */
export async function recoverHostedMimoController(inputPath: string): Promise<unknown> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const planBytes = hostedMimoBridgeMetadataBytes(inputPath), plan = planSchema.parse(JSON.parse(planBytes.toString()));
  const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1, operation: MimoProjectBridgeOperation.Status,
    projectId: plan.projectId, workstreamId: plan.workstreamId, machineId: plan.machineId, jobId: "recovery-validation" });
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== plan.machineId) fail();
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${plan.projectId}/${plan.workstreamId}.json`;
  const currentBytes = hostedMimoBridgeMetadataBytes(bindingPath);
  const current = parseHostedMimoProjectBinding(JSON.parse(currentBytes.toString()), request);
  const guardPath = join(current.stateRoot, ".controller-recovery.json"), receiptPath = join(current.stateRoot, `controller-recovery-${plan.newControllerJobId}.json`);
  const planSha256 = researchHash(planBytes), replay = !absent(guardPath);
  const guard = replay ? JSON.parse(hostedMimoBridgeMetadataBytes(guardPath).toString()) : { schemaVersion: 1, planSha256, binding: current };
  if (guard.schemaVersion !== 1 || guard.planSha256 !== planSha256) fail();
  const binding = parseHostedMimoProjectBinding(guard.binding, request);
  if (researchHash(Buffer.from(JSON.stringify(binding))) !== researchHash(Buffer.from(JSON.stringify(current))) &&
      JSON.stringify({ ...current, controllerJobId: binding.controllerJobId }) !== JSON.stringify(binding)) fail();
  if (!replay && researchHash(currentBytes) !== plan.expectedBindingSha256) fail();
  if (plan.newControllerJobId === binding.controllerJobId || !plan.newControllerJobId.startsWith(binding.controllerJobId + "-r")) fail();
  const oldRegistration = join(binding.registryRootDir, binding.controllerJobId);
  const archiveRoot = join(binding.registryRootDir, ".project-control", "superseded-controllers");
  const archive = join(archiveRoot, binding.controllerJobId + "-" + plan.expectedControllerManifestSha256);
  const oldPath = join(absent(oldRegistration) ? archive : oldRegistration, "job.json");
  const oldBytes = hostedMimoBridgeMetadataBytes(oldPath, 1048576), old = parseStoredCodexGoalJobManifest(JSON.parse(oldBytes.toString()));
  const scope = old.projectAccessScope ?? fail(), a = plan.attestation;
  if (researchHash(oldBytes) !== plan.expectedControllerManifestSha256 || old.jobId !== binding.controllerJobId ||
      old.workspacePath !== binding.sourceWorkspacePath || old.accessBoundary !== AccessBoundary.ProjectScopedControl ||
      old.accounts.length !== 1 || old.accounts[0] !== "account-q" || scope.projectId !== binding.projectId || scope.registryRoot !== binding.registryRootDir ||
      scope.allowedAccountIds?.length !== 1 || scope.allowedAccountIds[0] !== "account-q" ||
      a.controllerJobId !== old.jobId || a.controllerCreatedAt !== old.createdAt || a.manifestSha256 !== researchHash(oldBytes) ||
      a.scopeSha256 !== researchHash(JSON.stringify(scope)) || a.registryRootDir !== binding.registryRootDir ||
      a.jobRootDir !== old.jobRootDir || a.sourceWorkspacePath !== binding.sourceWorkspacePath) fail();
  for (const directory of [binding.registryRootDir, old.jobRootDir]) researchCustody(directory, true);
  if (old.jobRootDir !== join(binding.stateRoot, "controller") &&
      old.jobRootDir !== join(binding.stateRoot, "controller-recoveries", old.jobId)) fail();
  const age = Date.now() - Date.parse(a.assertedAt);
  if (!replay && (age < 0 || age > 600000)) fail();
  for (const evidence of a.evidence) if (researchHash(hostedMimoBridgeMetadataBytes(evidence.reference, 1048576)) !== evidence.sha256) fail();
  for (const path of [binding.stateRoot, binding.registryRootDir, binding.scratchRoot]) researchCustody(path, true);
  const oldIdentity = lstatSync(old.jobRootDir);
  const registryIdentity = lstatSync(binding.registryRootDir);
  const validate = async () => {
    // A workstream being or already retired is never given a new controller.
    assertNoWorkstreamRetirement(binding.stateRoot, "mimo_project_bridge_retirement_pending");
    const now = lstatSync(old.jobRootDir), registry = lstatSync(binding.registryRootDir);
    if (now.dev !== oldIdentity.dev || now.ino !== oldIdentity.ino || registry.dev !== registryIdentity.dev || registry.ino !== registryIdentity.ino) fail();
    const rows = readdirSync(binding.registryRootDir, { withFileTypes: true });
    for (const row of rows) {
      if ([old.jobId, ...(replay ? [plan.newControllerJobId] : []), ".project-control", "archives", "consumed-output-ledger", ".consumed-output-ledger-mutation-locks"].includes(row.name)) continue;
      fail();
    }
    assertNoControllerAuthority(old);
    await hostedMimoSealedSourcePort(binding).resolveRevision({ sourceWorkspacePath: binding.sourceWorkspacePath,
      sourceRef: binding.sourceRef, expectedSourceCommit: binding.sourceCommit });
    await assertHostedMimoRecoveryOperationsSettled(binding);
    await assertControllerRelocationIdle({ controller: old, attestedNeverRunControllerJobId: old.jobId,
      registryRootDir: binding.registryRootDir, workspacePaths: [binding.sourceWorkspacePath], manifests: [old] });
  };
  const workstreamFence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: binding.stateRoot, owner: "mimo-controller-recovery:" + planSha256 });
  let oldFence: Awaited<ReturnType<typeof acquireLocalControllerMaintenanceFence>> | undefined;
  let committed = false;
  try {
    oldFence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: old.jobRootDir, owner: "mimo-controller-recovery:" + planSha256 });
    await validate();
    if (!replay) researchPublish(guardPath, guard, true);
    const newRoot = join(binding.stateRoot, "controller-recoveries", plan.newControllerJobId);
    privateDirectory(dirname(newRoot));
    const newPath = join(binding.registryRootDir, plan.newControllerJobId, "job.json");
    let fresh: CodexGoalJobManifest;
    if (absent(newPath)) {
      // A crash may have consumed exclusive root creation before canonical
      // birth publication. Never replay it as an uncertified existing root.
      if (!absent(newRoot)) throw new Error("mimo_project_bridge_recovery_reconciliation_required");
      const { schemaVersion: _version, createdAt: _created, updatedAt: _updated, ...template } = old;
      fresh = await createCodexGoalJob({ registryRootDir: binding.registryRootDir, overwrite: false, manifest: { ...template,
        jobId: plan.newControllerJobId, taskId: plan.newControllerJobId, jobRootDir: newRoot,
        projectAccessScope: { ...scope, jobIdPrefixes: [...(scope.jobIdPrefixes ?? []), plan.newControllerJobId],
          tmuxSessionPrefixes: [...(scope.tmuxSessionPrefixes ?? []), plan.newControllerJobId] } } });
    } else fresh = parseStoredCodexGoalJobManifest(JSON.parse(hostedMimoBridgeMetadataBytes(newPath, 1048576).toString()));
    syncDirectory(binding.stateRoot);
    if (!isDeepStrictEqual(fresh, { ...old, jobId: plan.newControllerJobId, taskId: plan.newControllerJobId,
      jobRootDir: newRoot, createdAt: fresh.createdAt, updatedAt: fresh.updatedAt, projectAccessScope: { ...scope,
        jobIdPrefixes: [...(scope.jobIdPrefixes ?? []), plan.newControllerJobId], tmuxSessionPrefixes: [...(scope.tmuxSessionPrefixes ?? []), plan.newControllerJobId] } })) fail();
    // Publication and birth first effects share the canonical owner mutex.
    await withCodexGoalRegistryMutation({ registryRootDir: binding.registryRootDir, requireExistingRegistryRoot: true,
      effect: async () => withProtectedCodexGoalJobBirthPublication(async () => {
        assertNoControllerAuthority(old);
        const bound = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(bindingPath).toString()), request);
        if (JSON.stringify(bound) !== JSON.stringify(binding) && JSON.stringify(bound) !== JSON.stringify({ ...binding, controllerJobId: fresh.jobId })) fail();
        if (researchHash(hostedMimoBridgeMetadataBytes(oldPath, 1048576)) !== plan.expectedControllerManifestSha256 ||
            (await observeProtectedCodexGoalJobBirth(fresh)).status !== "released" ||
            (await observeResearchJobWriterAuthority(fresh)).status !== "released") fail();
        for (const row of readdirSync(binding.registryRootDir))
          if (![old.jobId, fresh.jobId, ".project-control", "archives", "consumed-output-ledger", ".consumed-output-ledger-mutation-locks"].includes(row)) fail();
        if (bound.controllerJobId === old.jobId && researchHash(hostedMimoBridgeMetadataBytes(bindingPath)) !== plan.expectedBindingSha256) fail();
        await assertHostedMimoRecoveryOperationsSettled(binding);
        for (const path of [join(binding.registryRootDir, ".project-control"), archiveRoot]) privateDirectory(path);
        if (!absent(oldRegistration)) {
          if (!absent(archive)) fail();
          if (readdirSync(oldRegistration).join(",") !== "job.json") fail();
          renameSync(oldRegistration, archive);
          syncDirectory(binding.registryRootDir); syncDirectory(dirname(archiveRoot)); syncDirectory(archiveRoot);
        }
        const receipt = { schemaVersion: 1, planSha256, oldControllerJobId: old.jobId, oldManifestSha256: researchHash(oldBytes),
          archivedRegistration: archive, newControllerJobId: fresh.jobId, newJobRootDir: newRoot, sourceCommit: binding.sourceCommit,
          expectedBindingSha256: plan.expectedBindingSha256, oldWriterAuthority: "unknown", attestation: a };
        if (absent(receiptPath)) researchPublish(receiptPath, receipt, true);
        else if (hostedMimoBridgeMetadataBytes(receiptPath).toString() !== JSON.stringify(receipt) + "\n") fail();
        await durableReplaceJsonFile({ path: bindingPath, value: { ...binding, controllerJobId: fresh.jobId } });
        if (JSON.stringify(parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(bindingPath).toString()), request)) !==
            JSON.stringify({ ...binding, controllerJobId: fresh.jobId })) fail();
        committed = true;
      }) });
    if (researchHash(hostedMimoBridgeMetadataBytes(guardPath)) !== researchHash(JSON.stringify(guard) + "\n")) fail();
    unlinkSync(guardPath);
    syncDirectory(binding.stateRoot);
    return { ok: true, projectId: binding.projectId, workstreamId: binding.workstreamId, controllerJobId: fresh.jobId, receiptPath };
  } finally {
    // A partial transition retains the exact immutable guard across crashes.
    // Leases are owned identities; unrelated route-disabled markers are untouched.
    if (oldFence) await releaseLocalControllerMaintenanceFence(oldFence);
    await releaseLocalControllerMaintenanceFence(workstreamFence);
    if (!committed && existsSync(guardPath)) researchCustody(guardPath);
  }
}
