import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HostedOrdinaryBirth } from "@vioxen/subscription-runtime/worker-core";
import { readHostedActivationBytes, decodeHostedActivationBytes, CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { parseHostedCustodyEnrollment } from "./hosted-activation-validation";
import { readHostedPrivateBytes, hostedReadonlyPolicyRoot } from "./hosted-readonly-inputs";
import { parseHostedTestEgressGrant, assertHostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function invalid(): never { throw new Error("hosted_activation_evidence_invalid"); }

export function assertNoManagedOrigin(birth: HostedOrdinaryBirth): string | null {
  const jobId = birth.jobId;
  const name = digest(Buffer.from(jobId)) + ".json";
  if (readHostedPrivateBytes(join(hostedReadonlyPolicyRoot, name), 64 * 1024)) invalid();
  if (readHostedActivationBytes("codex-readonly-custody/" + name) || readHostedActivationBytes("codex-readonly-revoked/" + name)) invalid();
  const enrollment = readHostedActivationBytes("readonly-enrollment.json");
  if (enrollment && parseHostedCustodyEnrollment(decodeHostedActivationBytes(enrollment)) === jobId) invalid();
  const grantBytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, name), 4096);
  if (grantBytes) {
    const grant = parseHostedTestEgressGrant(decodeHostedActivationBytes(grantBytes));
    assertHostedTestEgressIdentity(grant, birth);
    if (grant.profileId === CodexProviderEgressProfileId.TestManagedQualification) invalid();
  }
  return grantBytes ? digest(grantBytes) : null;
}
