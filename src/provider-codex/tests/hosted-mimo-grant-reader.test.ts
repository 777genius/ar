import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "../codex-model-backend";
import { CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { HostedMimoProfile } from "../hosted-mimo-profile";
import { assertProviderHostedMimoGrant, readProviderHostedMimoGrantAtPath } from "../app-server/adapters/hosted-process-activation";

const syntheticOwner = vi.hoisted(() => ({ root: "", fileUid: 0 }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (path: string) => {
      const stat = fs.lstatSync(path);
      const ancestor = syntheticOwner.root !== "" &&
        syntheticOwner.root.startsWith(path.endsWith("/") ? path : `${path}/`);
      const within = syntheticOwner.root !== "" &&
        (path === syntheticOwner.root || path.startsWith(`${syntheticOwner.root}/`));
      return ancestor || within
        ? Object.assign(stat, { uid: 0, mode: ancestor ? stat.mode & ~0o022 : stat.mode })
        : stat;
    },
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: syntheticOwner.fileUid }),
  };
});

describe("independent provider MiMo grant reader", () => {
  // Bug: the independent provider reader hardcodes historical account-q for a new inventory-approved slot.
  it("accepts schema 3 account-s without translating schema 2 or accepting a controller slot", () => {
    const identity = { jobId: "test-child", jobRootDir: "/test/jobs/test-child", workspacePath: "/test/jobs/test-child/workspace" };
    const grant = { schemaVersion: 3, ...identity, slotId: "finite-slot-1", accountId: "account-s",
      profileId: CodexProviderEgressProfileId.MimoTokenPlan, hostedProfile: HostedMimoProfile.Child,
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, executionEngine: "app-server-goal",
      namedPermissions: true, globalScanGuard: true, nativeToolSurface: "disabled" };
    expect(() => assertProviderHostedMimoGrant(grant, identity)).not.toThrow();
    expect(() => assertProviderHostedMimoGrant({ ...grant, hostedProfile: HostedMimoProfile.Controller }, identity)).toThrow();
    const { slotId, ...legacy } = grant;
    expect(() => assertProviderHostedMimoGrant({ ...legacy, schemaVersion: 2 }, identity)).toThrow();
    expect(() => assertProviderHostedMimoGrant({ ...grant, credentialPath: "/test/private-key" }, identity)).toThrow();
  });

  it("binds a private file to its retained digest and exact provider profile", async () => {
    // Regression: a rotated grant or changed profile must fail before a child spawn.
    const root = await mkdtemp(join(process.cwd(), ".synthetic-provider-mimo-grant-"));
    // Real bytes, modes and file operations remain in use; only synthetic
    // ownership and checkout ancestry metadata are normalized for user CI.
    syntheticOwner.root = root;
    try {
      const authority = join(root, "authority");
      await mkdir(authority, { mode: 0o700 });
      const path = join(authority, "grant.json");
      const identity = { jobId: "synthetic-job", jobRootDir: "/synthetic/job",
        workspacePath: "/synthetic/job/workspace" };
      const grant = { schemaVersion: 2, ...identity,
        profileId: CodexProviderEgressProfileId.MimoTokenPlan,
        accountId: "account-q", hostedProfile: HostedMimoProfile.Child,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        executionEngine: "app-server-goal", namedPermissions: true,
        globalScanGuard: true, nativeToolSurface: "disabled" };
      const first = Buffer.from(JSON.stringify(grant) + "\n");
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      await writeFile(path, first, { mode: 0o600 });
      expect(() => readProviderHostedMimoGrantAtPath(path, identity, digest(first))).not.toThrow();
      syntheticOwner.fileUid = 1;
      expect(() => readProviderHostedMimoGrantAtPath(path, identity, digest(first))).toThrow();
      syntheticOwner.fileUid = 0;
      const changed = Buffer.from(JSON.stringify({ ...grant, accountId: "account-x" }) + "\n");
      await writeFile(path, changed, { mode: 0o600 });
      expect(() => readProviderHostedMimoGrantAtPath(path, identity, digest(first))).toThrow();
      expect(() => readProviderHostedMimoGrantAtPath(path, identity, digest(changed))).toThrow();
    } finally {
      syntheticOwner.root = "";
      syntheticOwner.fileUid = 0;
      await rm(root, { recursive: true, force: true });
    }
  });
});
