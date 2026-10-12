import { host, setupResearchFixture, cleanupResearchFixture, local } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn() }));
import { hostedMimoProjectRuntime } from "../hosted-mimo-project-runtime-routing";
import { createCodexGoalJob, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { protectedCodexGoalJobRuntimeProvenance, observeProtectedCodexGoalJobBirth, recordProtectedCodexGoalJobFirstEffect } from "../protected-job-birth";
import { researchArtifactDigest, researchAuthorityRoot, researchHash } from "../research-launch-files";
import { projectControlRefillWorkerFromSealedSource } from "../codex-goal-mcp-project-control-tool-handlers";

const metadata = "/etc/subscription-runtime/mimo-project-runtime-routing.json";
const original = "/opt/subscription-runtime/releases/" + "a".repeat(40), baseline = "/opt/subscription-runtime/releases/" + "b".repeat(40);
const binding = { registryRootDir: "/TEST-project/registry", controllerJobId: "TEST-controller" };
let job: CodexGoalJobManifest, lexical: string, physical: string;
function artifact(path: string): void {
  for (const name of ["dist", "host-integration", "node_modules"]) mkdirSync(join(path, name), { recursive: true, mode: 0o700 });
  writeFileSync(join(path, "package.json"), '{"type":"module"}', { mode: 0o600 });
  writeFileSync(join(path, "dist/TEST.js"), path, { mode: 0o600 });
}
function publishMetadata(overrides: Record<string, unknown> = {}): void {
  writeFileSync(metadata, JSON.stringify({ schemaVersion: 1, legacyRuntimeDirectory: baseline,
    legacyArtifactSha256: researchArtifactDigest(baseline), ...overrides }), { mode: 0o600 });
}
function retainedBirth(): void {
  const birth = JSON.parse(readFileSync(lexical, "utf8"));
  const bytes = JSON.stringify({ ...birth, runtimeDirectory: original, artifactSha256: researchArtifactDigest(original) });
  writeFileSync(lexical, bytes); writeFileSync(physical, bytes);
}
function loader() {
  const invoke = vi.fn(async (..._args: unknown[]) => {
    expect(existsSync(join(researchAuthorityRoot, "job-births/publication.lock"))).toBe(false);
    return { content: [{ type: "text", text: '{"ok":true}' }] };
  });
  const imports = vi.fn(async (_url: string): Promise<Record<string, unknown>> => ({
    projectControlRefillWorkerFromSealedSource: invoke, projectControlStartStoredJob: invoke, projectControlStopStoredJob: invoke,
    loadProjectControlController: invoke, loadJobLaunch: invoke, collectRegisteredCodexGoalJobStatus: invoke,
  }));
  return { invoke, imports };
}
beforeEach(async () => {
  const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  setupResearchFixture({ allocationParent: nativeFs.realpathSync(tmpdir()) });
  mkdirSync(join(metadata, ".."), { recursive: true, mode: 0o700 });
  artifact(original); artifact(baseline);
  mkdirSync(binding.registryRootDir, { recursive: true, mode: 0o700 });
  const workspacePath = "/TEST-project/workspaces/TEST-controller";
  mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
  job = await createCodexGoalJob({ registryRootDir: binding.registryRootDir, manifest: {
    jobId: binding.controllerJobId, taskId: binding.controllerJobId, jobRootDir: "/TEST-project/jobs/TEST-controller",
    workspacePath, promptPath: "/TEST-project/jobs/TEST-controller/prompt.md", accounts: ["TEST-a"],
  } });
  const stat = lstatSync(job.jobRootDir);
  lexical = join(researchAuthorityRoot, "job-births", researchHash(job.jobRootDir) + ".json");
  physical = join(researchAuthorityRoot, "job-births", `physical-${stat.dev}-${stat.ino}.json`);
});
afterEach(cleanupResearchFixture);
describe("trusted controller runtime routing", () => {
  it("keeps the local composition when operator routing metadata is absent", async () => {
    const port = loader();
    expect((await hostedMimoProjectRuntime(binding, port.imports)).projectControlRefillWorkerFromSealedSource).toBe(projectControlRefillWorkerFromSealedSource);
    expect(port.imports).not.toHaveBeenCalled();
  });
  it("selects exact witnessed original modules and preserves none/default arguments without holding publication", async () => {
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "released" });
    recordProtectedCodexGoalJobFirstEffect(job.jobRootDir);
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "unknown" });
    const effect = lexical.replace(/\.json$/, ".first-effect.json"), effectBytes = readFileSync(effect);
    retainedBirth(); publishMetadata(); const port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, port.imports);
    expect(port.imports.mock.calls.map(([url]) => fileURLToPath(url))).toEqual([
      original + "/dist/worker-codex/codex-goal-mcp-project-control-tool-handlers.js",
      original + "/dist/worker-codex/codex-goal-mcp-project-control-deps.js",
      original + "/dist/worker-codex/application/codex-goal-registered-job-observation.js",
    ]);
    await runtime.projectControlRefillWorkerFromSealedSource({ jobId: "TEST-child", reasoningEffort: "none" }, { resolveRevision: vi.fn() });
    await runtime.projectControlRefillWorkerFromSealedSource({ jobId: "TEST-child-default", reasoningEffort: "medium" }, { resolveRevision: vi.fn() });
    expect(port.invoke.mock.calls.map(([args]) => args)).toEqual([{ jobId: "TEST-child", reasoningEffort: "none" }, { jobId: "TEST-child-default", reasoningEffort: "medium" }]);
    expect(readFileSync(effect).equals(effectBytes)).toBe(true);
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "unknown" });
  });
  it.each(["missing", "physical", "manifest", "directory"])("uses only the verified operator baseline for %s provenance", async fault => {
    retainedBirth(); publishMetadata();
    if (fault === "missing") unlinkSync(lexical);
    if (fault === "physical") writeFileSync(physical, "{}");
    if (fault === "manifest") {
      const path = join(binding.registryRootDir, job.jobId, "job.json"); writeFileSync(path, readFileSync(path));
    }
    if (fault === "directory") { renameSync(job.jobRootDir, job.jobRootDir + "-old"); mkdirSync(job.jobRootDir, { mode: 0o700 }); }
    expect(protectedCodexGoalJobRuntimeProvenance(job, binding.registryRootDir)).toBeUndefined();
    const port = loader(); await hostedMimoProjectRuntime(binding, port.imports);
    expect(port.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(baseline + "/dist/"))).toBe(true);
    expect(port.invoke).not.toHaveBeenCalled();
  });
  it.each(["keys", "unsafe-mode", "foreign-owner", "path", "digest", "artifact"])("refuses retained %s metadata/material before importing code", async fault => {
    retainedBirth(); publishMetadata();
    if (fault === "keys") publishMetadata({ callerModule: "TEST" });
    if (fault === "unsafe-mode") chmodSync(local(metadata), 0o644);
    if (fault === "foreign-owner") host.foreign.add(metadata);
    if (fault === "path") publishMetadata({ legacyRuntimeDirectory: baseline + "/../" + "a".repeat(40) });
    if (fault === "digest") publishMetadata({ legacyArtifactSha256: "c".repeat(64) });
    if (fault === "artifact") writeFileSync(join(original, "dist/TEST.js"), "TEST tampered runtime");
    const port = loader(); await expect(hostedMimoProjectRuntime(binding, port.imports)).rejects.toThrow();
    expect(port.imports).not.toHaveBeenCalled(); expect(port.invoke).not.toHaveBeenCalled();
  });
  it.each(["metadata", "birth", "artifact"])("rechecks %s after imports and before every operation", async fault => {
    retainedBirth(); publishMetadata(); const port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, port.imports);
    const drift = () => {
      if (fault === "metadata") publishMetadata({ legacyArtifactSha256: "c".repeat(64) });
      if (fault === "birth") writeFileSync(physical, "{}");
      if (fault === "artifact") writeFileSync(join(original, "dist/TEST.js"), "TEST drift");
    };
    drift(); await expect(runtime.projectControlStartStoredJob({ jobId: "TEST-child" })).rejects.toThrow();
    expect(port.invoke).not.toHaveBeenCalled();
  });
  it("rejects a changed witness during import and missing fixed callable exports", async () => {
    retainedBirth(); publishMetadata();
    const port = loader();
    await expect(hostedMimoProjectRuntime(binding, async url => {
      const module = await port.imports(url); writeFileSync(physical, "{}"); return module;
    })).rejects.toThrow();
    expect(port.invoke).not.toHaveBeenCalled();
    retainedBirth(); await expect(hostedMimoProjectRuntime(binding, async () => ({}))).rejects.toThrow("routing_invalid");
  });
});
