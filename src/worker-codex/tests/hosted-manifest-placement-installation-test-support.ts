import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { HostedManifestLimitsRevision, HostedManifestPlacementFailure,
  openHostedDependencyManifestPlacement } from "../hosted-dependency-manifest-placement";

/**
 * Expressly synthetic fixture projection, narrowed to ONE real kernel row. The suite maps the canonical scratch path onto a
 * private directory under the real TEST tmp bind mount, so the fd's genuine `mnt_id` selects the row of that real mount while the
 * canonical path lies outside its real `point`. Only that selected row (unique by id) is rewritten: its `point` becomes the
 * canonical scratch path and its `root` becomes the genuine physical subtree root of the mapped directory
 * (`root` joined with the real point-relative path). Id, device, options and every other row (including any alias) stay as the
 * kernel reported them, so the production same-device exposure check still runs against the true physical subtree.
 */
function projectScratchMount(mountInfo: string, mountId: string, canonical: string, physical: string, grantFamilies: readonly string[]): string {
  const rows = mountInfo.split("\n"), at = rows.flatMap((row, index) => row.split(" ")[0] === mountId ? [index] : []);
  if (at.length !== 1) throw new Error("TEST scratch mount row is not unique");
  const parts = rows[at[0]!]!.split(" "), root = parts[3], point = parts[4];
  if (!root || !point || !root.startsWith("/") || !point.startsWith("/") || /\\/.test(root + point) ||
    !(physical === point || physical.startsWith(point === "/" ? "/" : point + "/"))) throw new Error("TEST scratch mount row does not contain the mapped directory");
  if (rows.some(row => row.split(" ")[4] === canonical)) throw new Error("TEST canonical scratch point is already mounted");
  // Rewriting removes the real row from the table. That is only sound when the real mount exposes no granted family itself
  // (a "/" or "/tmp"-level mount would); otherwise the exposure is genuine and must not be projected away.
  const sealed = (path: string) => path === point || path.startsWith(point === "/" ? "/" : point + "/") || point.startsWith(path + "/");
  if (grantFamilies.some(sealed)) throw new Error("TEST scratch mount exposes a granted family; fixture projection refused");
  parts[3] = join(root, relative(point, physical)); parts[4] = canonical;
  rows[at[0]!] = parts.join(" ");
  return rows.join("\n");
}

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
        // Read after the descriptor is held, so the row and the fd's genuine mnt_id come from one observation window.
        fixture.manifestMountInfo = projectScratchMount(real.readFileSync("/proc/self/mountinfo", "utf8"), mountId,
          manifestScratch, real.realpathSync(local(manifestScratch)),
          ["/usr", "/opt", "/etc", "/var", "/run", "/home", "/tmp", "/dev", "/proc", "/sys", runtimeDirectory]);
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
    // The projection above must not hide forbidden same-device exposure: an alias row on the selected device that exposes either
    // the filesystem root or the exact projected physical subtree under a granted family still vetoes issuance.
    it.each(["filesystem-root alias", "alias of the projected scratch subtree"] as const)("still refuses a same-device %s after the fixture mount projection", async kind => {
      const scratchRoot = await prepareScratch(true);
      const row = fixture.manifestMountInfo.split("\n").find(line => line.split(" ")[0] === scratchRoot.mountId)?.split(" ");
      const device = row?.[2], physicalRoot = row?.[3];
      if (!device || !physicalRoot || row?.[4] !== manifestScratch) throw new Error("TEST projected scratch row unavailable");
      fixture.manifestMountInfo += `999999999 1 ${device} ${kind === "filesystem-root alias" ? "/" : physicalRoot} /usr/TEST-alias rw - TEST /dev/TEST rw\n`;
      expect(() => new HostedInstallationActivationStore().install()).toThrow("dependency_manifest_placement:unsupported");
      expect(() => read("dependency-manifest-placement.json")).toThrow();
      expect(readdirSync(local(manifestScratch))).toEqual([]);
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
