import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { assertHostedTestEgressIdentity, parseHostedTestEgressGrant,
  type HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { assertHostedReadonlyPolicyBinding, hostedReadonlyPolicyRoot, parseHostedReadonlyPolicy,
  readHostedPrivateBytes, type HostedReadonlyPolicy } from "./hosted-readonly-inputs";

const authorityRoot = dirname(hostedReadonlyPolicyRoot);
// Derived from the module supplying this code, never from cwd, job JSON or env.
const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

export function readonlyIdentityName(jobId: string): string {
  return createHash("sha256").update(jobId).digest("hex") + ".json";
}

export function assertReadonlyHostOperator(): void {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0 ||
        !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/uid_map", "utf8").trim())) throw new Error();
    for (const ns of ["user", "mnt", "pid"]) {
      if (readlinkSync(`/proc/self/ns/${ns}`) !== readlinkSync(`/proc/1/ns/${ns}`)) throw new Error();
    }
  } catch { throw new Error("hosted_readonly_host_operator_required"); }
}

/** A genuine grant must still exist and still select the mandatory profile. */
export function readReadonlyManagedGrant(identity: HostedTestEgressIdentity): Buffer {
  assertReadonlyHostOperator();
  const bytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, readonlyIdentityName(identity.jobId)), 4096);
  if (!bytes) throw new Error("hosted_readonly_managed_grant_required");
  const grant = parseHostedTestEgressGrant(decodePrivateJson(bytes));
  assertHostedTestEgressIdentity(grant, identity);
  if (grant.profileId !== CodexProviderEgressProfileId.TestManagedQualification) {
    throw new Error("hosted_readonly_managed_grant_required");
  }
  return bytes;
}

/** Root review and stage qualification are separate authorities from enrollment.
 * The readonly CLI cannot write either of these namespaces. Their root owner
 * must install real reviewed projections/receipts, not a policy's self-assertion.
 */
export function readReadonlyReview(policy: HostedReadonlyPolicy): {
  readonly reviewBytes: Buffer;
  readonly stageBytes: Buffer;
  readonly reviewReference: string;
  readonly custodyReference: string;
  readonly corepackShim: { readonly path: string; readonly target: string } | null;
} {
  assertReadonlyHostOperator();
  const reviewPath = join(authorityRoot, "codex-readonly-reviewed", readonlyIdentityName(policy.jobId));
  const reviewBytes = readHostedPrivateBytes(reviewPath, 64 * 1024);
  if (!reviewBytes) throw new Error("hosted_readonly_independent_review_required");
  const review = record(decodePrivateJson(reviewBytes));
  if (Object.keys(review).sort().join(",") !== "corepackShim,custodyReference,policy,reviewReference,schemaVersion" ||
      review.schemaVersion !== 1 || typeof review.reviewReference !== "string" ||
      !review.reviewReference.trim() || review.reviewReference.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(review.reviewReference) ||
      typeof review.custodyReference !== "string" || !review.custodyReference.trim() ||
      review.custodyReference.length > 1024 || /[\u0000-\u001f\u007f]/.test(review.custodyReference)) invalid();
  assertHostedReadonlyPolicyBinding(policy, parseHostedReadonlyPolicy(review.policy));
  let corepackShim: { readonly path: string; readonly target: string } | null = null;
  if (review.corepackShim !== null) {
    const shim = record(review.corepackShim);
    if (Object.keys(shim).sort().join(",") !== "path,target" ||
        typeof shim.path !== "string" || typeof shim.target !== "string" ||
        shim.target.length > 4096 || /[\u0000-\u0020\u007f]/.test(shim.target) ||
        !policy.readonlyPaths.some(root => shim.path === root || (typeof shim.path === "string" && shim.path.startsWith(root + "/"))) ||
        !resolve(dirname(shim.path), shim.target).startsWith(policy.workspacePath + "/tools/published-cli/") ||
        !policy.readonlyPaths.includes(policy.workspacePath + "/tools/published-cli")) invalid();
    corepackShim = Object.freeze({ path: shim.path, target: shim.target });
  }
  const stageBytes = readHostedPrivateBytes(join(authorityRoot, "codex-readonly-stages",
    readonlyIdentityName(runtimeDirectory)), 4096);
  if (!stageBytes) throw new Error("hosted_readonly_verified_stage_required");
  const stage = record(decodePrivateJson(stageBytes));
  if (Object.keys(stage).sort().join(",") !==
      "runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion" ||
      stage.schemaVersion !== 1 || stage.runtimeDirectory !== runtimeDirectory ||
      stage.runtimeSha !== policy.runtimeSha ||
      stage.runtimeManifestSha256 !== policy.runtimeManifestSha256) invalid();
  return { reviewBytes, stageBytes, reviewReference: review.reviewReference, custodyReference: review.custodyReference, corepackShim };
}

export function decodePrivateJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid(); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new Error("hosted_readonly_authority_invalid"); }
