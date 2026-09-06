#!/usr/bin/env node
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { writeHostedTestEgressGrant, revokeHostedTestEgressGrant } from "./hosted-test-egress-files";

const [operation, jobId, jobRootDir, workspacePath, ...extra] = process.argv.slice(2);
try {
  if (operation === "grant" && jobId && jobRootDir && workspacePath && !extra.length) {
    await writeHostedTestEgressGrant({
      schemaVersion: 1, jobId, jobRootDir, workspacePath,
      profileId: CodexProviderEgressProfileId.TestNpmQualification,
    });
  } else if (operation === "revoke" && jobId && !jobRootDir) {
    await revokeHostedTestEgressGrant(jobId);
  } else {
    throw new Error("usage: hosted-test-egress-cli grant JOB ROOT WORKSPACE | revoke JOB");
  }
  process.stdout.write(JSON.stringify({ operation, jobId, success: true }) + "\n");
} catch {
  process.stderr.write("hosted_test_egress_operator_action_failed\n");
  process.exitCode = 1;
}
