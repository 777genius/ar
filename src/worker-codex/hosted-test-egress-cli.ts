#!/usr/bin/env node
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { writeHostedTestEgressGrant, revokeHostedTestEgressGrant } from "./hosted-test-egress-files";
import { parseDependencyToolRegistration } from "../core/dependency-environment/dependency-tool-profile";

const operands = process.argv.slice(2);
const [operation, jobId, jobRootDir, workspacePath] = operands;
try {
  if (operation === "grant-tools" && operands.length === 7 && jobId && jobRootDir && workspacePath) {
    const registration = parseDependencyToolRegistration({ testFiles: [operands[4]], optimizerDependencies: [operands[5]], transformCache: operands[6] });
    await writeHostedTestEgressGrant({ schemaVersion: 1, jobId, jobRootDir, workspacePath,
      profileId: CodexProviderEgressProfileId.TestNpmQualification }, registration);
  } else if ((operation === "grant-internet" || operation === "grant" || operation === "grant-managed" || operation === "grant-research") &&
      operands.length === 4 && jobId?.trim() && jobRootDir?.trim() && workspacePath?.trim()) {
    await writeHostedTestEgressGrant({
      schemaVersion: 1, jobId, jobRootDir, workspacePath,
      profileId: operation === "grant-internet"
        ? CodexProviderEgressProfileId.FullInternetV1
        : operation === "grant-research"
        ? CodexProviderEgressProfileId.PublicResearchV1
        : operation === "grant-managed"
        ? CodexProviderEgressProfileId.TestManagedQualification
        : CodexProviderEgressProfileId.TestNpmQualification,
    });
  } else if (operation === "revoke" && operands.length === 2 && jobId?.trim()) {
    await revokeHostedTestEgressGrant(jobId);
  } else {
    throw new Error("usage: hosted-test-egress-cli grant-tools JOB ROOT WORKSPACE TEST_FILE DEPENDENCY persisted|temporary | grant-internet JOB ROOT WORKSPACE | grant JOB ROOT WORKSPACE | grant-managed JOB ROOT WORKSPACE | grant-research JOB ROOT WORKSPACE | revoke JOB");
  }
  process.stdout.write(JSON.stringify({ operation, jobId, success: true }) + "\n");
} catch {
  process.stderr.write("hosted_test_egress_operator_action_failed\n");
  process.exitCode = 1;
}
