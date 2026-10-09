import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readReadonlyReview } from "../hosted-readonly-authority";
import * as privateInputs from "../hosted-readonly-inputs";
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
    it.each(["unknown-version", "legacy-backing", "full-ordinary", "missing-contract", "wrong-contract", "extra", "noncanonical", "sha", "manifest"])
      ("actual readonly review rejects invalid stage %s without publishing authority", fault => {
        // Reuse this suite's existing modeled OS facts and actual private files.
        // No decoded FULL result, operator decision or physical authority is mocked.
        const policy = privateInputs.parseHostedReadonlyPolicy({ schemaVersion: 1, jobId: "TEST-stage-review", jobRootDir: "/jobs/TEST-stage-review",
          workspacePath: "/managed/W", runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
          issuerDeploymentDigest: "c".repeat(64), readonlyPaths: ["/managed/W/input"] });
        const name = createHash("sha256").update(policy.jobId).digest("hex") + ".json";
        put("reviews/" + name, { schemaVersion: 1, policy, corepackShim: null, reviewReference: "TEST reviewed DATA", custodyReference: "TEST custody DATA" });
        const reviewPath = join(fixture.root, "reviews", name), reviewBytes = readFileSync(reviewPath);
        const stageName = "stages/" + createHash("sha256").update(runtimeDirectory).digest("hex") + ".json";
        const stagePath = join(fixture.root, stageName), value = read(stageName);
        expect(readReadonlyReview(policy).stageBytes).toEqual(readFileSync(stagePath));
        const changed = fault === "unknown-version" ? { ...value, schemaVersion: 3 }
          : fault === "legacy-backing" ? { ...value, backingInterval: "original_full_parent_proc_v1" }
          : fault === "full-ordinary" ? { ...value, schemaVersion: 2, backingInterval: "original_full_parent_proc_v1" }
          : fault === "missing-contract" ? { ...value, schemaVersion: 2 }
          : fault === "wrong-contract" ? { ...value, schemaVersion: 2, backingInterval: "wrong" }
          : fault === "extra" ? { ...value, extra: true }
          : fault === "sha" ? { ...value, runtimeSha: "d".repeat(40) }
          : fault === "manifest" ? { ...value, runtimeManifestSha256: "d".repeat(64) } : value;
        const bytes = Buffer.from(JSON.stringify(changed, null, fault === "noncanonical" ? 2 : undefined) + "\n");
        writeFileSync(stagePath, bytes, { mode: 0o600 });
        expect(() => readReadonlyReview(policy)).toThrow("hosted_readonly_authority_invalid");
        expect(readFileSync(stagePath)).toEqual(bytes); expect(readFileSync(reviewPath)).toEqual(reviewBytes);
        expect(() => read("host-installation.json")).toThrow(); expect(() => read("readonly-epoch.json")).toThrow();
      });
    it("actual readonly review rejects held bytes replaced by a valid decoder reread", async () => {
      const policy = privateInputs.parseHostedReadonlyPolicy({ schemaVersion: 1, jobId: "TEST-stage-drift", jobRootDir: "/jobs/TEST-stage-drift",
        workspacePath: "/managed/W", runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
        issuerDeploymentDigest: "c".repeat(64), readonlyPaths: ["/managed/W/input"] });
      const name = createHash("sha256").update(policy.jobId).digest("hex") + ".json";
      put("reviews/" + name, { schemaVersion: 1, policy, corepackShim: null, reviewReference: "TEST reviewed DATA", custodyReference: "TEST custody DATA" });
      const stageName = "stages/" + createHash("sha256").update(runtimeDirectory).digest("hex") + ".json";
      const path = join(fixture.root, stageName), value = read(stageName), canonical = Buffer.from(JSON.stringify(value) + "\n");
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      const selectedPath = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + stageName.slice("stages/".length);
      const actual = privateInputs.readHostedPrivateBytes, real = await vi.importActual<typeof import("node:fs")>("node:fs");
      let reads = 0;
      const spy = vi.spyOn(privateInputs, "readHostedPrivateBytes").mockImplementation((selected, bound) => {
        const bytes = actual(selected, bound);
        if (selected === selectedPath && ++reads === 1) real.writeFileSync(path, canonical, { mode: 0o600 });
        return bytes;
      });
      try {
        expect(() => readReadonlyReview(policy)).toThrow("hosted_readonly_authority_invalid");
        expect(reads).toBe(2); expect(readFileSync(path)).toEqual(canonical);
        expect(() => read("host-installation.json")).toThrow(); expect(() => read("readonly-epoch.json")).toThrow();
      } finally { spy.mockRestore(); }
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
