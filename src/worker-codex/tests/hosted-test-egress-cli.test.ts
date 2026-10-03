import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";

const files = vi.hoisted(() => ({ writeHostedTestEgressGrant: vi.fn(), revokeHostedTestEgressGrant: vi.fn() }));
vi.mock("../hosted-test-egress-files", () => files);

describe("trusted operator CLI (mock grant adapter only)", () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.argv = argv; process.exitCode = exitCode;
    vi.restoreAllMocks(); vi.resetAllMocks();
  });
  async function run(args: string[]) {
    process.argv = ["node", "/synthetic/cli", ...args];
    await import("../hosted-test-egress-cli");
  }
  it.each([
    ["grant", CodexProviderEgressProfileId.TestNpmQualification],
    ["grant-managed", CodexProviderEgressProfileId.TestManagedQualification],
  ] as const)("selects only the fixed profile for %s", async (operation, profileId) => {
    await run([operation, "job", "/synthetic/root", "/synthetic/workspace"]);
    expect(files.writeHostedTestEgressGrant).toHaveBeenCalledExactlyOnceWith({
      schemaVersion: 1, jobId: "job", jobRootDir: "/synthetic/root", workspacePath: "/synthetic/workspace", profileId,
    });
    expect(files.revokeHostedTestEgressGrant).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(JSON.stringify({ operation, jobId: "job", success: true }) + "\n");
    expect(process.exitCode).toBeUndefined();
  });
  it("preserves revoke", async () => {
    await run(["revoke", "job"]);
    expect(files.revokeHostedTestEgressGrant).toHaveBeenCalledExactlyOnceWith("job");
    expect(files.writeHostedTestEgressGrant).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
  const malformed = [[], ["unknown"], ["revoke"], ["revoke", ""], ["revoke", " "],
    ["revoke", "job", ""], ["revoke", "job", "", "extra"], ["revoke", "job", "extra"]];
  for (const operation of ["grant", "grant-managed"]) {
    malformed.push([operation], [operation, "job", "/root"], [operation, "job", "/root", "/workspace", "" ]);
    for (let index = 1; index <= 3; index++) {
      for (const empty of ["", " "]) {
        const args = [operation, "job", "/root", "/workspace"]; args[index] = empty; malformed.push(args);
      }
    }
  }
  it.each(malformed.map(args => [args]))("rejects malformed operands %j before adapter calls", async args => {
    await run(args);
    expect(files.writeHostedTestEgressGrant).not.toHaveBeenCalled();
    expect(files.revokeHostedTestEgressGrant).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith("hosted_test_egress_operator_action_failed\n");
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
  it("sanitizes adapter failures", async () => {
    files.writeHostedTestEgressGrant.mockRejectedValue(new Error("PRIVATE_SENTINEL"));
    await run(["grant-managed", "job", "/root", "/workspace"]);
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith("hosted_test_egress_operator_action_failed\n");
    expect(process.exitCode).toBe(1);
  });
});
