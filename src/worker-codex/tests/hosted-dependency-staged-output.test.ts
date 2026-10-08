import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DependencyTreeObservationStatus } from "@vioxen/subscription-runtime/worker-core";
import { observeDependencyTree } from "../../worker-local/dependency-environment/observe-dependency-tree";
import { hostedDependencyInstallerUid } from "../hosted-dependency-installer-identity";
import { hostedDependencyObservationLimits } from "../hosted-dependency-materialization";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "../hosted-dependency-staged-output";
import { captureNpmLocalClosure } from "../../worker-local/dependency-environment/capture-npm-local-closure";
import { NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { openCapturedDependencySourceLinks, closeDependencySourceLinkSession } from "../../worker-local/dependency-environment/dependency-source-binding";

// Requires real root in an isolated Linux TEST job, not mocked uid evidence.
// Wrong recipe UID or path-only following of a substituted link makes this red.
describe.skipIf(process.platform !== "linux" || process.geteuid?.() !== 0)("captured fresh installer output effects", () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
  async function captured(mode = 0o640) {
    root = mkdtempSync(join(tmpdir(), "TEST-dependency-stage-"));
    const staging = join(root, "staging"), target = join(root, "workspace"), tree = join(staging, "node_modules");
    mkdirSync(staging, { mode: 0o700 }); mkdirSync(target, { mode: 0o700 }); mkdirSync(tree, { mode: 0o755 });
    const raw = Buffer.concat([Buffer.from(tree + "/"), Buffer.from([0xff, 0x61])]);
    writeFileSync(raw, "independent TEST dependency bytes\n", { mode });
    chmodSync(raw, mode);
    chownSync(raw, hostedDependencyInstallerUid, hostedDependencyInstallerUid);
    chownSync(tree, hostedDependencyInstallerUid, hostedDependencyInstallerUid);
    writeFileSync(join(target, "dirty-source"), "retain dirty source\n", { mode: 0o640 });
    const observation = await observeDependencyTree({ workspacePath: staging, treeName: "node_modules", limits: hostedDependencyObservationLimits });
    if (observation.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST capture incomplete");
    const stat = lstatSync(target, { bigint: true });
    return { observation, raw, target, workspace: { canonicalPath: target, dev: String(stat.dev), ino: String(stat.ino) } };
  }
  it("normalizes actual installer UID, preserves raw-name contents/mode, then publishes only into absence", async () => {
    const fixture = await captured();
    normalizeCapturedDependencyOutput(fixture.observation, 0);
    expect(lstatSync(fixture.raw).uid).toBe(0); expect(lstatSync(fixture.raw).mode & 0o777).toBe(0o640);
    expect(readFileSync(fixture.raw, "utf8")).toBe("independent TEST dependency bytes\n");
    publishCapturedDependencyOutput(fixture.observation, fixture.workspace);
    const published = Buffer.concat([Buffer.from(fixture.target + "/node_modules/"), Buffer.from([0xff, 0x61])]);
    expect(readFileSync(published, "utf8")).toBe("independent TEST dependency bytes\n");
    expect(readFileSync(join(fixture.target, "dirty-source"), "utf8")).toBe("retain dirty source\n");
  });
  it("unsafe captured mode refuses before ownership writes and preserves original stage", async () => {
    const fixture = await captured(0o666);
    expect(() => normalizeCapturedDependencyOutput(fixture.observation, 0)).toThrow("dependency_admission:unsafe_tree");
    expect(lstatSync(fixture.raw).uid).toBe(hostedDependencyInstallerUid);
    expect(readFileSync(fixture.raw, "utf8")).toBe("independent TEST dependency bytes\n");
  });
  it("new external destination symlink is retained without changing its TEST sentinel", async () => {
    const fixture = await captured(), external = join(root!, "external-TEST");
    mkdirSync(external); writeFileSync(join(external, "sentinel"), "outside remains\n");
    symlinkSync(external, join(fixture.target, "node_modules"));
    expect(() => publishCapturedDependencyOutput(fixture.observation, fixture.workspace)).toThrow();
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("outside remains\n");
    expect(readFileSync(fixture.raw, "utf8")).toBe("independent TEST dependency bytes\n");
    expect(lstatSync(join(fixture.target, "node_modules")).isSymbolicLink()).toBe(true);
  });
});

// Actual TEST source/capture/observation/effects; no installer/owner/Ready permit.
// Removing session validation, trusting copied original inode IDs for the stage,
// or skipping the current raw link makes these regressions observable.
describe.skipIf(process.platform !== "linux" || process.geteuid?.() !== 0)("local staged source mapping effects", () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
  async function fixture() {
    root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-local-output-mapping-")));
    const workspace = join(root, "workspace"), staging = join(root, "staging");
    mkdirSync(workspace, { mode: 0o700 }); mkdirSync(staging, { mode: 0o755 });
    const pkg = { name: "test-local-output", version: "1.0.0", private: true, workspaces: ["packages/a"], dependencies: { a: "*" } };
    const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: {
      "": { name: pkg.name, version: pkg.version, workspaces: pkg.workspaces, dependencies: pkg.dependencies },
      "packages/a": { name: "a", version: "1.0.0" }, "node_modules/a": { resolved: "packages/a", link: true } } };
    for (const path of [workspace, staging]) {
      mkdirSync(join(path, "packages"), { mode: 0o755 }); mkdirSync(join(path, "packages/a"), { mode: 0o755 });
      writeFileSync(join(path, "package.json"), JSON.stringify(pkg), { mode: 0o644 });
      writeFileSync(join(path, "package-lock.json"), JSON.stringify(lock), { mode: 0o644 });
      writeFileSync(join(path, "packages/a/package.json"), JSON.stringify({ name: "a", version: "1.0.0", main: "code.js" }), { mode: 0o644 });
    }
    writeFileSync(join(workspace, "packages/a/code.js"), "original live source\n", { mode: 0o644 });
    writeFileSync(join(workspace, "dirty-ignored-TEST"), "retain independent authored input\n", { mode: 0o640 });
    const captured = await captureNpmLocalClosure({ workspacePath: workspace, maxInputBytes: 1024 * 1024,
      maxEntries: 2048, maxPackages: 16, maxDurationMs: 10000 });
    if (captured.status !== NpmInputCaptureStatus.Qualified) throw new Error("TEST source mapping capture refused");
    mkdirSync(join(staging, "node_modules"), { mode: 0o755 });
    const generated = join(staging, "node_modules/generated.txt"), link = join(staging, "node_modules/a");
    writeFileSync(generated, "independent generated bytes\n", { mode: 0o644 }); symlinkSync("../packages/a", link);
    chownSync(generated, hostedDependencyInstallerUid, hostedDependencyInstallerUid);
    chownSync(join(staging, "node_modules"), hostedDependencyInstallerUid, hostedDependencyInstallerUid);
    const stat = lstatSync(staging, { bigint: true }), stageWorkspace = { canonicalPath: staging, dev: String(stat.dev), ino: String(stat.ino) };
    const stagedSession = openCapturedDependencySourceLinks(captured, stageWorkspace), originalSession = openCapturedDependencySourceLinks(captured);
    const observation = await observeDependencyTree({ workspacePath: staging, expectedWorkspace: stageWorkspace,
      treeName: "node_modules", sourceLinkSession: stagedSession, limits: hostedDependencyObservationLimits });
    if (observation.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST source mapping observation incomplete");
    return { workspace, staging, generated, link, captured, observation, stagedSession, originalSession,
      close() { closeDependencySourceLinkSession(stagedSession); closeDependencySourceLinkSession(originalSession); } };
  }
  it("requires the captured v2 mapping and preserves exact source link/content across physical publication", async () => {
    const f = await fixture();
    try {
      expect(() => normalizeCapturedDependencyOutput(f.observation, 0)).toThrow("dependency_admission:unsafe_tree");
      expect(lstatSync(f.generated).uid).toBe(hostedDependencyInstallerUid);
      normalizeCapturedDependencyOutput(f.observation, 0, f.stagedSession);
      const normalized = await observeDependencyTree({ workspacePath: f.staging, expectedWorkspace: f.observation.workspace,
        expectedTree: f.observation.tree, treeName: "node_modules", sourceLinkSession: f.stagedSession, limits: hostedDependencyObservationLimits });
      if (normalized.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST normalized observation incomplete");
      publishCapturedDependencyOutput(normalized, f.captured.workspace, { staged: f.stagedSession, original: f.originalSession });
      const final = await observeDependencyTree({ workspacePath: f.workspace, expectedWorkspace: f.captured.workspace,
        expectedTree: f.observation.tree, treeName: "node_modules", sourceLinkSession: f.originalSession, limits: hostedDependencyObservationLimits });
      if (final.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST original observation incomplete");
      expect(Buffer.from(final.canonicalBytes).equals(Buffer.from(f.observation.canonicalBytes))).toBe(true);
      expect(lstatSync(join(f.workspace, "node_modules/generated.txt")).uid).toBe(0);
      expect(readFileSync(join(f.workspace, "node_modules/generated.txt"), "utf8")).toBe("independent generated bytes\n");
      expect(readlinkSync(join(f.workspace, "node_modules/a"))).toBe("../packages/a");
      expect(readFileSync(join(f.workspace, "packages/a/code.js"), "utf8")).toBe("original live source\n");
      expect(readFileSync(join(f.workspace, "dirty-ignored-TEST"), "utf8")).toBe("retain independent authored input\n");
    } finally { f.close(); }
  });
  it("same-byte staged source directory substitution denies normalization before ownership effects", async () => {
    const f = await fixture();
    try {
      renameSync(join(f.staging, "packages/a"), join(f.staging, "packages/old-a"));
      mkdirSync(join(f.staging, "packages/a"), { mode: 0o755 });
      writeFileSync(join(f.staging, "packages/a/package.json"), readFileSync(join(f.staging, "packages/old-a/package.json")), { mode: 0o644 });
      expect(() => normalizeCapturedDependencyOutput(f.observation, 0, f.stagedSession)).toThrow();
      expect(lstatSync(f.generated).uid).toBe(hostedDependencyInstallerUid);
      expect(readFileSync(join(f.workspace, "packages/a/code.js"), "utf8")).toBe("original live source\n");
    } finally { f.close(); }
  });
  it("substituted raw link refuses without following or modifying the external TEST target", async () => {
    const f = await fixture();
    try {
      const external = join(root!, "external-TEST"); mkdirSync(external, { mode: 0o700 });
      writeFileSync(join(external, "sentinel"), "external independent bytes\n", { mode: 0o640 });
      unlinkSync(f.link); symlinkSync(external, f.link);
      expect(() => normalizeCapturedDependencyOutput(f.observation, 0, f.stagedSession)).toThrow("dependency_admission:unsafe_tree");
      expect(readlinkSync(f.link)).toBe(external);
      expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("external independent bytes\n");
      expect(lstatSync(join(external, "sentinel")).mode & 0o777).toBe(0o640);
      expect(readFileSync(join(f.workspace, "dirty-ignored-TEST"), "utf8")).toBe("retain independent authored input\n");
    } finally { f.close(); }
  });
  it("original source inode swap after normalization holds the entire stage instead of exposing it", async () => {
    const f = await fixture();
    try {
      normalizeCapturedDependencyOutput(f.observation, 0, f.stagedSession);
      renameSync(join(f.workspace, "packages/a"), join(f.workspace, "packages/old-a"));
      mkdirSync(join(f.workspace, "packages/a"), { mode: 0o755 });
      writeFileSync(join(f.workspace, "packages/a/package.json"), readFileSync(join(f.workspace, "packages/old-a/package.json")), { mode: 0o644 });
      expect(() => publishCapturedDependencyOutput(f.observation, f.captured.workspace,
        { staged: f.stagedSession, original: f.originalSession })).toThrow();
      expect(() => lstatSync(join(f.workspace, "node_modules"))).toThrow();
      expect(readFileSync(f.generated, "utf8")).toBe("independent generated bytes\n");
      expect(readFileSync(join(f.workspace, "packages/old-a/code.js"), "utf8")).toBe("original live source\n");
    } finally { f.close(); }
  });
});
