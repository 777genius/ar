import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import * as urls from "node:url";
import * as admission from "../research-launch-admission";
import * as fixture from "./research-launch-fixture";
import { parseCodexGoalProjectAccessScope } from "../codex-goal-access-plan";
import { AccessBoundary, NetworkAccessMode, ProjectOperation } from "@vioxen/subscription-runtime/worker-core";
import { codexProjectAdmissionGate } from "../application/project-control/codex-goal-project-mutation-admission";
import { listCodexGoalJobs, readCodexGoalJob } from "../codex-goal-jobs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { buildRuntimeResultEnvelope, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { researchCurrentStart, researchJobAuthority } from "../research-launch-admission";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";
import * as researchLaunchHost from "../research-launch-host";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { runResearchProviderService } from "../research-provider-service";
import { finalizeOwnedMimoWorker } from "../research-launch-lifecycle";
import { withProtectedCodexGoalJobBirthPublication } from "../protected-job-birth";
import { withResearchJobMutationAsync } from "../research-job-mutation-lock";
import { createResearchJobWriterObservationPreparer, prepareResearchJobWriterObservation, observeResearchJobWriterAuthority } from "../research-writer-observation";
import * as provenance from "../research-job-runtime-provenance";
import { researchArtifactDigest } from "../research-launch-files";
import * as researchLaunchFiles from "../research-launch-files";
import * as runtimeArtifact from "../research-runtime-artifact";
import { host, local, enterResearchOperatorScope } from "./research-launch-fixture";
import { providerProxy, providerStreams } from "./research-provider-service-fixture";

type Allocation = ReturnType<typeof researchCurrentStart> & { jobId: string; startId: string; specSha256: string;
  unit: string; provider: string; home: string; helper: Parameters<typeof providerProxy>[0]["helper"]; manifest: CodexGoalJobManifest };
/** Uses the registered suite's real launch/grant/root plan, production provider
 * readiness/owner writer and finalizer. Only systemd/proc remain offline ports. */
export function registeredNativeWriterClosureTests(input: { allocation(configureScope?: () => void): Promise<Allocation>;
  scope(): ProjectAccessScope; setScope(scope: ProjectAccessScope): void; authorizeCurrentCaller(): Promise<unknown> }): void {
  async function terminal(configureScope?: () => void) {
    host.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), kill: vi.fn() }));
    const current = await input.allocation(configureScope);
    // As in the provider-service fixture, this process models the helper and
    // its parent models the bound runtime. Native identities are still parsed.
    host.units.get(current.unit)!.pid = process.ppid;
    researchPublish(join(current.directory, "binding.json"), { schemaVersion: 1, specSha256: current.specSha256,
      process: researchProcessIdentity(process.ppid), service: researchServiceIdentity(current.unit) });
    const held = current.helper.stdin as PassThrough;
    const forward = vi.spyOn(process.stdin, "pipe").mockImplementation(destination => held.pipe(destination));
    const { proxy, submit } = providerProxy({ ...current, forward }); host.spawn.mockImplementation(() => {
      const result = submit();
      // The service owner is the mount-isolated assembler MainPID. Its child
      // enters user/PID isolation; the retained MainPID keeps Host user/PID/net.
      host.processNamespaces.set(424242, { user: "user:[4026531837]", mnt: "mnt:[4026532841]",
        pid: "pid:[4026531836]", net: "net:[4026531840]" });
      return result;
    });
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    await runResearchProviderService(current.jobId, current.provider, current.home);
    for (const stream of providerStreams) { stream.unpipe(); stream.destroy(); } providerStreams.clear();
    expect(fs.existsSync(local(join(current.directory, "providers", current.provider + ".owner.json")))).toBe(true);
    for (const stream of [current.helper.stdin, current.helper.stdout, current.helper.stderr]) if (stream instanceof PassThrough) stream.destroy();
    const git = (args: string[]) => promisify(execFile)("git", ["-C", current.manifest.workspacePath, ...args], { env: {
      ...process.env, GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
      GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com" } });
    await git(["init"]); fs.writeFileSync(join(current.manifest.workspacePath, "closure.txt"), "TEST terminal closure\n");
    await git(["add", "closure.txt"]);
    for (const role of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) expect((await git(["var", role])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
    await git(["commit", "-m", "test: initialize closure fixture"]);
    fs.writeFileSync(join(current.manifest.workspacePath, "closure.txt"), "TEST preserved terminal change\n");
    researchPublish(join(current.directory, "mimo-candidate.json"), { schemaVersion: 1, jobId: current.jobId,
      taskId: current.spec.request.taskId, startId: current.startId, specSha256: current.specSha256,
      bindingSha256: researchHash(researchRead(join(current.directory, "binding.json"))),
      result: buildRuntimeResultEnvelope({ provider: "codex", runId: current.jobId, taskId: current.spec.request.taskId,
        status: "partial", evidence: ["TEST complete provider closure"], nextAction: "continue" }) });
    // Return the runtime identity to the fixture caller only for entering the
    // operator scope; retained binding remains the original parent identity.
    host.processGroups.set(process.ppid, "/system.slice/" + current.unit);
    host.units.get(current.unit)!.pid = process.pid;
    enterResearchOperatorScope(current.unit); host.units.get(current.unit)!.pid = process.ppid;
    await finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256);
    host.units.get(current.provider)!.active = false;
    const stat = vi.isMockFunction(fs.lstatSync) ? fs.lstatSync.getMockImplementation()! : fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
      if ([`/proc/${process.ppid}`, "/proc/424242"].includes(String(path))) throw Object.assign(Error("TEST original PID gone"), { code: "ENOENT" });
      return stat(path, options as fs.StatOptions & { bigint?: false });
    }) as typeof fs.lstatSync);
    return { ...current, leaf: join(current.directory, "writer-closure-observation.v1.json") };
  }
  describe("lazy native writer closure", () => {
    afterEach(() => { for (const stream of providerStreams) stream.destroy(); providerStreams.clear();
      Reflect.deleteProperty(globalThis, Symbol.for("TEST.nativeWriterOriginalEntryLoads")); });
    it("issues only inside mutation publication and independently reads closure after controller advance", async () => {
      const current = await terminal();
      expect(fs.existsSync(local(current.leaf))).toBe(false);
      expect(await observeResearchJobWriterAuthority(current.manifest)).toEqual({ status: "unknown" });
      expect(await (await prepareResearchJobWriterObservation(current.manifest))()).toEqual({ status: "released" });
      expect(fs.existsSync(local(current.leaf))).toBe(false);
      const read = await createResearchJobWriterObservationPreparer()(current.manifest);
      expect(await read()).toEqual({ status: "released" }); expect(fs.existsSync(local(current.leaf))).toBe(false);
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
      const receipt = researchRead(current.leaf); expect(JSON.parse(receipt.toString()).kind).toBe("registered-coding-terminal-closure-v1");
      const qualification = vi.mocked(runtimeArtifact.assertQualifiedResearchRuntimeArtifact);
      input.setScope({ ...input.scope(), allowedAccountIds: ["TEST-other"] });
      await expect(input.authorizeCurrentCaller()).rejects.toThrow();
      fs.writeFileSync(local(join(current.spec.registeredHandoff!.registryRootDir, "TEST-controller/job.json")), '{"advanced":true}', { mode: 0o600 });
      qualification.mockClear();
      const next = await createResearchJobWriterObservationPreparer()(current.manifest);
      expect(await withProtectedCodexGoalJobBirthPublication(next)).toEqual({ status: "released" });
      expect(await observeResearchJobWriterAuthority(current.manifest)).toEqual({ status: "released" });
      expect(qualification).not.toHaveBeenCalled(); expect(researchRead(current.leaf)).toEqual(receipt);
      const grant = join(researchJobAuthority(current.jobId), "grant.json"); researchPublish(grant, {});
      expect(await next()).toEqual({ status: "unknown" });
    });
    it("witnesses the queued-job fact in the unit state snapshot without a list-jobs command", async () => {
      const current = await terminal();
      const command = vi.spyOn(researchLaunchHost, "researchCommand");
      command.mockClear();
      const read = await createResearchJobWriterObservationPreparer()(current.manifest);
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
      const calls = command.mock.calls.filter(call => call[0] === "/usr/bin/systemctl") as [string, string[]][];
      // Every unit state check reads its queued-job fact from the same show
      // snapshot that carries the unit's state fields. Either a separate
      // list-jobs manager command per check or a state show that omits the Job
      // field changes this witnessed pair.
      expect(calls.filter(([, args]) => args[0] === "list-jobs")).toHaveLength(0);
      const shows = calls.filter(([, args]) => args[0] === "show");
      expect(shows.length).toBeGreaterThan(0);
      expect(shows.some(([, args]) => args.some(arg => arg.endsWith(",Job")))).toBe(true);
    });
    it("hoists one producer digest per preparation batch and still qualifies every job afresh", async () => {
      const current = await terminal(), runtimeDirectory = admission.installedResearchRuntimeDirectory();
      const effectiveDigest = researchLaunchFiles.researchArtifactDigest;
      const digest = vi.spyOn(researchLaunchFiles, "researchArtifactDigest").mockImplementation(effectiveDigest);
      const qualification = vi.mocked(runtimeArtifact.assertQualifiedResearchRuntimeArtifact);
      const effectiveQualify = qualification.getMockImplementation()!;
      qualification.mockImplementation((directory, artifactSha256) => effectiveQualify(directory, artifactSha256));
      digest.mockClear(); qualification.mockClear();
      const derivations = () => digest.mock.calls.filter(call => call[0] === runtimeDirectory).length;
      const batch = createResearchJobWriterObservationPreparer();
      const first = await batch(current.manifest);
      const firstDigests = derivations(), firstQualifications = qualification.mock.calls.length;
      const second = await batch(current.manifest);
      const sharedDigests = derivations() - firstDigests, sharedQualifications = qualification.mock.calls.length - firstQualifications;
      // One producer digest derivation is shared per batch, and only within a
      // batch; every job still freshly qualifies the retained digest. Both a
      // per-job re-derivation and a dropped per-job qualification change this
      // one-derivation difference.
      expect(firstDigests - sharedDigests).toBe(1);
      expect(sharedQualifications).toBeGreaterThan(0);
      const next = createResearchJobWriterObservationPreparer(), third = await next(current.manifest);
      expect(derivations()).toBe(firstDigests + sharedDigests + sharedDigests + 1);
      expect(qualification.mock.calls.length).toBeGreaterThan(firstQualifications + sharedQualifications);
      for (const read of [first, second, third])
        expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
      const issuer = JSON.parse(researchRead(current.leaf).toString()).issuer;
      expect(issuer.runtimeDirectory).toBe(runtimeDirectory);
      expect(issuer.artifactSha256).toBe(effectiveDigest(runtimeDirectory));
    });
    it("never waits for or removes a busy native mutex, and readonly calls never acquire it", async () => {
      const current = await terminal(), read = await createResearchJobWriterObservationPreparer()(current.manifest);
      await withResearchJobMutationAsync(current.jobId, async () => {
        expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
        expect(await (await prepareResearchJobWriterObservation(current.manifest))()).toEqual({ status: "released" });
        expect(fs.existsSync(local(current.leaf))).toBe(false);
      });
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
      expect(fs.existsSync(local(current.leaf))).toBe(true);
      await withResearchJobMutationAsync(current.jobId, async () => {
        expect(await observeResearchJobWriterAuthority(current.manifest)).toEqual({ status: "released" });
        expect(await (await prepareResearchJobWriterObservation(current.manifest))()).toEqual({ status: "released" });
      });
    });
    it("attests two actual foreign original readers then skips their code for an independent CreateJob preparation", async () => {
      const oldRoot = "/opt/subscription-runtime/releases/" + "a".repeat(40), currentRoot = "/opt/subscription-runtime/releases/" + "b".repeat(40);
      const fixtureRoot = join(process.cwd(), "src/worker-codex/tests/fixtures/native-writer-original-00bbb");
      const staticRuntime = join(fixtureRoot, "runtime");
      const bundle = fs.readFileSync(join(staticRuntime, "dist/worker-codex/research-writer-observation.js"));
      const bundleInputs = JSON.parse(fs.readFileSync(join(fixtureRoot, "bundle-inputs.json"), "utf8"));
      expect(researchHash(bundle)).toBe(bundleInputs.bundleSha256);
      expect(bundleInputs.sourceBase).toBe("00bbb0f060779a884c307c3d4a95a84a9ffd38ae");
      for (const root of [oldRoot, currentRoot]) {
        fs.mkdirSync(local(dirname(root)), { recursive: true, mode: 0o700 });
        fs.cpSync(local("/TEST-artifact"), local(root), { recursive: true });
      }
      const oldEntry = join(oldRoot, "dist/worker-codex/research-writer-observation.js");
      for (const output of [...bundleInputs.outputs, ...bundleInputs.assets] as { path: string; sha256: string }[]) {
        const bytes = fs.readFileSync(join(staticRuntime, output.path)); expect(researchHash(bytes)).toBe(output.sha256);
        const target = local(join(oldRoot, output.path)); fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, bytes, { mode: 0o600 }); expect(researchHash(fs.readFileSync(target))).toBe(output.sha256);
      }
      expect(researchHash(fs.readFileSync(local(oldEntry)))).toBe(bundleInputs.bundleSha256);
      fs.writeFileSync(local(join(currentRoot, "dist/current-observer.js")), "TEST current observer artifact", { mode: 0o600 });
      const nativeUrl = urls.fileURLToPath;
      const oldBackingRoot = local(oldRoot); let activeRoot = oldRoot;
      vi.spyOn(urls, "fileURLToPath").mockImplementation(((value: URL | string) => {
        const path = nativeUrl(value);
        return (path === oldBackingRoot + "/" || path === staticRuntime + "/") ? oldRoot + "/" : path === "/TEST-artifact/" ? activeRoot + "/" : path;
      }) as typeof urls.fileURLToPath);
      vi.mocked(runtimeArtifact.assertQualifiedResearchRuntimeArtifact).mockRestore();
      const qualifyArtifact = runtimeArtifact.assertQualifiedResearchRuntimeArtifact;
      vi.spyOn(runtimeArtifact, "assertQualifiedResearchRuntimeArtifact").mockImplementation(qualifyArtifact);
      const originalRequest = fixture.request;
      const configured = () => {
        const parsed = parseCodexGoalProjectAccessScope({ ...input.scope(), workspaceRoots: [join(host.root, "project/jobs")] });
        if (!parsed) throw Error("Expected explicit TEST controller scope"); input.setScope(parsed);
        const scope = input.scope(), controllerRoot = "/TEST-project/controller";
        fs.writeFileSync(local(join(scope.registryRoot!, "TEST-controller/job.json")), JSON.stringify({ schemaVersion: 1,
          jobId: "TEST-controller", taskId: "TEST-controller", jobRootDir: controllerRoot,
          workspacePath: controllerRoot, promptPath: controllerRoot + "/prompt.md", accounts: ["account-q"],
          createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
          accessBoundary: AccessBoundary.ProjectScopedControl, networkAccess: NetworkAccessMode.Unrestricted, projectAccessScope: scope }), { mode: 0o600 });
      };
      const jobs: Awaited<ReturnType<typeof terminal>>[] = [];
      for (let index = 0; index < 2; index++) {
        host.processGroups.delete(process.pid); host.processGroups.delete(process.ppid);
        const jobId = "TEST-research-foreign-" + index, jobRootDir = join(host.root, "project/jobs", jobId);
        fs.mkdirSync(join(jobRootDir, "workspace"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(join(jobRootDir, "prompt.md"), "TEST foreign writer", { mode: 0o600 });
        const base = originalRequest();
        vi.spyOn(fixture, "request").mockReturnValue({ ...base, jobId, taskId: jobId, jobRootDir,
          workspacePath: join(jobRootDir, "workspace"), promptPath: join(jobRootDir, "prompt.md"), authRootDir: join(host.root, "auth") });
        const current = await terminal(configured);
        expect(current.spec.runtimeDirectory).toBe(oldRoot); jobs.push(current);
      }
      activeRoot = currentRoot;
      expect(admission.installedResearchRuntimeDirectory()).toBe(currentRoot);
      for (const job of jobs) {
        expect(researchArtifactDigest(oldRoot)).toBe(job.spec.artifactSha256);
        qualifyArtifact(oldRoot, job.spec.artifactSha256);
        expect(researchHash(researchRead(join(researchJobAuthority(job.jobId), "grant.json")))).toBe(job.spec.grantSha256);
        for (const key of ["jobId", "taskId", "jobRootDir", "workspacePath", "promptPath", "modelBackend"] as const)
          expect(job.spec.request[key], key).toBe(job.manifest[key]);
        expect(provenance.researchForeignWriterRuntimeProvenance(job.manifest)?.runtimeDirectory).toBe(oldRoot);
      }
      // The immutable static module actually loaded must match every byte in
      // the independently qualified logical artifact after both preparations.
      for (const output of [...bundleInputs.outputs, ...bundleInputs.assets] as { path: string; sha256: string }[]) {
        const staticBytes = fs.readFileSync(join(staticRuntime, output.path));
        expect(researchHash(staticBytes)).toBe(output.sha256);
        expect(fs.readFileSync(local(join(oldRoot, output.path)))).toEqual(staticBytes);
      }
      const logicalUrl = urls.pathToFileURL(oldEntry).href;
      const loadKey = Symbol.for("TEST.nativeWriterOriginalEntryLoads"), globals = globalThis as Record<symbol, unknown>;
      Reflect.deleteProperty(globals, loadKey);
      const entryLoads = () => Number(globals[loadKey] ?? 0);
      let priorLoads = entryLoads();
      const directoryRead = fs.readdirSync; let oldQualifications = 0;
      vi.spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
        if (String(path) === join(oldRoot, "dist")) oldQualifications++;
        return directoryRead(path, options as never);
      }) as typeof fs.readdirSync);
      async function observeAdmission(operation: ProjectOperation) {
        const captured = new Map<string, () => Promise<import("@vioxen/subscription-runtime/worker-core").ProjectAdmissionWriterObservation>>();
        expect((await listCodexGoalJobs({ registryRootDir: jobs[0]!.spec.registeredHandoff!.registryRootDir })).map(job => job.jobId)).toEqual(expect.arrayContaining(jobs.map(job => job.jobId)));
        const gate = codexProjectAdmissionGate({ registryRootDir: jobs[0]!.spec.registeredHandoff!.registryRootDir,
          controllerJobId: "TEST-controller", scope: input.scope(), deps: {
            listJobs: listCodexGoalJobs, readJob: readCodexGoalJob, buildOverviewItems: async () => [],
            createWriterObservationPreparer: () => {
              const prepare = createResearchJobWriterObservationPreparer();
              return async manifest => { const read = await prepare(manifest); captured.set(manifest.jobId, read); return read; };
            },
          } });
        await gate.prepare!({ operation });
        expect([...captured.keys()]).toEqual(expect.arrayContaining(jobs.map(job => job.jobId)));
        if (operation === ProjectOperation.CreateWorktree) expect(entryLoads() - priorLoads, "actual original entry load").toBeGreaterThan(0);
        for (const job of jobs) expect(await withProtectedCodexGoalJobBirthPublication(captured.get(job.jobId)!)).toEqual({ status: "released" });
      }
      await observeAdmission(ProjectOperation.CreateWorktree);
      expect(oldQualifications).toBeGreaterThan(0);
      const original = await import(logicalUrl);
      expect(original.originalRuntimeDirectory()).toBe(oldRoot);
      expect(admission.installedResearchRuntimeDirectory()).toBe(currentRoot);
      const seals = jobs.map(job => researchRead(job.leaf));
      for (const seal of seals) expect(JSON.parse(seal.toString()).published.some((row: { path: string }) => row.path.endsWith("/manifest.json"))).toBe(true);
      expect(JSON.parse(seals[0]!.toString()).identity.jobId).not.toBe(JSON.parse(seals[1]!.toString()).identity.jobId);
      expect(JSON.parse(seals[0]!.toString()).providerUnits).not.toEqual(JSON.parse(seals[1]!.toString()).providerUnits);
      priorLoads = entryLoads(); oldQualifications = 0;
      await observeAdmission(ProjectOperation.CreateJob);
      expect(entryLoads() - priorLoads).toBe(0); expect(oldQualifications).toBe(0);
      expect(jobs.map(job => researchRead(job.leaf))).toEqual(seals);
    }, 120_000);
    it("never turns an injected foreign Released reader into a durable issuer", async () => {
      const current = await terminal(), directory = "/opt/subscription-runtime/releases/" + "e".repeat(40);
      for (const name of ["dist", "host-integration", "node_modules"]) fs.mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(directory, "package.json"), '{"type":"module"}', { mode: 0o600 });
      fs.writeFileSync(join(directory, "dist/forged.js"), "TEST untrusted injected composition", { mode: 0o600 });
      const artifactSha256 = researchArtifactDigest(directory);
      // This is deliberately forged input, never a genuine foreign success
      // fixture. Real physical/native facts cannot authenticate this callback.
      vi.spyOn(provenance, "researchForeignWriterRuntimeProvenance").mockReturnValue({ runtimeDirectory: directory,
        artifactSha256, assertCurrent: vi.fn() });
      vi.mocked(runtimeArtifact.assertQualifiedResearchRuntimeArtifact).mockImplementation((path, hash) => {
        expect(researchArtifactDigest(path)).toBe(hash);
      });
      const forged = vi.fn(async () => ({ status: "released" as const }));
      const importer = vi.fn(async () => ({ prepareResearchJobWriterObservation: async () => forged }));
      const read = await createResearchJobWriterObservationPreparer(importer)(current.manifest);
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
      expect(importer).toHaveBeenCalledOnce(); expect(forged).toHaveBeenCalledOnce();
      expect(fs.existsSync(local(current.leaf))).toBe(false);
    });
    it("refuses physical counterevidence appearing after the original retained read", async () => {
      const current = await terminal(), read = await createResearchJobWriterObservationPreparer()(current.manifest);
      const qualification = vi.mocked(runtimeArtifact.assertQualifiedResearchRuntimeArtifact), qualify = qualification.getMockImplementation()!;
      let calls = 0;
      qualification.mockImplementation((directory, digest) => {
        qualify(directory, digest);
        if (++calls === 2) host.jobs.add(current.provider);
      });
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "unknown" });
      expect(calls).toBe(2); expect(fs.existsSync(local(current.leaf))).toBe(false);
    });
    it.each(["candidate", "provider-owner", "active", "manifest", "publication", "packet"] as const)("refuses %s drift after fast preparation", async fault => {
      const current = await terminal(), first = await createResearchJobWriterObservationPreparer()(current.manifest);
      expect(await withProtectedCodexGoalJobBirthPublication(first)).toEqual({ status: "released" });
      const read = await createResearchJobWriterObservationPreparer()(current.manifest), receipt = researchRead(current.leaf);
      const path = fault === "active" ? join(researchJobAuthority(current.jobId), "active.json")
        : fault === "provider-owner" ? join(current.directory, "providers", current.provider + ".owner.json")
        : fault === "manifest" ? join(current.spec.registeredHandoff!.registryRootDir, current.jobId, "job.json")
        : fault === "packet" ? (JSON.parse(receipt.toString()).published as { path: string }[]).find(row => row.path.endsWith("/manifest.json"))!.path
        : join(current.directory, fault === "candidate" ? "mimo-candidate.json" : "mimo-publication.json");
      researchPublish(path, {});
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "unknown" });
      expect(researchRead(current.leaf)).toEqual(receipt);
    });
    it("keeps a partial exclusive leaf and independently repeats the original observation", async () => {
      const current = await terminal(), read = await createResearchJobWriterObservationPreparer()(current.manifest);
      fs.writeFileSync(local(current.leaf), "{", { mode: 0o600 });
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "released" });
      expect(researchRead(current.leaf).toString()).toBe("{");
      fs.writeFileSync(local(join(current.spec.registeredHandoff!.registryRootDir, "TEST-controller/job.json")), '{"revoked":true}', { mode: 0o600 });
      expect(await withProtectedCodexGoalJobBirthPublication(read)).toEqual({ status: "unknown" });
      expect(researchRead(current.leaf).toString()).toBe("{");
    });
  });
}
