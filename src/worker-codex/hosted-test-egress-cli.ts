#!/usr/bin/env node
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { writeHostedTestEgressGrant, revokeHostedTestEgressGrant } from "./hosted-test-egress-files";

const operands = process.argv.slice(2);
const [operation, jobId, jobRootDir, workspacePath] = operands;
try {
  if ((operation === "grant" || operation === "grant-managed") &&
      operands.length === 4 && jobId?.trim() && jobRootDir?.trim() && workspacePath?.trim()) {
    await writeHostedTestEgressGrant({
      schemaVersion: 1, jobId, jobRootDir, workspacePath,
      profileId: operation === "grant-managed"
        ? CodexProviderEgressProfileId.TestManagedQualification
        : CodexProviderEgressProfileId.TestNpmQualification,
    });
  } else if (operation === "revoke" && operands.length === 2 && jobId?.trim()) {
    await revokeHostedTestEgressGrant(jobId);
  } else {
    throw new Error("usage: hosted-test-egress-cli grant JOB ROOT WORKSPACE | grant-managed JOB ROOT WORKSPACE | revoke JOB");
  }
  process.stdout.write(JSON.stringify({ operation, jobId, success: true }) + "\n");
} catch {
  process.stderr.write("hosted_test_egress_operator_action_failed\n");
  process.exitCode = 1;
}
