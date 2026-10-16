import { host, local, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ProjectOperation } from "@vioxen/subscription-runtime/worker-core";
import { codexProjectAdmissionGate } from "../application/project-control/codex-goal-project-mutation-admission";
import { listCodexGoalJobs, readCodexGoalJob, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { prepareOriginalNativeWriterObservation } from "../research-writer-observation";
import * as writers from "../research-writer-observation";
import * as provenance from "../research-job-runtime-provenance";
import * as files from "../research-launch-files";

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
beforeEach(() => setupResearchFixture({ allocationParent: nativeFs.realpathSync(tmpdir()) }));
afterEach(cleanupResearchFixture);

describe("inert original-runtime admission preparation census", () => {
  it("reuses the verified foreign module preparer only within one admission preparation and retains fresh readers", async () => {
    const registryRootDir = "/TEST-project/registry";
    const originals = ["a", "b"].map(letter => "/opt/subscription-runtime/releases/" + letter.repeat(40));
    const digests = originals.map(directory => {
      for (const name of ["dist", "host-integration", "node_modules"]) fs.mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(directory, "package.json"), '{"type":"module"}', { mode: 0o600 });
      fs.writeFileSync(join(directory, "dist/TEST.js"), "TEST original runtime " + directory, { mode: 0o600 });
      return files.researchArtifactDigest(directory);
    });
    const jobs: CodexGoalJobManifest[] = [0, 1, 2].map(index => {
      const jobId = "TEST-census-" + index, jobRootDir = "/TEST-project/jobs/" + jobId;
      const manifest: CodexGoalJobManifest = { schemaVersion: 1, jobId, taskId: jobId, jobRootDir,
        createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
        workspacePath: jobRootDir + "/workspace", promptPath: jobRootDir + "/prompt.md", accounts: ["TEST-a"] };
      fs.mkdirSync(join(registryRootDir, jobId), { recursive: true, mode: 0o700 });
      fs.mkdirSync(manifest.workspacePath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(registryRootDir, jobId, "job.json"), JSON.stringify(manifest), { mode: 0o600 });
      return manifest;
    });
    // Only the protected native provenance/old terminal reader is substituted.
    // Registry parsing, admission preparation loop, original-runtime guards and
    // all executable byte/custody/descriptor reads remain production code.
    const current = vi.fn();
    vi.spyOn(provenance, "researchForeignWriterRuntimeProvenance").mockImplementation(manifest => {
      const index = Number(manifest.jobId.at(-1)) % 2;
      return { runtimeDirectory: originals[index]!, artifactSha256: digests[index]!, assertCurrent: current };
    });
    const traversals = [0, 0], readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const index = originals.indexOf(String(path));
      if (index !== -1) traversals[index]!++;
      // researchArtifactDigest starts at dist, not the runtime parent.
      const root = originals.findIndex(directory => String(path) === directory + "/dist");
      if (root !== -1) traversals[root]!++;
      return readdir(path, options as never);
    }) as typeof fs.readdirSync);
    const readers = new Map<string, () => Promise<{ status: "released" }>>();
    const imports = vi.fn(async () => ({ prepareResearchJobWriterObservation: async (manifest: CodexGoalJobManifest) => {
      const reader = vi.fn(async () => ({ status: "released" as const })); readers.set(manifest.jobId, reader); return reader;
    } }));
    const prepared = new Map<string, () => Promise<import("@vioxen/subscription-runtime/worker-core").ProjectAdmissionWriterObservation>>();
    const wrap = (prepare: (manifest: CodexGoalJobManifest) => Promise<() => Promise<import("@vioxen/subscription-runtime/worker-core").ProjectAdmissionWriterObservation>>) => async (manifest: CodexGoalJobManifest) => {
      const reader = await prepare(manifest); prepared.set(manifest.jobId, reader); return reader;
    };
    const begin = vi.fn(() => {
      return wrap(writers.createResearchJobWriterObservationPreparer(imports));
    });
    const prepareFallback = async (manifest: CodexGoalJobManifest) => (await prepareOriginalNativeWriterObservation(manifest, imports))!;
    const gate = codexProjectAdmissionGate({ registryRootDir, controllerJobId: "TEST-controller",
      scope: { projectId: "TEST-census", jobIdPrefixes: ["TEST-"] }, deps: Object.assign({
        listJobs: listCodexGoalJobs, readJob: readCodexGoalJob,
        buildOverviewItems: async () => [],
        prepareWriterObservation: wrap(prepareFallback),
      }, { createWriterObservationPreparer: begin }) });
    await gate.prepare!({ operation: ProjectOperation.CreateJob });
    expect(prepared.size).toBe(3); expect(readers.size).toBe(3);
    expect(traversals).toEqual([4, 3]); expect(imports).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenCalledTimes(1);
    for (const manifest of jobs) expect(await prepared.get(manifest.jobId)!()).toEqual({ status: "released" });
    expect(traversals).toEqual([8, 5]);
    // A retained reader is not an authority cache: changed executable bytes
    // refuse before calling the old terminal reader again.
    const read = vi.mocked(readers.get(jobs[0]!.jobId)!);
    read.mockClear();
    fs.writeFileSync(join(originals[0]!, "dist/TEST.js"), "TEST changed executable", { mode: 0o600 });
    expect(await prepared.get(jobs[0]!.jobId)!()).toEqual({ status: "unknown" });
    expect(read).not.toHaveBeenCalled(); expect(current).toHaveBeenCalled();
    fs.writeFileSync(join(originals[0]!, "dist/TEST.js"), "TEST original runtime " + originals[0], { mode: 0o600 });
    await gate.prepare!({ operation: ProjectOperation.CreateJob });
    expect(begin).toHaveBeenCalledTimes(2); expect(imports).toHaveBeenCalledTimes(4);
    expect(readers.size).toBe(3);
  });

  function foreignFixture() {
    const directory = "/opt/subscription-runtime/releases/" + "f".repeat(40);
    for (const name of ["dist", "host-integration", "node_modules"]) fs.mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(directory, "package.json"), '{"type":"module"}', { mode: 0o600 });
    const file = join(directory, "dist/TEST.js"); fs.writeFileSync(file, "TEST initial", { mode: 0o600 });
    let artifactSha256 = files.researchArtifactDigest(directory);
    const current = vi.fn();
    vi.spyOn(provenance, "researchForeignWriterRuntimeProvenance").mockImplementation(() => ({
      runtimeDirectory: directory, artifactSha256, assertCurrent: current,
    }));
    const manifest = (index: number): CodexGoalJobManifest => ({ schemaVersion: 1, jobId: "TEST-bound-" + index,
      taskId: "TEST-bound-" + index, jobRootDir: "/TEST-project/jobs/TEST-bound-" + index,
      workspacePath: "/TEST-project/workspaces/TEST-bound-" + index, promptPath: "/TEST-project/jobs/TEST-bound-" + index + "/prompt.md",
      createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z", accounts: ["TEST-a"] });
    return { directory, file, current, manifest, change: () => fs.writeFileSync(file, "TEST changed", { mode: 0o600 }),
      adoptChangedDigest: () => { artifactSha256 = files.researchArtifactDigest(directory); } };
  }

  it.each(["import", "prepare", "read"] as const)("refuses artifact mutation during %s before any positive observation escapes", async stage => {
    const f = foreignFixture(), nativeRead = vi.fn(async () => {
      if (stage === "read") f.change();
      return { status: "released" as const };
    });
    const nativePrepare = vi.fn(async () => { if (stage === "prepare") f.change(); return nativeRead; });
    const load = vi.fn(async () => { if (stage === "import") f.change(); return { prepareResearchJobWriterObservation: nativePrepare }; });
    const prepare = writers.createResearchJobWriterObservationPreparer(load);
    const read = await prepare(f.manifest(0));
    expect(await read()).toEqual({ status: "unknown" });
    expect(nativePrepare).toHaveBeenCalledTimes(stage === "import" ? 0 : 1);
    expect(nativeRead).toHaveBeenCalledTimes(stage === "read" ? 1 : 0);
    expect(f.current).toHaveBeenCalled();
  });

  it("keeps readers bound to each manifest and does not reuse a preparer under a different digest", async () => {
    const f = foreignFixture(), seen: string[] = [];
    const load = vi.fn(async () => ({ prepareResearchJobWriterObservation: async (manifest: CodexGoalJobManifest) => {
      seen.push(manifest.jobId);
      return async () => ({ status: "allocated" as const, roots: [{ device: "TEST-device", backingPath: manifest.workspacePath }] });
    } }));
    const prepare = writers.createResearchJobWriterObservationPreparer(load), first = f.manifest(0), second = f.manifest(1);
    const firstRead = await prepare(first), secondRead = await prepare(second);
    expect(load).toHaveBeenCalledTimes(1); expect(seen).toEqual([first.jobId, second.jobId]);
    expect(await firstRead()).toEqual({ status: "allocated", roots: [{ device: "TEST-device", backingPath: first.workspacePath }] });
    expect(await secondRead()).toEqual({ status: "allocated", roots: [{ device: "TEST-device", backingPath: second.workspacePath }] });
    f.change(); f.adoptChangedDigest();
    const changedRead = await prepare(f.manifest(2));
    expect(load).toHaveBeenCalledTimes(2); // Same canonical path, independently qualified changed digest.
    expect(await firstRead()).toEqual({ status: "unknown" });
    expect(await changedRead()).toEqual({ status: "allocated", roots: [{ device: "TEST-device", backingPath: f.manifest(2).workspacePath }] });
  });

  it("retains warmed witnesses when alternating artifact scans exceed the shared finite file-cache bound", () => {
    const paths = ["a", "b"].flatMap(name => Array.from({ length: 5 }, (_, index) =>
      "/TEST-artifact/node_modules/TEST-" + name + "-" + index));
    paths.forEach(path => fs.writeFileSync(local(path), path, { mode: 0o600 }));
    const options = { maxBytes: 1024, deadline: performance.now() + 4000,
      cache: new Map<string, { signature: string; digest: string }>(), cacheEntries: 8 };
    const read = fs.readSync; let dataBytes = 0;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args); dataBytes += count; return count;
    });
    const scan = (selected: readonly string[]) => {
      const before = dataBytes;
      for (const path of selected) expect(files.researchFileDigest(path, options)).toBe(createHash("sha256").update(path).digest("hex"));
      expect(options.cache.size).toBeLessThanOrEqual(8); return dataBytes - before;
    };
    const a = paths.slice(0, 5), b = paths.slice(5), bytes = (selected: readonly string[]) => selected.reduce((n, path) => n + Buffer.byteLength(path), 0);
    expect(scan(a)).toBe(bytes(a)); expect(scan(a)).toBe(0);
    expect(scan(b)).toBe(bytes(b));
    expect(scan(a)).toBe(0); expect(scan(b)).toBe(bytes(b.slice(3)));
    // Hits still enforce current byte signatures and path custody.
    const hit = b[2]!;
    fs.writeFileSync(local(hit), "TEST changed", { mode: 0o600 });
    expect(files.researchFileDigest(hit, options)).toBe(createHash("sha256").update("TEST changed").digest("hex"));
    fs.chmodSync(local(hit), 0o666); expect(() => files.researchFileDigest(hit, options)).toThrow();
    fs.chmodSync(local(hit), 0o600); host.foreign.add(hit); expect(() => files.researchFileDigest(hit, options)).toThrow();
    host.foreign.delete(hit); fs.renameSync(local(hit), local(hit) + "-old");
    fs.symlinkSync(local(hit) + "-old", local(hit)); expect(() => files.researchFileDigest(hit, options)).toThrow();
  });
});
