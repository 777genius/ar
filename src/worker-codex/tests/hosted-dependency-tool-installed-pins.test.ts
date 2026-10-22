import { describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "../../core/dependency-environment/dependency-owner";
import { DependencyToolProfileId, DependencyToolTransformCache, dependencyToolPins,
  type DependencyToolProfile } from "../../core/dependency-environment/dependency-tool-profile";
import { assertHostedDependencyToolInstalledPins } from "../hosted-dependency-tool-installed-pins";

// Linux retained-directory traversal is the production boundary. These tests
// exercise real files; no owner epoch, installation or Running grant is forged.
describe.skipIf(process.platform !== "linux")("fixed dependency tool entry availability", () => {
  function fixture() {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "TEST-required-tool-entry-")));
    const tree = join(workspace, "node_modules");
    const packages = {
      "node_modules/vite": { version: "8.0.16", resolved: "https://registry.npmjs.org/vite/-/vite-8.0.16.tgz",
        integrity: "sha512-h9bXPmJichP5fLmVQo3PyaGSDE2n3aPuomeAlVRm0JLmt4rY6zmPKd59HYI4LNW8oTK7tlTsuC7l/m7awx9Jcw==" },
      "node_modules/vitest": { version: "4.1.8", resolved: "https://registry.npmjs.org/vitest/-/vitest-4.1.8.tgz",
        integrity: "sha512-flY6ScbCIt9HThs+C5HS7jvGOB560DJtk/Z15IQROTA6zEy49Nh8T/dofWTQL+n3vswqn87sbJNiuqw1SDp5Ig==" },
    };
    for (const [name, exports] of [
      ["vite", { ".": "./dist/node/index.js" }],
      ["vitest", { "./node": { types: "./dist/node.d.ts", default: "./dist/node.js" } }],
    ] as const) {
      mkdirSync(join(tree, name), { recursive: true });
      writeFileSync(join(tree, name, "package.json"), JSON.stringify({ name, version: dependencyToolPins[name], exports }));
    }
    const entries = ["vite/dist/node/index.js", "vitest/dist/node.js"] as const;
    for (const entry of entries) {
      mkdirSync(dirname(join(tree, entry)), { recursive: true });
      // Passing availability must not execute either module.
      writeFileSync(join(tree, entry), 'throw new Error("TEST must not execute this tool");\n');
    }
    mkdirSync(join(tree, "test-optimizer"));
    const sentinel = join(tree, "retained-unverified-partial"), bytes = "TEST pre-existing partial tree\n";
    writeFileSync(sentinel, bytes);
    const stat = lstatSync(workspace, { bigint: true });
    const profile: DependencyToolProfile = {
      version: 1, profileId: DependencyToolProfileId.ViteVitestConfigFreeV1, pins: dependencyToolPins,
      optimizerDependencies: ["test-optimizer"], testFiles: ["example.test.ts"], transformCache: DependencyToolTransformCache.Persisted,
      cache: { canonicalPath: workspace, dev: String(stat.dev), ino: String(stat.ino) },
      node: { path: "/TEST/node", sha256: "0".repeat(64) }, helper: { path: "/TEST/helper", sha256: "0".repeat(64) }, readonlyFiles: [],
    };
    return { workspace, tree, entries, profile, lock: Buffer.from(JSON.stringify({ packages })), sentinel, bytes };
  }
  it("reuses available entries without executing tools or changing the existing tree", () => {
    const f = fixture();
    try {
      expect(() => assertHostedDependencyToolInstalledPins(f.workspace, f.profile, f.lock)).not.toThrow();
      expect(readFileSync(f.sentinel, "utf8")).toBe(f.bytes);
    } finally { rmSync(f.workspace, { recursive: true, force: true }); }
  });
  it.each(["vite/dist/node/index.js", "vitest/dist/node.js"])("rejects intact metadata with missing %s", entry => {
    const f = fixture();
    try {
      const metadata = ["vite", "vitest"].map(name => readFileSync(join(f.tree, name, "package.json"), "utf8"));
      unlinkSync(join(f.tree, entry));
      expect(() => assertHostedDependencyToolInstalledPins(f.workspace, f.profile, f.lock))
        .toThrowError(new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported));
      expect(readFileSync(f.sentinel, "utf8")).toBe(f.bytes);
      expect(["vite", "vitest"].map(name => readFileSync(join(f.tree, name, "package.json"), "utf8"))).toEqual(metadata);
    } finally { rmSync(f.workspace, { recursive: true, force: true }); }
  });
  it("rejects an aliased entry even when resolution stays inside node_modules", () => {
    const f = fixture();
    try {
      const entry = join(f.tree, f.entries[0]);
      unlinkSync(entry); symlinkSync(join(f.tree, f.entries[1]), entry);
      expect(() => assertHostedDependencyToolInstalledPins(f.workspace, f.profile, f.lock))
        .toThrowError(new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported));
      expect(readFileSync(f.sentinel, "utf8")).toBe(f.bytes);
    } finally { rmSync(f.workspace, { recursive: true, force: true }); }
  });
});
