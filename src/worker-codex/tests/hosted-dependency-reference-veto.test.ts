import { describe, expect, it } from "vitest";
import { observeHostedDependencyMountReferences } from "../hosted-dependency-reference-veto";

const tree = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-alias/workspace/node_modules";
const trash = "/var/lib/subscription-runtime-host-policy/dependency-trash/dependency-TEST-alias";
const roots = [tree, trash];
const row = (id: number, device: string, root: string, point: string): string =>
  `${id} 1 ${device} ${root} ${point} rw,relatime - ext4 /dev/TEST rw\n`;
const primary = row(40, "8:1", "/", "/");

// Actual production mount-analysis boundary, with finite synthetic TEST
// mountinfo facts. This is not kernel namespace or mutation-authority proof.
describe("dependency namespace mount/reference veto", () => {
  it("permits the canonical primary mapping and unrelated different-device mounts", () => {
    const observed = primary + row(41, "8:2", "/", "/unrelated");
    const observation = observeHostedDependencyMountReferences(primary, observed, roots);
    expect(observation.references("/")).toBe(false);
    expect(observation.references("/unrelated" + tree + "/pkg/a.js")).toBe(false);
    expect(observation.references(tree + "/pkg/a.js")).toBe(true);
    expect(observation.references(trash + "/pkg/a.js (deleted)")).toBe(true);
  });

  it.each(["cwd", "fd", "maps"])("refuses a full-filesystem alias carrying a retiring-tree %s reference", () => {
    // The previous root !== '/' exclusion would accept the alias mount and
    // miss every lexical /alias/... reference despite the same backing device.
    const alias = primary + row(42, "8:1", "/", "/alias");
    const actualAliasPath = "/alias" + tree + "/pkg/a.js";
    expect(() => {
      const observation = observeHostedDependencyMountReferences(primary, alias, roots);
      if (observation.references(actualAliasPath)) throw new Error("retiring TEST reference");
    }).toThrow("dependency_reference_observation_unresolved");
  });

  it("preserves the actual nspawn primary subdirectory mapping without granting another alias", () => {
    const own = row(50, "8:1", "/machines/TEST-root", "/");
    // Namespace mount IDs can differ; exact device/root/point mapping is factual.
    const observed = row(60, "8:1", "/machines/TEST-root", "/") + row(61, "8:2", "/", "/run");
    const observation = observeHostedDependencyMountReferences(own, observed, roots);
    expect(observation.references("/usr/bin/node")).toBe(false);
    expect(observation.references(tree + "/pkg/a.js")).toBe(true);
    expect(() => observeHostedDependencyMountReferences(own, observed + row(62, "8:1", "/machines/TEST-root", "/alias"), roots)).toThrow();
    expect(() => observeHostedDependencyMountReferences(own, observed + row(62, "8:1", "/", "/alias"), roots)).toThrow();
  });

  it("vetoes a mount on the retiring tree and ambiguous primary mappings", () => {
    expect(() => observeHostedDependencyMountReferences(primary, primary + row(70, "8:2", "/", tree), roots)).toThrow();
    expect(() => observeHostedDependencyMountReferences(primary, primary + row(71, "8:1", "/", "/"), roots)).toThrow();
  });
  it("retains a collector-rendered proc reference outside a reader's different RootDirectory", () => {
    // proc d_path can return the collector-root rendering for a retained FD
    // outside the reader's chroot. PID-only translation would miss this path.
    const foreignRoot = row(80, "8:1", "/machines/TEST-other-root", "/");
    const observation = observeHostedDependencyMountReferences(primary, foreignRoot, roots);
    expect(observation.references(tree + "/pkg/held.js")).toBe(true);
    expect(observation.references(trash + "/pkg/held.js (deleted)")).toBe(true);
    expect(observation.references("/usr/bin/node")).toBe(false);
  });
});
