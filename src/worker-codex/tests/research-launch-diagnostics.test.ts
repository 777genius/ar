import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { annotateScratchMountInspectionFailure, normalizeResearchLaunchFailure, ResearchLaunchCause as C, ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";
import { prepareHostScratchCaches, prepareHostScratchTemp, resolvePreparedHostScratchCacheBinds } from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";
import { classifyCodexFailure } from "../../provider-codex/failure-classifier";
import { SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";

let temporaryRoot: string | undefined;
afterEach(() => { if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true }); temporaryRoot = undefined; });

describe("finite startup diagnostics", () => {
  it("preserves every deployed numeric code and cause while adding a finite diagnosis", () => {
    const known = [["hosted_research_launch_denied", D.ResearchAdmission], ["checkpoint_publisher_required", D.CheckpointAdmission],
      ["terminal_checkpoint_mutex_busy_owner_unproven", D.CheckpointAdmission], ["terminal_checkpoint_job_fenced", D.CheckpointAdmission],
      ["Refusing to hide nonempty legacy scratch directory", D.ScratchNonempty], ["Scratch bind target busy", D.ScratchBusy],
      ["Unknown mount at scratch target", D.ScratchUnknownMount], ["Prepared scratch source identity changed", D.ScratchSourceChanged]] as const;
    for (const [index, [message, diagnostic]] of known.entries()) {
      for (const cause of Object.values(C)) {
        const observation = normalizeResearchLaunchFailure(new Error(message, { cause }));
        expect(observation.legacyCode).toBe(index);
        expect(observation.cause).toBe(cause);
        expect(observation.diagnostic).toBe(diagnostic);
      }
      // RED: annotation changes a deployed code or loses its finite diagnosis.
      const annotated = normalizeResearchLaunchFailure(annotateScratchMountInspectionFailure(new Error(message), C.ScratchTmp));
      expect(annotated).toEqual({ legacyCode: index, cause: C.ScratchTmp, diagnostic });
    }
  });

  it("classifies an actual filesystem ENOENT without exposing its path", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "TEST-launch-diagnostic-"));
    let failure: unknown;
    try { readFileSync(join(temporaryRoot, "private-TEST-path")); } catch (error) { failure = error; }
    expect(normalizeResearchLaunchFailure(failure)).toEqual({ legacyCode: "unclassified", cause: C.None, diagnostic: D.ENOENT });
  });

  it("whitelists only the requested Node errnos without coercion", () => {
    for (const code of [D.ENOENT, D.EACCES, D.EPERM, D.EAGAIN, D.ENOSPC, D.EMFILE, D.ETIMEDOUT]) {
      expect(normalizeResearchLaunchFailure(Object.assign(new Error("TEST opaque operation"), { code })).diagnostic).toBe(code);
    }
    for (const code of ["EEXIST", "EIO", "ENOTDIR", "ENOENT:TEST-secret", {}, 1]) {
      expect(normalizeResearchLaunchFailure({ code, cause: { code: "ENOENT:TEST-secret" } }).diagnostic).toBe(D.Unknown);
    }
  });

  // RED: the pool's prewarm envelope hides a retained scratch observation.
  it("observes a real cache inspection failure through the worker prewarm envelope", async () => {
    const home = "/TEST-home", f = await preparedResearchScratch("/TEST-job", home);
    const original = Object.assign(new Error("TEST-secret /private/path"), { code: "ETIMEDOUT", stderr: "TEST-secret" });
    const inspect = f.host.inspectMount;
    f.host.inspectMount = path => { if (path === `${home}/plugins/cache`) throw original; return inspect(path); };
    let failure: unknown;
    try { await prepareHostScratchCaches(home, {}, f.host); } catch (error) { failure = error; }
    expect(failure).toBe(original);
    const wrapped = new SubscriptionWorkerError("subscription_worker_prewarm_failed", "TEST-secret envelope", { cause: failure });
    const observation = normalizeResearchLaunchFailure(wrapped);
    expect(observation).toEqual({ legacyCode: "unclassified", cause: C.ScratchCache, diagnostic: D.ETIMEDOUT });
    expect(JSON.stringify(observation)).not.toContain("TEST-secret");
    expect(wrapped.cause).toBe(original);
    expect(f.mutations).toEqual([]);
  });

  it("retains wrapped guard observations and independently preserves recognized outer fields", () => {
    const guard = new Error("hosted_research_launch_denied", { cause: C.ArtifactDeadline });
    expect(normalizeResearchLaunchFailure(new Error("TEST-private wrapper", { cause: guard })))
      .toEqual({ legacyCode: "unclassified", cause: C.ArtifactDeadline, diagnostic: D.ResearchAdmission });
    const leaf = annotateScratchMountInspectionFailure(new Error("Ambiguous scratch mount inspection"), C.ScratchTmp);
    expect(normalizeResearchLaunchFailure(new Error("checkpoint_publisher_required", { cause: leaf })))
      .toEqual({ legacyCode: 1, cause: C.ScratchTmp, diagnostic: D.CheckpointAdmission });
    const outer = annotateScratchMountInspectionFailure(new Error("TEST-secret", { cause: guard }), C.ScratchCache);
    expect(normalizeResearchLaunchFailure(outer))
      .toEqual({ legacyCode: "unclassified", cause: C.ScratchCache, diagnostic: D.ResearchAdmission });
  });

  // RED: diagnostics execute accessors, traverse inherited/deep causes, coerce
  // secrets or loop forever instead of returning a finite unknown observation.
  it("closes getter, inherited, cyclic and over-depth causes without exposing private data", () => {
    const unknown = { legacyCode: "unclassified", cause: C.None, diagnostic: D.Unknown };
    const known = new Error("hosted_research_launch_denied", { cause: C.FileDeadline });
    let reads = 0;
    const accessors = Object.defineProperties({}, Object.fromEntries(["message", "code", "cause"].map(key =>
      [key, { get: () => { reads += 1; throw new Error("TEST-secret getter"); } }])));
    expect(normalizeResearchLaunchFailure(accessors)).toEqual(unknown);
    expect(reads).toBe(0);
    expect(normalizeResearchLaunchFailure(Object.create({ cause: known }))).toEqual(unknown);
    const cycle: { cause?: unknown; message: string } = { message: "TEST-secret cycle" }; cycle.cause = cycle;
    expect(normalizeResearchLaunchFailure(cycle)).toEqual(unknown);
    let chain: unknown = known;
    for (let depth = 0; depth < 7; depth += 1) chain = new Error("TEST-secret wrapper", { cause: chain });
    expect(normalizeResearchLaunchFailure(chain)).toEqual({ ...unknown, cause: C.FileDeadline, diagnostic: D.ResearchAdmission });
    expect(normalizeResearchLaunchFailure(new Error("TEST-secret eighth wrapper", { cause: chain }))).toEqual(unknown);
    expect(normalizeResearchLaunchFailure({ message: { toString: () => { reads += 1; return "hosted_research_launch_denied"; } },
      code: "ENOENT:TEST-secret", cause: "artifact-deadline:TEST-secret" })).toEqual(unknown);
    expect(reads).toBe(0);
  });

  // RED: an inspection is attributed to the wrong scratch role, its failure is
  // swallowed, or an unsupported errno/message escapes the closed observation.
  it.each([
    ["root", C.ScratchRoot, D.ETIMEDOUT], ["tmp", C.ScratchTmp, D.ScratchMountInspection],
    ["cache", C.ScratchCache, D.Unknown], ["cache observer", C.ScratchCache, D.ETIMEDOUT],
  ] as const)("identifies the actual %s mount inspection failure without replacing it", async (scenario, cause, diagnostic) => {
    const job = "/TEST-job", home = "/TEST-home", f = await preparedResearchScratch(job, home);
    const target = scenario === "root" ? f.root : scenario === "tmp" ? `${job}/tmp` : `${home}/plugins/cache`;
    const original = Object.assign(new Error(scenario === "tmp" ? "Ambiguous scratch mount inspection" : "TEST-secret /private/TEST-path"), {
      code: scenario === "cache" ? "EIO" : "ETIMEDOUT", stderr: "TEST-secret stderr", env: "TEST-secret env",
    });
    const inspect = f.host.inspectMount;
    f.host.inspectMount = path => { if (path === target) throw original; return inspect(path); };
    let failure: unknown;
    try {
      if (scenario === "cache observer") resolvePreparedHostScratchCacheBinds(home, f.host);
      else if (scenario === "cache") await prepareHostScratchCaches(home, {}, f.host);
      else await prepareHostScratchTemp(job, {}, f.host);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBe(original);
    const observation = normalizeResearchLaunchFailure(failure);
    expect(observation).toEqual({ legacyCode: "unclassified", cause, diagnostic });
    expect(JSON.stringify(observation)).not.toContain("TEST-");
    expect(f.mutations).toEqual([]);
  });

  // RED: post-bind inspection bypasses phase annotation or leaves its owned lock.
  it("retains a post-bind inspection failure while removing only its own lock", async () => {
    const job = "/TEST-job", f = await preparedResearchScratch(job, "/TEST-home"), target = `${job}/tmp`;
    const source = f.prepared.find(bind => bind.target === target)!.source;
    f.mounts.delete(target); f.nodes.delete(target); f.nodes.delete(source);
    const original = Object.assign(new Error("TEST-private post-bind failure"), { code: "ETIMEDOUT" });
    const inspect = f.host.inspectMount;
    f.host.inspectMount = path => { if (path === target && f.mounts.has(target)) throw original; return inspect(path); };
    let failure: unknown;
    try { await prepareHostScratchTemp(job, {}, f.host); } catch (error) { failure = error; }
    expect(failure).toBe(original);
    expect(normalizeResearchLaunchFailure(failure)).toEqual({ legacyCode: "unclassified", cause: C.ScratchTmp, diagnostic: D.ETIMEDOUT });
    expect(f.prepared.filter(bind => bind.target === target)).toHaveLength(2);
    expect(f.nodes.has(`${source}.lock`)).toBe(false);
  });

  // RED: annotation masks EACCES and turns a denied cache inspection into retryable recovery.
  it("preserves nonretryable permission recovery for a frozen cache inspection error", async () => {
    const home = "/TEST-home", f = await preparedResearchScratch("/TEST-job", home);
    const original = Object.freeze(Object.assign(new Error("EACCES: permission denied", { cause: "TEST-original cause" }), {
      code: "EACCES", stderr: "EACCES: permission denied", status: 1, syscall: "TEST-inspect", path: "/private/TEST-cache",
    }));
    const descriptors = Object.getOwnPropertyDescriptors(original), inspect = f.host.inspectMount;
    f.host.inspectMount = path => { if (path === `${home}/plugins/cache`) throw original; return inspect(path); };
    let failure: unknown;
    try { await prepareHostScratchCaches(home, {}, f.host); } catch (error) { failure = error; }
    expect(failure).toBe(original);
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors);
    expect(classifyCodexFailure(failure)).toMatchObject({ code: "permission_required", retryable: false, reconnectRequired: false });
    expect(normalizeResearchLaunchFailure(failure)).toEqual({ legacyCode: "unclassified", cause: C.ScratchCache, diagnostic: D.EACCES });
    expect(f.mutations).toEqual([]);
  });

  // RED: a neighboring filesystem failure is mislabeled as mount inspection.
  it("preserves an error thrown outside mount inspection without phase annotation", async () => {
    const f = await preparedResearchScratch("/TEST-job", "/TEST-home");
    const original = Object.assign(new Error("TEST-statfs failure"), { code: "ETIMEDOUT" });
    f.host.statfs = () => { throw original; };
    await expect(prepareHostScratchTemp("/TEST-job", {}, f.host)).rejects.toBe(original);
    expect(normalizeResearchLaunchFailure(original)).toEqual({ legacyCode: "unclassified", cause: C.None, diagnostic: D.ETIMEDOUT });
    expect(f.mutations).toEqual([]);
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

  it("transports a known role through the unchanged built bootstrap before Host imports", () => {
    const preload = fileURLToPath(new URL("./fixtures/research-material-role-preload.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", preload, "host-integration/research-runtime-launch.mjs"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5000,
    });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(70); expect(child.stdout).toBe("");
    expect(child.stderr).toBe("hosted_research_runtime_launch_denied:imports:0:file-deadline:research-admission:runtime-artifact\n");
    expect(child.stderr).not.toContain("TEST-private-bootstrap");
  });
  it("runs the built entrypoint's real catch and exits 70 with one bounded observation", () => {
    // Invalid arity fails before any Host import, admission, launch or provider work.
    const child = spawnSync(process.execPath, ["host-integration/research-runtime-launch.mjs"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(70);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("hosted_research_runtime_launch_denied:imports:unclassified:none:unknown:unknown\n");
  });
});

it("assembly failure exposes numeric location without message or host path", async () => {
  const { annotateResearchMaterialFailure, annotateScratchCapacityFailure, ScratchCapacityVolumeRole, ResearchMaterialRole, normalizeResearchAssemblyFailure } = await import("../research-launch-diagnostics");
  const error = new Error("TEST_SECRET_NEVER_PUBLISH");
  error.stack = "TEST_SECRET_NEVER_PUBLISH\n at read (/opt/private/dist/worker-codex/research-launch-admission.js:75:58)\n at check (/opt/private/dist/worker-codex/research-provider-root-assembler.js:123:9)";
  annotateResearchMaterialFailure(error, ResearchMaterialRole.RuntimeArtifact);
  annotateScratchCapacityFailure(error, ScratchCapacityVolumeRole.RootControl, 0, 1);
  const result = normalizeResearchAssemblyFailure(error);
  expect(result).toMatchObject({ assemblyLine: 123, assemblyColumn: 9, materialLine: 75, materialColumn: 58, materialRole: ResearchMaterialRole.RuntimeArtifact });
  expect(result).not.toHaveProperty("scratchCapacity");
  expect(JSON.stringify(result)).not.toContain("TEST_SECRET");
  expect(JSON.stringify(result)).not.toContain("/opt/private");
  let reads = 0;
  const foreign = new Error("TEST foreign");
  Object.defineProperty(foreign, "stack", { get() { reads++; throw new Error("TEST getter"); } });
  expect(normalizeResearchAssemblyFailure(foreign)).not.toHaveProperty("assemblyLine");
  expect(reads).toBe(0);
  expect(normalizeResearchAssemblyFailure({ materialRole: ResearchMaterialRole.CodexExecutable }).materialRole).toBe(ResearchMaterialRole.Unknown);
});
