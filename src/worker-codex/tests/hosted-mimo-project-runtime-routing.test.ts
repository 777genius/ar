import { host, setupResearchFixture, cleanupResearchFixture, local } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn() }));
import { MimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-contract";
import { parseResearchOperatorRequest } from "../research-launch-contract";
import { researchJobRuntimeProvenance } from "../research-job-runtime-provenance";
import { researchJobAuthority } from "../research-launch-admission";
import { observeResearchJobWriterAuthority, prepareOriginalNativeWriterObservation, createResearchJobWriterObservationPreparer } from "../research-writer-observation";
import { hostedMimoProjectRuntime } from "../hosted-mimo-project-runtime-routing";
import { recoverHostedMimoProjectPreEffectStartIntent, type HostedMimoRuntimeRouting } from "../hosted-mimo-project-runtime-selection";
import * as ordinaryWriter from "../hosted-ordinary-writer-authority";
import { createCodexGoalJob, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { protectedCodexGoalJobRuntimeProvenance, observeProtectedCodexGoalJobBirth, observeCompatibleProtectedCodexGoalJobBirth, protectedCodexGoalJobBirthPublicationActive, withProtectedCodexGoalJobBirthPublication, recordProtectedCodexGoalJobFirstEffect } from "../protected-job-birth";
import { researchArtifactDigest, researchAuthorityRoot, researchHash } from "../research-launch-files";
import { projectControlRefillWorkerFromSealedSource } from "../codex-goal-mcp-project-control-tool-handlers";

const metadata = "/etc/subscription-runtime/mimo-project-runtime-routing.json";
const original = "/opt/subscription-runtime/releases/" + "a".repeat(40), baseline = "/opt/subscription-runtime/releases/" + "b".repeat(40);
const current = "/opt/subscription-runtime/releases/" + "c".repeat(40);
const pointer = "/opt/subscription-runtime/mimo-project-bridge-current";
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
afterEach(() => { vi.useRealTimers(); cleanupResearchFixture(); });
describe("trusted controller runtime routing", () => {
  it("keeps the local composition when operator routing metadata is absent", async () => {
    const port = loader();
    expect((await hostedMimoProjectRuntime(binding, undefined, port.imports)).projectControlRefillWorkerFromSealedSource).toBe(projectControlRefillWorkerFromSealedSource);
    expect(port.imports).not.toHaveBeenCalled();
  });
  it("selects exact witnessed original modules and preserves none/default arguments without holding publication", async () => {
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "released" });
    recordProtectedCodexGoalJobFirstEffect(job.jobRootDir);
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "unknown" });
    const effect = lexical.replace(/\.json$/, ".first-effect.json"), effectBytes = readFileSync(effect);
    retainedBirth(); publishMetadata(); const port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, undefined, port.imports);
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
    const port = loader(); await hostedMimoProjectRuntime(binding, undefined, port.imports);
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
    const port = loader(); await expect(hostedMimoProjectRuntime(binding, undefined, port.imports)).rejects.toThrow();
    expect(port.imports).not.toHaveBeenCalled(); expect(port.invoke).not.toHaveBeenCalled();
  });
  it.each(["metadata", "birth", "artifact"])("rechecks %s after imports and before every operation", async fault => {
    retainedBirth(); publishMetadata(); const port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, undefined, port.imports);
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
    await expect(hostedMimoProjectRuntime(binding, undefined, async url => {
      const module = await port.imports(url); writeFileSync(physical, "{}"); return module;
    })).rejects.toThrow();
    expect(port.invoke).not.toHaveBeenCalled();
    retainedBirth(); await expect(hostedMimoProjectRuntime(binding, undefined, async () => ({}))).rejects.toThrow("routing_invalid");
  });
});

function publishCurrent(): void {
  artifact(current);
  symlinkSync("releases/" + "c".repeat(40), pointer);
  publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: current, currentArtifactSha256: researchArtifactDigest(current) });
}
const select = (operation: MimoProjectBridgeOperation) => ({ operation, jobId: job.jobId });
describe("explicit shared current activation", () => {
  it("routes fresh Create from an old controller through current while schema 1 stays original", async () => {
    retainedBirth(); publishMetadata(); const old = loader();
    await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Create), old.imports);
    expect(old.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(original + "/dist/"))).toBe(true);
    publishCurrent(); const shared = loader();
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Create), shared.imports);
    await runtime.projectControlRefillWorkerFromSealedSource({ jobId: "TEST-new", reasoningEffort: "none" }, { resolveRevision: vi.fn() });
    expect(shared.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(current + "/dist/"))).toBe(true);
    expect(shared.invoke).toHaveBeenCalledOnce();
    expect(protectedCodexGoalJobRuntimeProvenance(job, binding.registryRootDir)?.runtimeDirectory).toBe(original);
  });
  it("reads compatible foreign birth under the current publication lock, with first effects still fenced", async () => {
    retainedBirth();
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "unknown" });
    const outsider = new Promise<void>((resolve, reject) => setTimeout(() => {
      try { expect(() => recordProtectedCodexGoalJobFirstEffect(job.jobRootDir)).toThrow("publication_busy"); resolve(); } catch (error) { reject(error); }
    }, 0));
    await withProtectedCodexGoalJobBirthPublication(async () => {
      expect(await observeCompatibleProtectedCodexGoalJobBirth(job)).toEqual({ status: "released" });
      expect(await observeResearchJobWriterAuthority(job)).toEqual({ status: "released" });
      await outsider;
    });
    recordProtectedCodexGoalJobFirstEffect(job.jobRootDir);
    expect(await observeCompatibleProtectedCodexGoalJobBirth(job)).toEqual({ status: "unknown" });
  });
  it("persists current Start origin before uncertain submission and retains it for Status/Stop", async () => {
    retainedBirth(); publishCurrent(); const port = loader();
    port.invoke.mockImplementationOnce(async () => { throw new Error("TEST uncertain submission"); });
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), port.imports);
    await expect(runtime.projectControlStartStoredJob({ jobId: job.jobId })).rejects.toThrow("uncertain submission");
    const path = "/TEST-project/mimo-runtime-starts/" + job.jobId + ".json";
    const bytes = readFileSync(path), intent = JSON.parse(bytes.toString());
    expect(intent.runtimeDirectory).toBe(current); expect(lstatSync(path).mode & 0o777).toBe(0o600);
    for (const operation of [MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop, MimoProjectBridgeOperation.Start]) {
      const retained = loader(); await hostedMimoProjectRuntime(binding, select(operation), retained.imports);
      expect(retained.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(current + "/dist/"))).toBe(true);
    }
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(protectedCodexGoalJobRuntimeProvenance(job, binding.registryRootDir)?.runtimeDirectory).toBe(original);
  });
  it.each(["effect", "missing-birth"])("does not route uncertain %s Start to current", async fault => {
    retainedBirth(); publishCurrent();
    if (fault === "effect") recordProtectedCodexGoalJobFirstEffect(job.jobRootDir);
    else unlinkSync(lexical);
    const port = loader(); await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), port.imports);
    const expected = fault === "effect" ? original : baseline;
    expect(port.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(expected + "/dist/"))).toBe(true);
    expect(existsSync("/TEST-project/mimo-runtime-starts/" + job.jobId + ".json")).toBe(false);
  });
  it("keeps an incomplete native namespace closed rather than falling back to birth", async () => {
    retainedBirth(); publishCurrent(); mkdirSync(researchJobAuthority(job.jobId), { recursive: true, mode: 0o700 });
    const port = loader();
    await expect(hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Status), port.imports)).rejects.toThrow("routing_invalid");
    expect(port.imports).not.toHaveBeenCalled();
  });
  it.each(["pointer-target", "pointer-inode", "digest", "origin", "owner-arrival"])("rejects %s drift between selection and effect", async fault => {
    retainedBirth(); publishCurrent(); const port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), port.imports);
    if (fault === "pointer-target" || fault === "pointer-inode") {
      unlinkSync(pointer); symlinkSync("releases/" + (fault === "pointer-target" ? "a" : "c").repeat(40), pointer);
    }
    if (fault === "digest") writeFileSync(join(current, "dist/TEST.js"), "TEST drift");
    if (fault === "origin") writeFileSync(physical, "{}");
    if (fault === "owner-arrival") mkdirSync(researchJobAuthority(job.jobId), { recursive: true, mode: 0o700 });
    await expect(runtime.projectControlStartStoredJob({ jobId: job.jobId })).rejects.toThrow();
    expect(port.invoke).not.toHaveBeenCalled();
    expect(existsSync("/TEST-project/mimo-runtime-starts/" + job.jobId + ".json")).toBe(false);
  });
  it("waits for a coherent trusted v2 pair before selecting or importing once", async () => {
    retainedBirth(); publishCurrent();
    publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: original, currentArtifactSha256: researchArtifactDigest(original) });
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const port = loader(), pending = hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Create), port.imports);
    expect(port.imports).not.toHaveBeenCalled(); expect(port.invoke).not.toHaveBeenCalled();
    publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: current, currentArtifactSha256: researchArtifactDigest(current) });
    await vi.advanceTimersByTimeAsync(50);
    const runtime = await pending;
    expect(port.imports).toHaveBeenCalledTimes(3);
    expect(port.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(current + "/dist/"))).toBe(true);
    await runtime.projectControlRefillWorkerFromSealedSource({ jobId: "TEST-new", reasoningEffort: "none" }, { resolveRevision: vi.fn() });
    expect(port.invoke).toHaveBeenCalledOnce();
  });
  it("refuses an overdue wakeup even when the trusted pair has become coherent", async () => {
    retainedBirth(); publishCurrent();
    publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: original, currentArtifactSha256: researchArtifactDigest(original) });
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const port = loader(), pending = hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Create), port.imports);
    const rejected = expect(pending).rejects.toThrow("routing_invalid");
    publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: current, currentArtifactSha256: researchArtifactDigest(current) });
    const clock = vi.spyOn(performance, "now").mockReturnValue(10001);
    try { await vi.advanceTimersByTimeAsync(50); await rejected; }
    finally { clock.mockRestore(); }
    expect(port.imports).not.toHaveBeenCalled(); expect(port.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a persistent trusted v2 mismatch without importing or effects", async () => {
    retainedBirth(); publishCurrent(); unlinkSync(pointer); symlinkSync("releases/" + "a".repeat(40), pointer);
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const port = loader(), pending = hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Create), port.imports);
    const rejected = expect(pending).rejects.toThrow("routing_invalid");
    await vi.advanceTimersByTimeAsync(10000); await rejected;
    expect(port.imports).not.toHaveBeenCalled(); expect(port.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["malformed", "custody", "artifact", "pointer", "pointer-file"])("refuses invalid %s during mismatch immediately", async fault => {
    retainedBirth(); publishCurrent(); unlinkSync(pointer); symlinkSync("releases/" + "a".repeat(40), pointer);
    if (fault === "malformed") publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: current, currentArtifactSha256: researchArtifactDigest(current), unexpected: true });
    if (fault === "custody") chmodSync(local(metadata), 0o644);
    if (fault === "artifact") writeFileSync(join(current, "dist/TEST.js"), "TEST tamper");
    if (fault === "pointer") host.foreign.add(pointer);
    if (fault === "pointer-file") {
      const target = "/opt/subscription-runtime/releases/" + "d".repeat(40);
      writeFileSync(target, "TEST invalid target", { mode: 0o600 });
      unlinkSync(pointer); symlinkSync(target, pointer);
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const port = loader();
    await expect(hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Create), port.imports)).rejects.toThrow();
    expect(port.imports).not.toHaveBeenCalled(); expect(port.invoke).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

function nativeOrigin(terminal = false): { slot: string; spec: string; grant: string } {
  const authority = researchJobAuthority(job.jobId), startId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const directory = join(authority, "starts", startId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const grant = join(authority, "grant.json"); writeFileSync(grant, '{"TEST":"protected origin only"}', { mode: 0o600 });
  const request = parseResearchOperatorRequest({ schemaVersion: 1, jobId: job.jobId, taskId: job.taskId,
    jobRootDir: job.jobRootDir, workspacePath: job.workspacePath, promptPath: job.promptPath, authRootDir: "/TEST-auth",
    accounts: ["TEST-a"], codexBinaryPath: "/usr/bin/TEST-codex", model: "gpt-6.1-sol", reasoningEffort: "none",
    serviceTier: "default", taskTimeoutMs: 60000, durableHandoffRootDir: binding.registryRootDir + "/durable-handoffs" });
  const identity = (path: string) => { const stat = lstatSync(path); return { path, device: stat.dev, inode: stat.ino }; };
  const spec = join(directory, "spec.json"), hash = "d".repeat(64);
  writeFileSync(spec, JSON.stringify({ schemaVersion: 1, startId, runtimeDirectory: baseline, artifactSha256: researchArtifactDigest(baseline),
    grantSha256: researchHash(readFileSync(grant)), request, requestSha256: researchHash(JSON.stringify(request)), nodeSha256: hash,
    codexSha256: hash, unit: "subscription-runtime-research-" + startId + ".service", jobDirectory: identity(job.jobRootDir),
    workspaceDirectory: identity(job.workspacePath), registeredHandoff: { ...binding, manifestSha256: hash, scopeSha256: hash,
      receiptSha256: hash, requestSha256: researchHash(JSON.stringify(request)), durableDirectory: {
        path: request.durableHandoffRootDir, device: 1, inode: 1, mountId: 1, mountDevice: "0:1", mountRoot: "/", mountPoint: "/", filesystemUuid: "a".repeat(16) } } }), { mode: 0o600 });
  const slot = join(authority, terminal ? "last-terminal.json" : "active.json");
  writeFileSync(slot, JSON.stringify({ schemaVersion: 1, startId, specSha256: researchHash(readFileSync(spec)) }), { mode: 0o600 });
  return { slot, spec, grant };
}
describe("retained native origin", () => {
  it.each([false, true])("native origin wins over controller/job birth for terminal=%s without lifecycle reads", async terminal => {
    retainedBirth(); publishCurrent(); nativeOrigin(terminal); const port = loader(), calls = host.calls.length;
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Status), port.imports);
    await runtime.projectControlStopStoredJob({ jobId: job.jobId });
    expect(port.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(baseline + "/dist/"))).toBe(true);
    expect(host.calls.length).toBe(calls);
  });
  it("does not inherit terminal origin from an active slot whose spec is missing", async () => {
    retainedBirth(); publishCurrent(); nativeOrigin(true);
    writeFileSync(join(researchJobAuthority(job.jobId), "active.json"), JSON.stringify({ schemaVersion: 1,
      startId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", specSha256: "d".repeat(64) }), { mode: 0o600 });
    expect(researchJobRuntimeProvenance(job)).toBeUndefined();
    const port = loader(); await expect(hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Stop), port.imports)).rejects.toThrow();
    expect(port.imports).not.toHaveBeenCalled();
  });
  it.each(["slot", "spec", "grant", "active-arrival"])("cold terminal %s drift refuses effects", async fault => {
    retainedBirth(); publishCurrent(); const paths = nativeOrigin(true), port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Stop), port.imports);
    if (fault === "active-arrival") writeFileSync(join(researchJobAuthority(job.jobId), "active.json"), "{}", { mode: 0o600 });
    else writeFileSync(paths[fault as "slot" | "spec" | "grant"], "{}");
    await expect(runtime.projectControlStopStoredJob({ jobId: job.jobId })).rejects.toThrow();
    expect(port.invoke).not.toHaveBeenCalled();
  });
  it("rejects malformed authority ancestry as positive namespace absence", async () => {
    retainedBirth(); publishCurrent(); chmodSync(local(researchAuthorityRoot), 0o777);
    const port = loader(); await expect(hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), port.imports)).rejects.toThrow();
    expect(port.imports).not.toHaveBeenCalled();
  });
});

describe("explicit pre-effect Start intent recovery", () => {
  async function recoveryFixture() {
    retainedBirth(); publishCurrent();
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), loader().imports);
    await runtime.projectControlStartStoredJob({ jobId: job.jobId });
    const path = "/TEST-project/mimo-runtime-starts/" + job.jobId + ".json", bytes = readFileSync(path);
    const next = "/opt/subscription-runtime/releases/" + "e".repeat(40);
    artifact(next); unlinkSync(pointer); symlinkSync("releases/" + "e".repeat(40), pointer);
    publishMetadata({ schemaVersion: 2, currentRuntimeDirectory: next, currentArtifactSha256: researchArtifactDigest(next) });
    const config = JSON.parse(readFileSync(metadata, "utf8")) as HostedMimoRuntimeRouting;
    const metadataBytes = readFileSync(metadata);
    const witness = () => {
      if (!readFileSync(metadata).equals(metadataBytes)) throw new Error("TEST current drift");
    };
    const expected = { intentSha256: researchHash(bytes), manifestSha256: researchHash(readFileSync(join(binding.registryRootDir, job.jobId, "job.json"))) };
    return { path, bytes, next, config, witness, expected };
  }
  it("explicitly recovers only unexecuted intent, preserving exact audit bytes and routing the next Start to current", async () => {
    const input = await recoveryFixture();
    const proof = await recoverHostedMimoProjectPreEffectStartIntent(binding, select(MimoProjectBridgeOperation.Start), input.expected, input.config, input.witness);
    expect(readFileSync(proof.archivePath).equals(input.bytes)).toBe(true);
    expect(lstatSync(proof.archivePath).mode & 0o777).toBe(0o600);
    expect(proof.priorIntentSha256).toBe(input.expected.intentSha256);
    expect(JSON.parse(readFileSync(input.path, "utf8")).runtimeDirectory).toBe(input.next);
    expect(protectedCodexGoalJobRuntimeProvenance(job, binding.registryRootDir)?.runtimeDirectory).toBe(original);
    const port = loader(); await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), port.imports);
    expect(port.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(input.next + "/dist/"))).toBe(true);
    expect(port.invoke).not.toHaveBeenCalled();
    await expect(recoverHostedMimoProjectPreEffectStartIntent(binding, select(MimoProjectBridgeOperation.Start), input.expected, input.config, input.witness)).rejects.toThrow();
  });
  it.each(["native-active", "native-terminal", "native-incomplete", "ordinary", "lexical-effect", "physical-effect", "missing-birth", "intent-drift", "manifest-drift", "current-drift", "non-start"])("refuses %s recovery and retains the prior intent", async fault => {
    const input = await recoveryFixture();
    if (fault === "native-active") nativeOrigin();
    if (fault === "native-terminal") nativeOrigin(true);
    if (fault === "native-incomplete") mkdirSync(researchJobAuthority(job.jobId), { recursive: true, mode: 0o700 });
    const ordinary = fault === "ordinary" ? vi.spyOn(ordinaryWriter, "hostedOrdinaryWriterAuthorityAbsent").mockReturnValue(false) : undefined;
    if (fault === "lexical-effect") writeFileSync(lexical.replace(/\.json$/, ".first-effect.json"), "{}", { mode: 0o600 });
    if (fault === "physical-effect") writeFileSync(physical.replace(/\.json$/, ".first-effect.json"), "{}", { mode: 0o600 });
    if (fault === "missing-birth") unlinkSync(lexical);
    if (fault === "intent-drift") writeFileSync(input.path, input.bytes.toString() + " ");
    if (fault === "manifest-drift") writeFileSync(join(binding.registryRootDir, job.jobId, "job.json"), "{}");
    if (fault === "current-drift") publishMetadata();
    const before = readFileSync(input.path);
    try {
      await expect(recoverHostedMimoProjectPreEffectStartIntent(binding,
        select(fault === "non-start" ? MimoProjectBridgeOperation.Status : MimoProjectBridgeOperation.Start),
        input.expected, input.config, input.witness)).rejects.toThrow();
      expect(readFileSync(input.path).equals(before)).toBe(true);
      expect(existsSync("/TEST-project/mimo-runtime-starts/pre-effect-history")).toBe(false);
    } finally { ordinary?.mockRestore(); }
  });
  it("refuses an owner arriving under the publication guard without rewriting intent", async () => {
    const input = await recoveryFixture(); let checks = 0;
    await expect(recoverHostedMimoProjectPreEffectStartIntent(binding, select(MimoProjectBridgeOperation.Start), input.expected, input.config, () => {
      input.witness(); if (++checks === 3) mkdirSync(researchJobAuthority(job.jobId), { recursive: true, mode: 0o700 });
    })).rejects.toThrow();
    expect(readFileSync(input.path).equals(input.bytes)).toBe(true);
    expect(readFileSync("/TEST-project/mimo-runtime-starts/pre-effect-history/" + job.jobId + "." + input.expected.intentSha256 + ".json").equals(input.bytes)).toBe(true);
  });
  it.each([false, true])("reconciles interrupted exact history and refuses conflicting history=%s", async conflicting => {
    const input = await recoveryFixture(), archiveRoot = "/TEST-project/mimo-runtime-starts/pre-effect-history";
    mkdirSync(archiveRoot, { mode: 0o700 });
    const archive = archiveRoot + "/" + job.jobId + "." + input.expected.intentSha256 + ".json";
    writeFileSync(archive, conflicting ? "{}" : input.bytes, { mode: 0o600 });
    const recovery = recoverHostedMimoProjectPreEffectStartIntent(binding, select(MimoProjectBridgeOperation.Start), input.expected, input.config, input.witness);
    if (conflicting) {
      await expect(recovery).rejects.toThrow();
      expect(readFileSync(input.path).equals(input.bytes)).toBe(true);
      expect(readFileSync(archive, "utf8")).toBe("{}");
    } else {
      await expect(recovery).resolves.toMatchObject({ archivePath: archive });
      expect(readFileSync(archive).equals(input.bytes)).toBe(true);
    }
  });
});

describe("origin arrival during imports", () => {
  it.each(["native", "intent"])("rejects newly arrived %s origin before Status/Stop can call old code", async kind => {
    retainedBirth(); publishCurrent(); const port = loader(); let arrived = false;
    await expect(hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Status), async url => {
      const module = await port.imports(url);
      if (!arrived) {
        arrived = true;
        if (kind === "native") nativeOrigin();
        else {
          mkdirSync("/TEST-project/mimo-runtime-starts", { mode: 0o700 });
          writeFileSync("/TEST-project/mimo-runtime-starts/" + job.jobId + ".json", JSON.stringify({ schemaVersion: 1,
            ...binding, jobId: job.jobId, createdAt: job.createdAt, jobRootDir: job.jobRootDir, workspacePath: job.workspacePath,
            runtimeDirectory: current, artifactSha256: researchArtifactDigest(current) }), { mode: 0o600 });
        }
      }
      return module;
    })).rejects.toThrow();
    expect(port.invoke).not.toHaveBeenCalled();
  });
  it("retains exact intent across an incomplete pre-spec namespace without granting release", async () => {
    retainedBirth(); publishCurrent(); const port = loader();
    const runtime = await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Start), port.imports);
    await runtime.projectControlStartStoredJob({ jobId: job.jobId });
    const intentPath = "/TEST-project/mimo-runtime-starts/" + job.jobId + ".json", bytes = readFileSync(intentPath);
    mkdirSync(researchJobAuthority(job.jobId), { recursive: true, mode: 0o700 });
    const retained = loader(); await hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Status), retained.imports);
    expect(retained.imports.mock.calls.every(([url]) => fileURLToPath(url).startsWith(current + "/dist/"))).toBe(true);
    expect(await observeResearchJobWriterAuthority(job)).toEqual({ status: "unknown" });
    expect(readFileSync(intentPath).equals(bytes)).toBe(true);
    nativeOrigin();
    await expect(hostedMimoProjectRuntime(binding, select(MimoProjectBridgeOperation.Stop), loader().imports)).rejects.toThrow();
    expect(readFileSync(intentPath).equals(bytes)).toBe(true);
  });
});

describe("original native writer preparation relay", () => {
  it("does not reconcile an untouched legacy terminal before its positive foreign reader", async () => {
    const paths = nativeOrigin(true), calls = host.calls.length;
    const foreignRead = vi.fn(async () => ({ status: "released" }));
    const imports = vi.fn(async () => ({ prepareResearchJobWriterObservation: async () => foreignRead }));
    const prepare = createResearchJobWriterObservationPreparer(imports), read = await prepare(job);
    expect(await read()).toEqual({ status: "released" });
    expect(imports).toHaveBeenCalledOnce(); expect(host.calls.length).toBe(calls);
    const intent = join(researchJobAuthority(job.jobId), "stopped-before-provider-release-intent.json");
    writeFileSync(intent, '{"invalid":true}', { mode: 0o600 });
    expect(await (await prepare(job))()).toEqual({ status: "unknown" });
    unlinkSync(intent);
    writeFileSync(join(paths.spec, "..", "stopped-before-provider-release.json"), '{"invalid":true}', { mode: 0o600 });
    expect(await (await prepare(job))()).toEqual({ status: "unknown" });
    expect(foreignRead).toHaveBeenCalledOnce(); expect(host.calls.length).toBe(calls);
  });
  it("prepares foreign terminal observation before publication, then checks cold bytes under the current mutex", async () => {
    retainedBirth(); const paths = nativeOrigin(true), calls = host.calls.length;
    const readOriginal = vi.fn(async () => {
      expect(protectedCodexGoalJobBirthPublicationActive()).toBe(true);
      return { status: "released" };
    });
    const prepare = vi.fn(async () => {
      expect(protectedCodexGoalJobBirthPublicationActive()).toBe(false); return readOriginal;
    });
    const imports = vi.fn(async (url: string) => {
      expect(protectedCodexGoalJobBirthPublicationActive()).toBe(false);
      expect(fileURLToPath(url)).toBe(baseline + "/dist/worker-codex/research-writer-observation.js");
      return { prepareResearchJobWriterObservation: prepare };
    });
    const read = await prepareOriginalNativeWriterObservation(job, imports);
    expect(prepare).toHaveBeenCalledOnce(); expect(imports).toHaveBeenCalledOnce();
    await withProtectedCodexGoalJobBirthPublication(async () => {
      expect(await read!()).toEqual({ status: "released" });
      writeFileSync(paths.grant, "{}");
      expect(await read!()).toEqual({ status: "unknown" });
    });
    expect(readOriginal).toHaveBeenCalledOnce(); expect(imports).toHaveBeenCalledOnce(); expect(host.calls.length).toBe(calls);
  });
  it.each(["import", "preparation", "missing-export"])("retains unknown on foreign %s failure", async fault => {
    nativeOrigin(true);
    const imports = async () => {
      if (fault === "import") throw new Error("TEST missing retained runtime module");
      if (fault === "missing-export") return {};
      return { prepareResearchJobWriterObservation: async () => { throw new Error("TEST preparation uncertainty"); } };
    };
    const read = await prepareOriginalNativeWriterObservation(job, imports);
    expect(await read!()).toEqual({ status: "unknown" });
  });
  it("does not import a foreign composition from a publication-active direct observation", async () => {
    nativeOrigin(true); const imports = vi.fn();
    await withProtectedCodexGoalJobBirthPublication(async () => {
      const read = await prepareOriginalNativeWriterObservation(job, imports);
      expect(await read!()).toEqual({ status: "unknown" });
    });
    expect(imports).not.toHaveBeenCalled();
  });
});
