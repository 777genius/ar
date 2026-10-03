import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AccessBoundary, adoptPublishedIntegrationCommit,
  type ExternalPublicationAttestation } from "@vioxen/subscription-runtime/worker-core";
import { mcpJson } from "./codex-goal-mcp-response";
import { loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { localProjectIntegrationDeps } from
  "./project-integration-mcp/adapters/local-project-integration-mcp-tool-handlers";
import { assertPublishedIntegrationAttemptMutable } from
  "./application/project-control/codex-goal-published-adoption-quarantine";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const attestationSchema = z.object({
  provenance: z.literal("operator_attestation"),
  operator: z.string().regex(/^[A-Za-z0-9_.@-]{1,200}$/),
  verifiedAt: z.string().datetime(),
  verificationMethod: z.literal("authenticated_gh_api"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  remote: z.string().min(1), branch: z.string().min(1),
  commitSha: sha,
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const permitSchema = z.object({
  schemaVersion: z.literal(1),
  controllerJobId: z.string().min(1),
  attemptId: z.string().min(1),
  commitSha: sha,
  message: z.string().min(1),
  attestation: attestationSchema,
}).strict();

export type PublishedAdoptionMcpArgs = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
  readonly controllerJobId: string;
  readonly attemptId: string;
  readonly commitSha: string;
  readonly message: string;
  readonly permitFile: string;
  readonly expectedPermitSha256: string;
  readonly confirmAdoption?: boolean;
};

export async function projectControlAdoptPublishedIntegrationCommit(
  args: PublishedAdoptionMcpArgs,
) {
  const controller = await loadProjectControlController(args);
  if (controller.scope.consumedOutputLedgerRoots?.length !== 1 ||
      !controller.scope.consumedOutputEvidenceRoots?.length) {
    throw new Error("published_commit_adoption_ledger_scope_required");
  }
  if (!args.confirmAdoption) {
    return mcpJson({
      ok: false, reason: "confirm_adoption_required",
      mode: "project_adopt_published_integration_commit",
      attemptId: args.attemptId, commitSha: args.commitSha,
      provenance: "operator_attestation",
    });
  }
  await assertPublishedIntegrationAttemptMutable({
    controllerJobRootDir: controller.controller.jobRootDir,
    scope: controller.scope,
    attemptId: args.attemptId,
  });
  const permit = await readPublishedAdoptionPermit(args);
  const attempt = await adoptPublishedIntegrationCommit(localProjectIntegrationDeps(controller), {
    attemptId: args.attemptId,
    commitSha: args.commitSha,
    message: args.message,
    attestation: permit.attestation,
    policy: { access: { boundary: AccessBoundary.ProjectScopedControl, scope: controller.scope } },
  });
  return mcpJson({
    ok: true,
    mode: "project_adopt_published_integration_commit",
    provenance: "operator_attestation",
    independentlyVerifiedRemote: false,
    controllerJobId: controller.controller.jobId,
    attempt,
  });
}

async function readPublishedAdoptionPermit(args: PublishedAdoptionMcpArgs): Promise<{
  readonly attestation: ExternalPublicationAttestation;
}> {
  if (process.geteuid?.() !== 0) throw new Error("published_commit_adoption_root_required");
  if (!isAbsolute(args.permitFile)) throw new Error("published_commit_adoption_permit_absolute_required");
  const handle = await open(args.permitFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 ||
        stat.size > 64 * 1024) throw new Error("published_commit_adoption_permit_security_invalid");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size ||
        createHash("sha256").update(bytes).digest("hex") !== args.expectedPermitSha256) {
      throw new Error("published_commit_adoption_permit_hash_mismatch");
    }
    const permit = permitSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (permit.controllerJobId !== args.controllerJobId ||
        permit.attemptId !== args.attemptId || permit.commitSha !== args.commitSha ||
        permit.message !== args.message) throw new Error("published_commit_adoption_permit_binding_mismatch");
    return permit;
  } finally {
    await handle.close();
  }
}
