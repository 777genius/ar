import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexModelBackend } from "../codex-model-backend";
import { CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { HostedMimoProfile } from "../hosted-mimo-profile";
import { readProviderHostedMimoGrantAtPath } from "../app-server/adapters/hosted-process-activation";

describe("independent provider MiMo grant reader", () => {
  it("binds a private file to its retained digest and exact provider profile", async () => {
    // Regression: a rotated grant or changed profile must fail before a child spawn.
    const root = await mkdtemp(join(process.cwd(), ".synthetic-provider-mimo-grant-"));
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
      const changed = Buffer.from(JSON.stringify({ ...grant, accountId: "account-x" }) + "\n");
      await writeFile(path, changed, { mode: 0o600 });
      expect(() => readProviderHostedMimoGrantAtPath(path, identity, digest(first))).toThrow();
      expect(() => readProviderHostedMimoGrantAtPath(path, identity, digest(changed))).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
