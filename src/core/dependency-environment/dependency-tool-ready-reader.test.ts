import { describe, expect, it } from "vitest";
import { DependencyToolReadyProvenanceKind, matchesRegistryDependencyToolReady,
  type DependencyToolReadyFacts, type DependencyToolReadyIdentity } from "./dependency-tool-ready-reader";

describe("registry tool Ready identity join", () => {
  // A omitted comparison would release a provider against a different Ready
  // generation/tree/key while the protected qualification still names the old one.
  const expected: DependencyToolReadyIdentity = {
    workspace: { canonicalPath: "/srv/jobs/example/workspace", dev: "8", ino: "100" },
    coverageRevision: "coverage-a", revision: 4, installKey: "install-a",
    tree: { dev: "8", ino: "200" }, manifestDigest: "manifest-a",
  };
  const ready: DependencyToolReadyFacts = {
    ...expected, provenance: { kind: DependencyToolReadyProvenanceKind.RegistryCompleted },
  };
  it("joins every physical and committed Ready identity, independently of provider configuration", () => {
    expect(matchesRegistryDependencyToolReady(expected, ready)).toBe(true);
    const changed: DependencyToolReadyFacts[] = [
      { ...ready, workspace: { ...ready.workspace, canonicalPath: "/srv/jobs/other/workspace" } },
      { ...ready, workspace: { ...ready.workspace, dev: "9" } },
      { ...ready, workspace: { ...ready.workspace, ino: "101" } },
      { ...ready, coverageRevision: "coverage-b" }, { ...ready, revision: 5 },
      { ...ready, installKey: "install-b" }, { ...ready, tree: { dev: "9", ino: "200" } },
      { ...ready, tree: { dev: "8", ino: "201" } }, { ...ready, manifestDigest: "manifest-b" },
    ];
    for (const facts of changed) expect(matchesRegistryDependencyToolReady(expected, facts)).toBe(false);
  });
  it("does not enable local consumer authority merely because its key/tree match", () => {
    expect(matchesRegistryDependencyToolReady(expected, {
      ...expected, provenance: { kind: DependencyToolReadyProvenanceKind.LocalCompleted,
        sourceBinding: { path: "/protected/source.json", identity: { dev: "8", ino: "300" }, sha256: "source-a" },
        readonlySources: [{ canonicalPath: "/srv/source", identity: { dev: "8", ino: "400" } }] },
    })).toBe(false);
  });
});
