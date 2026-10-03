import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedTestEgressGrant } from "../hosted-test-egress-contract";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
const fs = vi.hoisted(() => ({ readFile: vi.fn(), readlink: vi.fn(), lstat: vi.fn(),
  mkdir: vi.fn(), open: vi.fn(), realpath: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", () => fs);
import { assertHostedTestEgressOperator, writeHostedTestEgressGrant,
  revokeHostedTestEgressGrant, hostedTestEgressGrantRoot } from "../hosted-test-egress-files";

describe("host operator namespace and publication adapter (mock files only)", () => {
  beforeEach(() => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    fs.readFile.mockResolvedValue("0 0 4294967295\n");
    fs.readlink.mockImplementation(async (path: string) => path.split("/").at(-1));
    fs.unlink.mockResolvedValue(undefined);
    fs.realpath.mockImplementation(async (path: string) => path);
    fs.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o700 });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
  it.each(["user", "mnt", "pid"])("rejects a differing observed %s namespace even with host UID and no env marker", async namespace => {
    fs.readlink.mockImplementation(async (path: string) => path === `/proc/self/ns/${namespace}` ? "different" : path.split("/").at(-1));
    await expect(revokeHostedTestEgressGrant("test")).rejects.toThrow("host_operator_required");
    expect(fs.unlink).not.toHaveBeenCalled(); expect(fs.open).not.toHaveBeenCalled();
  });
  it("rejects nested UID mapping and unavailable namespace observations", async () => {
    fs.readFile.mockResolvedValue("0 0 1\n");
    await expect(assertHostedTestEgressOperator()).rejects.toThrow("host_operator_required");
    fs.readFile.mockResolvedValue("0 0 4294967295\n");
    fs.readlink.mockRejectedValue(new Error("private path"));
    await expect(assertHostedTestEgressOperator()).rejects.toThrow("host_operator_required");
  });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification] as const)("publishes the finite record through exclusive temporary file, sync and atomic rename: %s", async profileId => {
    const file = { writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() };
    fs.open.mockResolvedValue(file);
    const grant: HostedTestEgressGrant = { schemaVersion: 1 as const, jobId: "exact", jobRootDir: "/synthetic/job",
      workspacePath: "/synthetic/workspace", profileId };
    await writeHostedTestEgressGrant(grant);
    expect(fs.open.mock.calls[0]).toEqual([expect.stringMatching(new RegExp(`^${hostedTestEgressGrantRoot}/[a-f0-9]{64}\\.json\\..*\\.tmp$`)), "wx", 0o600]);
    expect(file.writeFile).toHaveBeenCalledWith(JSON.stringify(grant) + "\n");
    expect(file.sync).toHaveBeenCalledOnce(); expect(file.close).toHaveBeenCalledOnce();
    expect(file.sync.mock.invocationCallOrder[0]).toBeLessThan(fs.rename.mock.invocationCallOrder[0]!);
    expect(fs.rename.mock.calls[0]?.[1]).toMatch(/\/[a-f0-9]{64}\.json$/);
    await revokeHostedTestEgressGrant("exact");
    expect(fs.unlink).toHaveBeenLastCalledWith(fs.rename.mock.calls[0]?.[1]);
  });
  it("validates filesystem root custody before creating missing authority parents", async () => {
    fs.lstat.mockResolvedValueOnce({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o777 });
    await expect(revokeHostedTestEgressGrant("exact")).rejects.toThrow("custody_invalid");
    expect(fs.lstat).toHaveBeenCalledWith("/"); expect(fs.unlink).not.toHaveBeenCalled();
  });
});
