import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { HostedManifestLimitsRevision, HostedManifestPlacementFailure,
  openHostedDependencyManifestPlacement } from "../hosted-dependency-manifest-placement";

/** Register in the ordinary installation suite to retain its real private I/O,
 * installation/fence/kernel composition and explicitly synthetic host facts. */
export function registerManifestPlacementInstallationTests({ fixture, root, manifestScratch, runtimeDirectory, local, put, read }: {
  readonly fixture: { root: string; boot: string; manifestMountInfo: string };
  readonly root: string;
  readonly manifestScratch: string;
  readonly runtimeDirectory: string;
  readonly local: (path: string) => string;
  readonly put: (name: string, value: unknown) => void;
  readonly read: {
    (name: "dependency-manifest-placement.json"): {
      installation: { installationId: string }; scratchRoot: unknown; blobs: { canonicalPath: string };
    };
    (name: string): Record<string, unknown>;
  };
}): void {
  describe.skipIf(process.platform !== "linux")("actual fresh installation manifest-placement hook", () => {
    async function prepareScratch(configured: boolean) {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      fixture.manifestMountInfo = real.readFileSync("/proc/self/mountinfo", "utf8");
      mkdirSync(local(manifestScratch), { mode: 0o700 });
      const jobId = "TEST-manifest-placement", jobRootDir = root + "/dependency-test-jobs/jobs/" + jobId;
      const launch = { command: process.execPath, args: [runtimeDirectory + "/dist/worker-codex/codex-goal-cli.js", "run",
        "--task-id", jobId, "--job-root", jobRootDir, "--workspace", jobRootDir + "/workspace"], cwd: jobRootDir + "/workspace" };
      put("readonly-inventory.json", { ...read("readonly-inventory.json"), runtimeLaunch: launch,
        ordinaryCreators: [{ creatorId: "TEST-manifest-creator", jobId, jobRootDir, workspacePath: launch.cwd, launch }] });
      const fd = openSync(manifestScratch, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd, { bigint: true });
        const mountId = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(real.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
        if (!mountId) throw new Error("TEST scratch mount identity unavailable");
        const scratchRoot = { canonicalPath: manifestScratch, dev: String(stat.dev), ino: String(stat.ino), mountId };
        if (configured) put("dependency-manifest-storage-policy.json", { version: 1, scratchRoot, bootId: fixture.boot,
          limitsRevision: HostedManifestLimitsRevision.TestUnqualifiedV1 });
        return scratchRoot;
      } finally { closeSync(fd); }
    }
    it("issues scratch placement through install and preserves source and legacy-root bytes", async () => {
      // Red if createInstallation drops the issuer hook: no placement exists and
      // the real factory refuses. Direct issuer tests do not cover this call site.
      const scratchRoot = await prepareScratch(true), source = join(fixture.root, "managed-W/input/TEST-source");
      writeFileSync(source, "TEST original source", { mode: 0o600 });
      new HostedInstallationActivationStore().install();
      const placement = read("dependency-manifest-placement.json");
      expect(placement.installation).toEqual(read("host-installation.json")); expect(placement.scratchRoot).toEqual(scratchRoot);
      expect(placement.blobs.canonicalPath).toBe(manifestScratch + "/dependency-manifests/" + placement.installation.installationId);
      mkdirSync(join(fixture.root, "dependency-manifests"), { mode: 0o700 });
      const legacy = join(fixture.root, "dependency-manifests/TEST-retained"); writeFileSync(legacy, "TEST old blob bytes", { mode: 0o600 });
      const store = await openHostedDependencyManifestPlacement(), bytes = Buffer.from("TEST hook manifest bytes");
      let digest: string;
      try { digest = await store.put(bytes); expect(await store.get(digest)).toEqual(bytes); } finally { await store.close(); }
      withHostedActivationFence(fence => store.assertCurrent(fence));
      expect(readdirSync(local(placement.blobs.canonicalPath))).toEqual([digest + ".gz"]);
      expect(readdirSync(join(fixture.root, "dependency-manifests"))).toEqual(["TEST-retained"]);
      expect(readFileSync(legacy, "utf8")).toBe("TEST old blob bytes"); expect(readFileSync(source, "utf8")).toBe("TEST original source");
    });
    it("preserves unmanaged install without manufacturing placement or falling back to legacy blobs", async () => {
      await prepareScratch(false); new HostedInstallationActivationStore().install();
      mkdirSync(join(fixture.root, "dependency-manifests"), { mode: 0o700 });
      const legacy = join(fixture.root, "dependency-manifests/TEST-retained"); writeFileSync(legacy, "TEST legacy original", { mode: 0o600 });
      await expect(openHostedDependencyManifestPlacement()).rejects.toMatchObject({ reason: HostedManifestPlacementFailure.Unsupported });
      expect(readdirSync(local(manifestScratch))).toEqual([]);
      expect(() => read("dependency-manifest-placement.json")).toThrow();
      expect(readFileSync(legacy, "utf8")).toBe("TEST legacy original");
    });
  });
}
