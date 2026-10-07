import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DependencyTreeObservationStatus } from "@vioxen/subscription-runtime/worker-core";
import { observeDependencyTree } from "../../worker-local/dependency-environment/observe-dependency-tree";
import { hostedDependencyInstallerUid } from "../hosted-dependency-installer-identity";
import { hostedDependencyObservationLimits } from "../hosted-dependency-materialization";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "../hosted-dependency-staged-output";

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
