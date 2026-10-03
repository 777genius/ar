import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeResearchLaunchFailure, ResearchLaunchCause as C, ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";
import { prepareHostScratchTemp } from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";

let temporaryRoot: string | undefined;
afterEach(() => { if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true }); temporaryRoot = undefined; });

describe("finite startup diagnostics", () => {
  it("preserves every deployed numeric code and cause while adding a finite diagnosis", () => {
    const known = ["hosted_research_launch_denied", "checkpoint_publisher_required",
      "terminal_checkpoint_mutex_busy_owner_unproven", "terminal_checkpoint_job_fenced",
      "Refusing to hide nonempty legacy scratch directory", "Scratch bind target busy",
      "Unknown mount at scratch target", "Prepared scratch source identity changed"];
    for (const [index, message] of known.entries()) {
      for (const cause of Object.values(C)) {
        const observation = normalizeResearchLaunchFailure(new Error(message, { cause }));
        expect(observation.legacyCode).toBe(index);
        expect(observation.cause).toBe(cause);
        expect(observation.diagnostic).not.toBe(D.Unknown);
      }
    }
  });

  it("classifies an actual filesystem ENOENT without exposing its path", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "TEST-launch-diagnostic-"));
    let failure: unknown;
    try { readFileSync(join(temporaryRoot, "private-TEST-path")); } catch (error) { failure = error; }
    expect(normalizeResearchLaunchFailure(failure)).toEqual({ legacyCode: "unclassified", cause: C.None, diagnostic: D.ENOENT });
  });

  it("whitelists only the requested Node errnos, without coercion or recursive cause parsing", () => {
    for (const code of [D.ENOENT, D.EACCES, D.EPERM, D.EAGAIN, D.ENOSPC, D.EMFILE, D.ETIMEDOUT]) {
      expect(normalizeResearchLaunchFailure(Object.assign(new Error("TEST opaque operation"), { code })).diagnostic).toBe(code);
    }
    for (const code of ["EEXIST", "EIO", "ENOTDIR", "ENOENT:TEST-secret", {}, 1]) {
      expect(normalizeResearchLaunchFailure({ code, cause: { code: "ENOENT" } }).diagnostic).toBe(D.Unknown);
    }
  });

  it.each([
    ["config custody", D.ScratchConfigCustody], ["schema", D.ScratchSchemaInvalid],
    ["mount", D.ScratchMountMismatch], ["space", D.ScratchSpace],
    ["root custody", D.ScratchDirectoryUnsafe], ["source safety", D.ScratchSourceUnsafe],
    ["bind verification", D.ScratchBindVerification],
  ] as const)("observes the actual scratch algorithm's %s rejection", async (scenario, diagnostic) => {
    const job = "/TEST-job", f = await preparedResearchScratch(job, "/TEST-home");
    const source = f.prepared.find(bind => bind.target === `${job}/tmp`)!.source;
    if (scenario === "config custody") f.nodes.set(f.configPath, { ...f.nodes.get(f.configPath)!, mode: 0o666 });
    if (scenario === "schema") f.setPolicy({ schemaVersion: 2, root: f.root, uuid: f.uuid });
    if (scenario === "mount") f.mounts.set(f.root, { target: f.root, uuid: "wrong", fsroot: "/" });
    if (scenario === "space") f.host.statfs = () => ({ bavail: 1, bsize: 1 });
    if (scenario === "root custody") f.nodes.set(f.root, { ...f.nodes.get(f.root)!, mode: 0o777 });
    if (scenario === "source safety") f.nodes.set(source, { ...f.nodes.get(source)!, mode: 0o744 });
    if (scenario === "bind verification") {
      f.mounts.delete(`${job}/tmp`); f.nodes.delete(`${job}/tmp`); f.nodes.delete(source);
      f.host.bind = () => {};
    }
    let failure: unknown;
    try { await prepareHostScratchTemp(job, {}, f.host); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(normalizeResearchLaunchFailure(failure).diagnostic).toBe(diagnostic);
    if (scenario !== "bind verification") expect(f.mutations).toEqual([]);
    else expect(f.nodes.has(`${source}.lock`)).toBe(false);
  });

  it("keeps relevant runtime admission failures finite and unfamiliar admissions unknown", () => {
    for (const message of ["checkpoint_initial_base_required", "terminal_checkpoint_state_invalid", "terminal_checkpoint_path_untrusted"])
      expect(normalizeResearchLaunchFailure(new Error(message)).diagnostic).toBe(D.CheckpointAdmission);
    for (const message of ["codex_goal_provider_egress_admission_mismatch", "hosted_test_egress_admission_invalid"])
      expect(normalizeResearchLaunchFailure(new Error(message)).diagnostic).toBe(D.EgressAdmission);
    expect(normalizeResearchLaunchFailure(new Error("hosted_new_admission_invalid")).diagnostic).toBe(D.Unknown);
  });

  it("identifies a prebind custody rejection while leaving source and lock absent", async () => {
    const job = "/TEST-job", f = await preparedResearchScratch(job, "/TEST-home");
    const source = f.prepared.find(bind => bind.target === `${job}/tmp`)!.source;
    f.nodes.delete(source); f.nodes.delete(`${job}/tmp`); f.mounts.delete(`${job}/tmp`);
    f.nodes.set(`${f.root}/runtime-tmp`, { ...f.nodes.get(`${f.root}/runtime-tmp`)!, uid: 999 });
    let failure: unknown;
    try { await prepareHostScratchTemp(job, {}, f.host); } catch (error) { failure = error; }
    expect(normalizeResearchLaunchFailure(failure).diagnostic).toBe(D.ScratchDirectoryUnsafe);
    expect(f.mutations).toEqual([]);
    expect(f.nodes.has(source)).toBe(false);
    expect(f.nodes.has(`${source}.lock`)).toBe(false);
  });

  it("runs the built entrypoint's real catch and exits 70 with one bounded observation", () => {
    // Invalid arity fails before any Host import, admission, launch or provider work.
    const child = spawnSync(process.execPath, ["host-integration/research-runtime-launch.mjs"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(70);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("hosted_research_runtime_launch_denied:imports:unclassified:none:unknown\n");
  });
});
