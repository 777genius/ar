import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { parseHostedTestEgressGrant, assertHostedTestEgressIdentity } from "../hosted-test-egress-contract";
import {
  assertHostedTestEgressOperator, canonicalHostedTestIdentity,
  hostedTestEgressGrantName, hostedTestEgressGrantRoot, readHostedTestEgressGrantFile,
} from "../hosted-test-egress-files";
import { buildCodexGoalExecutorOptions, codexGoalAccountSlots } from "../codex-goal-runner";

describe("trusted hosted TEST egress custody", () => {
  let root: string;
  let authority: string;
  let identity: { jobId: string; jobRootDir: string; workspacePath: string };
  const uid = process.getuid?.() ?? 0;
  const grant = () => ({
    schemaVersion: 1 as const, ...identity,
    profileId: CodexProviderEgressProfileId.TestNpmQualification,
  });
  const filename = () => join(authority, hostedTestEgressGrantName(identity.jobId));
  beforeEach(async () => {
    // Under the disposable checkout: /tmp is intentionally not trusted grant custody.
    root = await mkdtemp(join(process.cwd(), ".test-egress-"));
    authority = join(root, "authority");
    identity = { jobId: "test-exact-job", jobRootDir: join(root, "job"), workspacePath: join(root, "workspace") };
    await Promise.all([authority, identity.jobRootDir, identity.workspacePath].map(p => mkdir(p, { mode: 0o700 })));
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("keeps authority under the path hidden by already-deployed namespaces", () => {
    expect(hostedTestEgressGrantRoot).toBe("/run/user/0/subscription-runtime-host-policy/codex-egress");
    expect(hostedTestEgressGrantName("../../escape")).toMatch(/^[a-f0-9]{64}\.json$/);
  });
  it("admits only an exact, canonical, closed record and defaults missing records", async () => {
    expect(await readHostedTestEgressGrantFile(authority, identity, uid)).toBeNull();
    await writeFile(filename(), JSON.stringify(grant()), { mode: 0o600 });
    expect(await readHostedTestEgressGrantFile(authority, identity, uid)).toEqual(grant());
    expect(await readHostedTestEgressGrantFile(authority, { ...identity, jobId: "other" }, uid)).toBeNull();
  });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("roundtrips a frozen closed TEST grant: %s", profileId => {
    const value = { ...grant(), profileId };
    const parsed = parseHostedTestEgressGrant(JSON.parse(JSON.stringify(value)));
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseHostedTestEgressGrant({ ...value, domains: ["api.github.com"] })).toThrow("hosted_test_egress_grant_invalid");
  });
  it.each(["jobId", "jobRootDir", "workspacePath"] as const)("refuses a changed %s binding", async field => {
    const other = { ...identity, [field]: identity[field] + "-changed" };
    expect(() => assertHostedTestEgressIdentity(parseHostedTestEgressGrant(grant()), other)).toThrow();
  });
  it.each([
    { schemaVersion: 2 }, { profileId: CodexProviderEgressProfileId.ProviderApi }, { profileId: "arbitrary" }, { domains: ["*"] },
    { approved: true }, { jobId: "" },
  ])("rejects malformed or extra authority fields: %j", delta => {
    expect(() => parseHostedTestEgressGrant({ ...grant(), ...delta })).toThrow();
  });
  it.each(["{broken", JSON.stringify({ domains: ["*"] })])("refuses malformed file contents without reflecting them", async contents => {
    await writeFile(filename(), contents, { mode: 0o600 });
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow("hosted_test_egress_grant_invalid");
  });
  it.each(["jobId", "jobRootDir", "workspacePath"] as const)("refuses %s mismatch through the file adapter", async field => {
    await writeFile(filename(), JSON.stringify({ ...grant(), [field]: identity[field] + "-other" }), { mode: 0o600 });
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow("grant_invalid");
  });
  it("refuses a traversing directory tuple and any workspace containing the authority root", async () => {
    await expect(canonicalHostedTestIdentity({ ...identity, workspacePath: root + "/workspace/../workspace" })).rejects.toThrow();
    await expect(canonicalHostedTestIdentity({ ...identity, workspacePath: "/" })).rejects.toThrow();
  });
  it("refuses file/parent symlinks and hard links", async () => {
    const other = join(root, "other.json");
    await writeFile(other, JSON.stringify(grant()), { mode: 0o600 });
    await symlink(other, filename());
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow();
    await rm(filename()); await link(other, filename());
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow();
    await rm(authority, { recursive: true }); await symlink(root, authority);
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow();
  });
  it("refuses writable authority and oversized records", async () => {
    await writeFile(filename(), JSON.stringify(grant()), { mode: 0o666 }); await chmod(filename(), 0o666);
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow();
    await chmod(filename(), 0o600); await writeFile(filename(), " ".repeat(4097));
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow();
    await chmod(authority, 0o777);
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow();
  });
  it("refuses a substituted workspace symlink", async () => {
    const other = join(root, "replacement"); await mkdir(other);
    await rm(identity.workspacePath, { recursive: true }); await symlink(other, identity.workspacePath);
    await expect(canonicalHostedTestIdentity(identity)).rejects.toThrow();
  });
  it("refuses a real rename-capable identity ancestor and its intermediate symlink replacement", async () => {
    const parent = join(root, "identities");
    const branch = join(parent, "branch");
    const replacement = join(root, "replacement");
    await mkdir(branch, { recursive: true }); await mkdir(replacement);
    await mkdir(join(branch, "workspace")); await mkdir(join(replacement, "workspace"));
    identity.workspacePath = join(branch, "workspace");
    await writeFile(filename(), JSON.stringify(grant()), { mode: 0o600 });
    await chmod(parent, 0o777); // This permits the review's untrusted local rename.
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow("grant_invalid");
    await rename(branch, join(parent, "old")); await symlink(replacement, branch);
    await chmod(parent, 0o755);
    // Final workspace is still a real directory, but its intermediate symlink refuses.
    await expect(readHostedTestEgressGrantFile(authority, identity, uid)).rejects.toThrow("grant_invalid");
  });
  it("rejects hosted namespace UID before any operator file writes", async () => {
    if (!process.getuid) return;
    vi.spyOn(process, "getuid").mockReturnValue(65532);
    await expect(assertHostedTestEgressOperator()).rejects.toThrow("host_operator_required");
  });
  it("does not turn a generic config/env profile into executor authority", () => {
    const options = buildCodexGoalExecutorOptions({
      config: {
        ...identity, taskId: identity.jobId, promptPath: join(root, "prompt"),
        authRootDir: join(root, "synthetic-auth"), accounts: codexGoalAccountSlots(["fake"]),
        sourceEnv: { SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "codex-test-npm-qualification" },
      },
      stateRootDir: join(root, "synthetic-state"), encryptionKey: new Uint8Array(32),
    });
    expect(options.accounts[0]?.worker.providerEgressPolicy).toBeUndefined();
  });
});
