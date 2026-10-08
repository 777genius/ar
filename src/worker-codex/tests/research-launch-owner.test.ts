import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grantResearchLaunch, startResearchLaunch, revokeResearchLaunch } from "../research-launch-owner";
import { bindResearchRuntime, captureResearchRuntime, admitResearchProcessFactory, admitResearchRuntime, researchCurrentStart, researchProviderAdmissionGuard } from "../research-launch-admission";
import { researchArtifactDigest, researchDirectoryIdentity, researchHash, researchPromptBytes, researchPublish, researchRead } from "../research-launch-files";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { cancelResearchLaunch, statusResearchLaunch } from "../research-launch-lifecycle";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId, CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { FileBackendCodexSessionSeeder } from "../file-backend-codex-session-seeding";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { researchRunConfig, parseResearchOperatorRequest } from "../research-launch-contract";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { codexAuthJsonForAccount, StaticRunner } from "./file-backend-codex-worker-test-support";
import { spawnCodexAppServerProcess } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { ensureCodexAgentTempRoot } from "../../provider-codex/codex-runtime-temp";
import { hostedTestEgressGrantName, readHostedTestEgressGrantFile } from "../hosted-test-egress-files";
import { researchCustody } from "../research-launch-files";
import { normalizeResearchOperatorFailure, ResearchLaunchStage as S, ResearchLaunchCause as C,
  ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.FullInternetV1);
function start(profileId = CodexProviderEgressProfileId.FullInternetV1) {
  const r = request(); grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  if (profileId !== CodexProviderEgressProfileId.FullInternetV1) {
    const path = join("/run/user/subscription-runtime-research-v1", researchHash(r.jobId), "grant.json");
    researchPublish(path, { ...JSON.parse(researchRead(path).toString()), profileId });
  }
  return startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
}
function admitted(profileId = CodexProviderEgressProfileId.FullInternetV1) {
  const result = start(profileId); host.group = `/system.slice/${result.unit}`;
  bindResearchRuntime(result.jobId, result.startId);
  return { ...result, ...researchCurrentStart(result.jobId) };
}
const invocation = () => ({ command: request().codexBinaryPath, args: ["app-server"], cwd: request().workspacePath,
  env: { HOME: join(request().jobRootDir, "home"), CODEX_HOME: join(request().jobRootDir, "home", "TEST-a"), SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } });

describe("authority changes during blocking Host observations", () => {
  it.each(["none", "grant", "closing", "active"])("rechecks %s before publishing a binding after systemctl returns", async fault => {
    const started = start(); host.group = `/system.slice/${started.unit}`;
    const current = researchCurrentStart(started.jobId);
    const processes = await import("node:child_process"), sync = processes.spawnSync;
    let observed = 0;
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      const response = sync(command, args, options);
      if (command === "/usr/bin/systemctl" && args[0] === "show" && args[1] === started.unit) {
        observed++;
        if (fault === "grant") revokeResearchLaunch(started.jobId);
        if (fault === "closing") researchPublish(join(current.directory, "closing.json"), { schemaVersion: 1 });
        if (fault === "active") unlinkSync(local(join("/run/user/subscription-runtime-research-v1", researchHash(started.jobId), "active.json")));
      }
      return response;
    }) as typeof processes.spawnSync);
    if (fault === "none") expect(bindResearchRuntime(started.jobId, started.startId).startId).toBe(started.startId);
    else expect(() => bindResearchRuntime(started.jobId, started.startId)).toThrow();
    expect(observed).toBe(1);
    expect(existsSync(local(join(current.directory, "binding.json")))).toBe(fault === "none");
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each(["none", "grant", "closing", "binding"])("rechecks captured %s after the final systemctl observation", async fault => {
    const current = admitted(), captured = captureResearchRuntime(request());
    const processes = await import("node:child_process"), sync = processes.spawnSync;
    let observed = 0;
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      const response = sync(command, args, options);
      if (command === "/usr/bin/systemctl" && args[0] === "show" && args[1] === current.unit) {
        observed++;
        if (fault === "grant") revokeResearchLaunch(current.jobId);
        if (fault === "closing") researchPublish(join(current.directory, "closing.json"), { schemaVersion: 1 });
        if (fault === "binding") researchPublish(join(current.directory, "binding.json"), {
          ...JSON.parse(researchRead(join(current.directory, "binding.json")).toString()), specSha256: "e".repeat(64),
        });
      }
      return response;
    }) as typeof processes.spawnSync);
    if (fault === "none") expect(() => captured.assertAuthorityCurrent()).not.toThrow();
    else expect(() => captured.assertAuthorityCurrent()).toThrow();
    expect(observed).toBe(1);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
});

describe("closed installed research launch owner (real TEST files; proc, mounts and systemd substituted)", () => {
  it.each([undefined, null, 42, "TEST-FAKE-secret"])("rethrows opaque pin failure %s unchanged", async original => {
    const processes = await import("node:child_process"), sync = processes.spawnSync;
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/mount") throw original;
      return sync(command, args, options);
    }) as typeof processes.spawnSync);
    let rejected = false;
    try { start(); } catch (error) {
      rejected = true; expect(error).toBe(original);
      expect(normalizeResearchOperatorFailure(error)).toEqual({ stage: S.Unknown,
        diagnostic: D.Unknown, cause: C.None, legacyCode: "unclassified" });
    }
    expect(rejected).toBe(true);
    expect(researchCurrentStart(request().jobId).spec.request.jobId).toBe(request().jobId);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // RED: a failed outer start loses its exact phase/cause or discards active ownership.
  it.each(["pin", "submission"] as const)("retains closed %s failure evidence without provider effects", async fault => {
    const processes = await import("node:child_process"), sync = processes.spawnSync;
    const original = Object.freeze(Object.assign(new Error("TEST-FAKE-secret=/private/auth.json"), { code: "EACCES" }));
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (fault === "pin" && command === "/usr/bin/mount") throw original;
      if (fault === "submission" && command === "/usr/bin/systemd-run") {
        return { error: Object.assign(new Error("TEST-FAKE-secret"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "TEST-FAKE-secret" };
      }
      return sync(command, args, options);
    }) as typeof processes.spawnSync);
    let failure: unknown;
    try { start(); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    if (fault === "pin") expect(failure).toBe(original);
    expect(normalizeResearchOperatorFailure(failure)).toEqual(fault === "pin"
      ? { stage: S.PinPreparation, diagnostic: D.EACCES, cause: C.None, legacyCode: "unclassified" }
      : { stage: S.HostSubmission, diagnostic: D.ResearchAdmission, cause: C.HostCommandTimeout, legacyCode: 0 });
    const current = researchCurrentStart(request().jobId);
    expect(existsSync(local(join(current.directory, "spec.json")))).toBe(true);
    expect(existsSync(local(join(current.directory, "binding.json")))).toBe(false);
    expect(readdirSync(local(join(current.directory, "providers")))).toEqual([]);
    expect(host.units.size).toBe(0);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(JSON.stringify(normalizeResearchOperatorFailure(failure))).not.toContain("TEST-FAKE");
  });
  it("retains the finite identity and bytes of an existing v1 grant through admission", async () => {
    admitted(CodexProviderEgressProfileId.PublicResearchV1);
    const path = join("/run/user/subscription-runtime-research-v1", researchHash(request().jobId), "grant.json");
    const before = researchRead(path);
    const legacy = await admitHostedTestEgress({ ...request(), sourceEnv: {} });
    expect(legacy).toEqual(codexProviderEgressPolicy(CodexProviderEgressProfileId.PublicResearchV1));
    expect(captureResearchRuntime(request()).profileId).toBe(CodexProviderEgressProfileId.PublicResearchV1);
    expect(researchRead(path)).toEqual(before);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it("launches an individually owned pinned service and admits its actual retained origin before provider effects", async () => {
    const processes = await import("node:child_process"), submit = vi.spyOn(processes, "spawnSync");
    const current = admitted();
    const submitted = host.calls.find(c => c.command === "/usr/bin/systemd-run")!;
    expect(submitted.args).toContain("--property=KillMode=control-group");
    expect(submitted.args).toContain("--property=Restart=no");
    // Regression: inherited systemd90s and operator60s deadlines terminate
    // namespace setup before exec, despite the admitted finite300s setup bound.
    expect(submitted.args).toContain("--property=TimeoutStartSec=300s");
    expect(submit.mock.calls.find(([command]) => command === "/usr/bin/systemd-run")?.[2]).toMatchObject({ timeout: 330_000 });
    expect(submitted.args).toContain("--expand-environment=no");
    expect(submitted.args.at(-3)).toBe("/TEST-artifact/host-integration/research-runtime-launch.mjs");
    expect(host.pins.size).toBe(2);
    expect(JSON.parse(readFileSync(local(join(current.directory, "binding.json")), "utf8"))).toMatchObject({
      process: { pid: process.pid, birthTicks: "12345", controlGroup: host.group }, service: { unit: current.unit, mainPid: process.pid } });
    expect(await admitHostedTestEgress({ ...request(), sourceEnv: {} })).toEqual(policy);
    const factory = admitHostedReadonlyInputs({ ...request(), executionEngine: "app-server-goal", sourceEnv: {}, providerEgressPolicy: policy })!;
    expect(researchProviderAdmissionGuard(factory)).toBeTypeOf("function");
    factory(invocation());
    expect(host.spawn).toHaveBeenCalledOnce();
    expect(host.spawn.mock.calls[0]![1][0]).toBe("/TEST-artifact/host-integration/research-provider-launch.mjs");
    expect(host.spawn.mock.calls[0]![1]).toEqual(["/TEST-artifact/host-integration/research-provider-launch.mjs", request().jobId,
      expect.stringMatching(/^subscription-runtime-research-provider-.*\.service$/), invocation().env.CODEX_HOME]);
    const records = (await import("node:fs")).readdirSync(local(join(current.directory, "providers")));
    expect(records).toHaveLength(1); expect(records[0]).toMatch(/^subscription-runtime-research-provider-.*\.service\.json$/);
  });
  it("accepts selected prompt data below group-writable foreign project ancestry while keeping authority root private", () => {
    host.projectParent = true; chmodSync(local("/TEST-project"), 0o2771);
    const current = admitted();
    expect(researchPromptBytes(current.spec.jobDirectory, request().promptPath).toString()).toBe("TEST public research prompt");
    expect(captureResearchRuntime(request()).spec.grantSha256).toBe(current.spec.grantSha256);
    expect(() => researchRead(request().promptPath)).toThrow(); // That ancestry is not a private authority reader.
  });
  it.each(["wrong-uid", "namespace-root", "mapped-root", "global", "unsafe-artifact", "wrong-request-digest", "wrong-grant-tuple", "foreign-prompt", "symlink-prompt", "hardlink-prompt"])("rejects %s before mount/service effects", fault => {
    grantResearchLaunch(request().jobId, request().jobRootDir, request().workspacePath);
    const bytes = researchRead("/TEST-operator/request.json"), digest = researchHash(bytes);
    if (fault === "wrong-uid") vi.spyOn(process, "getuid").mockReturnValue(65532);
    if (fault === "namespace-root") host.namespaceRoot = true;
    if (fault === "mapped-root") host.uidMap = "0 1000 1";
    if (fault === "global") host.global = true;
    if (fault === "unsafe-artifact") chmodSync(local("/TEST-artifact/host-integration"), 0o775);
    if (fault === "wrong-grant-tuple") {
      const path = join("/run/user/subscription-runtime-research-v1", researchHash(request().jobId), "grant.json");
      const grant = JSON.parse(researchRead(path).toString()); researchPublish(path, { ...grant, workspacePath: "/TEST-project/jobs/other/workspace" });
    }
    if (fault === "foreign-prompt") host.foreign.add(request().promptPath);
    if (fault === "symlink-prompt") { unlinkSync(local(request().promptPath)); symlinkSync(local("/TEST-operator/request.json"), local(request().promptPath)); }
    if (fault === "hardlink-prompt") linkSync(local(request().promptPath), join(host.root, "prompt-copy"));
    expect(() => startResearchLaunch("/TEST-operator/request.json", fault === "wrong-request-digest" ? "d".repeat(64) : digest)).toThrow();
    expect(host.calls).toHaveLength(0); expect(host.spawn).not.toHaveBeenCalled();
  });
  it.each(["job", "root", "workspace", "pid", "birth", "boot", "unit-owner", "service-invocation", "unit-fragment", "binding", "artifact", "executable", "grant", "revoked", "global", "principal", "closing"])("rechecks captured %s before provider spawn and account auth/fallback", async fault => {
    const current = admitted(), factory = admitResearchProcessFactory(request());
    const guard = researchProviderAdmissionGuard(factory)!;
    // Positive nearest control: the same retained factory can submit while valid.
    factory(invocation()); expect(host.spawn).toHaveBeenCalledOnce(); host.spawn.mockClear();
    let identity = request();
    if (fault === "job") identity = { ...identity, jobId: "TEST-other" };
    if (fault === "root") identity = { ...identity, jobRootDir: "/TEST-project/jobs/TEST-other" };
    if (fault === "workspace") identity = { ...identity, workspacePath: "/TEST-project/jobs/TEST-other/workspace" };
    if (fault === "pid") host.units.get(current.unit)!.pid++;
    if (fault === "birth") host.birth = "12346";
    if (fault === "boot") host.boot = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    if (fault === "unit-owner") host.units.get(current.unit)!.description = "foreign TEST service";
    if (fault === "service-invocation") host.units.get(current.unit)!.invocation = "d".repeat(32);
    if (fault === "unit-fragment") writeFileSync(local(`/run/systemd/transient/${current.unit}`), "TEST replaced unit fragment");
    if (fault === "binding") researchPublish(join(current.directory, "binding.json"), { ...JSON.parse(researchRead(join(current.directory, "binding.json")).toString()), specSha256: "e".repeat(64) });
    if (fault === "artifact") writeFileSync(local("/TEST-artifact/dist/main.js"), "TEST changed runtime");
    if (fault === "executable") writeFileSync(join(host.root, "executable"), "TEST changed native executable");
    if (fault === "grant") {
      const path = join("/run/user/subscription-runtime-research-v1", researchHash(request().jobId), "grant.json");
      researchPublish(path, { ...JSON.parse(researchRead(path).toString()), grantId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
    }
    if (fault === "revoked") revokeResearchLaunch(current.jobId);
    if (fault === "global") host.global = true;
    if (fault === "principal") host.namespaceRoot = true;
    if (fault === "closing") researchPublish(join(current.directory, "closing.json"), { schemaVersion: 1 });
    if (["job", "root", "workspace"].includes(fault)) {
      expect(() => captureResearchRuntime(identity)).toThrow();
    } else {
      expect(() => factory(invocation())).toThrow();
      const seeder = new FileBackendCodexSessionSeeder({ assertProviderAdmission: guard, providerInstanceId: "TEST-b",
        sessionStore: {} as never, observability: {} as never, clock: {} as never, agentId: "TEST",
        onFailure: vi.fn(), onAuthImported: vi.fn(), rememberQuotaGroup: vi.fn() });
      await expect(seeder.seedAuthJsonFile("/TEST-auth/TEST-b/auth.json")).rejects.toThrow();
      await expect(seeder.importAuthJsonFileIfChanged("run")).rejects.toThrow();
      const options = { stateRootDir: join(host.root, "state"), workspacePath: join(host.root, "workspace"), accounts: [], assertProviderAdmission: guard };
      expect(() => new FileBackendCodexSafeExecutor(options)).toThrow();
    }
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it("captures one guard for every real account slot and blocks a mutated admission before options touch auth", () => {
    host.physicalPaths = true;
    writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(request()) + "\n");
    admitted(); const factory = admitResearchProcessFactory(request());
    const config = researchRunConfig(parseResearchOperatorRequest(request()));
    expect(config.appServerStartupTimeoutMs).toBe(330_000);
    const options = buildCodexGoalExecutorOptions({ config, providerEgressPolicy: policy, appServerProcessFactory: factory,
      stateRootDir: join(host.root, "state"), encryptionKey: new Uint8Array(32) });
    expect(options.accounts).toHaveLength(2);
    expect(options.accounts[0]!.worker.assertProviderAdmission).toBe(options.accounts[1]!.worker.assertProviderAdmission);
    revokeResearchLaunch(request().jobId);
    expect(() => options.accounts[1]!.worker.assertProviderAdmission!()).toThrow();
    expect(() => buildCodexGoalExecutorOptions({ config, providerEgressPolicy: policy, appServerProcessFactory: factory,
      stateRootDir: join(host.root, "state"), encryptionKey: new Uint8Array(32) })).toThrow();
  });
  it.each([
    { revoked: false, serviceTier: "default" }, { revoked: true, serviceTier: "default" },
    { revoked: false, serviceTier: "fast" }, { revoked: false, serviceTier: "priority" },
  ])("uses real executor account fallback with substituted provider transport ($serviceTier, revoked=$revoked)", async ({ revoked, serviceTier }) => {
    host.physicalPaths = true;
    const operatorRequest = { ...request(), serviceTier };
    writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(operatorRequest) + "\n");
    admitted(); const factory = admitResearchProcessFactory(request());
    for (const account of request().accounts) writeFileSync(join(request().authRootDir, account, "auth.json"), codexAuthJsonForAccount(`TEST-refresh-${account}`, account), { mode: 0o600 });
    let readsAtRevocation = -1;
    const first = new FakeAppServerFactory({ exitOnStdinEnd: true, emitTopLevelErrorsOnTurns: ["You've hit your usage limit"], onRequest: req => {
      if (revoked && req.method === "turn/start") { readsAtRevocation = host.authReads; revokeResearchLaunch(request().jobId); }
    } });
    const second = new FakeAppServerFactory({ exitOnStdinEnd: true, goalStatusesAfterTurns: ["complete"] });
    host.spawn.mockImplementation((_command, _args, input) => {
      const fake = (host.spawn.mock.calls.length === 1 ? first : second).create({ env: input.env, cwd: input.cwd, args: [] });
      const write = fake.stdin.write;
      fake.stdin.write = chunk => {
        if (String(chunk).includes('"schemaVersion":1') && String(chunk).includes('"command":')) return true;
        return write(chunk);
      };
      return fake;
    });
    const config = { ...researchRunConfig(parseResearchOperatorRequest(operatorRequest)), prewarmOnStart: false, requireGitWorkspace: false };
    // This fixture enters the executor directly; reproduce the real runner's
    // fixed temp preparation now that research supplies the complete contract.
    await ensureCodexAgentTempRoot({ sourceEnv: config.sourceEnv });
    expect(config.serviceTier).toBe(serviceTier);
    const options = buildCodexGoalExecutorOptions({ config, providerEgressPolicy: policy, appServerProcessFactory: factory,
      stateRootDir: join(request().jobRootDir, "state"), encryptionKey: new Uint8Array(32) });
    const clock = { now: () => new Date("2026-05-31T00:01:00Z"), monotonicMs: () => performance.now() };
    const executor = new FileBackendCodexSafeExecutor({ ...options, clock,
      accounts: options.accounts.map(account => ({ ...account, worker: { ...account.worker, clock, runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }), cleanThreadPrewarm: false, warmupPrompt: false } })) });
    try {
      const result = await executor.run({ jobId: request().jobId, taskId: request().taskId, runId: "TEST-run", prompt: "Research TEST sources",
        controls: { editMode: "allow-edits", providerSandboxMode: "workspace-write" } });
      if (revoked) {
        expect(result.status).not.toBe("completed"); expect(second.spawnCount).toBe(0);
        expect(host.authReads).toBe(readsAtRevocation);
      } else {
        expect(result.status).toBe("completed"); expect(first.spawnCount).toBe(1); expect(second.spawnCount).toBe(1);
        expect(first.codexHomes[0]).not.toBe(second.codexHomes[0]);
        for (const provider of [first, second]) {
          const start = provider.requests.find(req => req.method === "thread/start" && (req.params?.dynamicTools as unknown[])?.length);
          expect(start?.params).toMatchObject({ serviceTier, model: "gpt-6.1-sol", config: { service_tier: serviceTier, web_search: "live" } });
          const features = (start!.params!.config as { features: Record<string, unknown> }).features;
          if (serviceTier === "fast") expect(features.fast_mode).toBe(true);
          else expect(features.fast_mode).toBeUndefined();
        }
      }
    } finally { await executor.dispose(); }
  });
  it.each(["FAST", "no-fast", "urgent", "", null, true, 1, {}, undefined])("refuses unsupported service tier %s before operator effects", serviceTier => {
    expect(() => parseResearchOperatorRequest({ ...request(), serviceTier })).toThrow("hosted_research_launch_denied");
    expect(host.calls).toHaveLength(0); expect(host.spawn).not.toHaveBeenCalled();
  });
  it("hashes the actual workspace dependency closure, including changed target bytes, and amortizes unchanged file hashes", () => {
    symlinkSync("../packages/dependency", local("/TEST-artifact/node_modules/dependency"));
    const started = performance.now(), first = researchArtifactDigest("/TEST-artifact"), elapsed = performance.now() - started;
    expect(researchArtifactDigest("/TEST-artifact")).toBe(first);
    writeFileSync(local("/TEST-artifact/packages/dependency/index.js"), "TEST mutated target executable");
    expect(researchArtifactDigest("/TEST-artifact")).not.toBe(first);
    expect(elapsed).toBeLessThan(4000);
    symlinkSync("/TEST-auth", local("/TEST-artifact/node_modules/foreign"));
    expect(() => researchArtifactDigest("/TEST-artifact")).toThrow();
  });
  it("a replacement project root cannot satisfy its pinned inode identity", () => {
    const identity = researchDirectoryIdentity(request().jobRootDir);
    renameSync(local(request().jobRootDir), local(request().jobRootDir) + "-retired");
    mkdirSync(local(request().jobRootDir));
    expect(() => researchPromptBytes(identity, request().promptPath)).toThrow();
  });
  it("forged markers select no research authority; actual service membership cannot take the plain child path", async () => {
    expect(admitResearchRuntime(request())).toBeUndefined();
    // Uninstalled ordinary callers keep API-only egress; a forged profile
    // supplies neither research authority nor an admitted readonly factory.
    const sourceEnv = {
      SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: policy.profileId,
    };
    const ordinary = await admitHostedTestEgress({ ...request(), sourceEnv });
    expect(ordinary).toEqual({ profileId: CodexProviderEgressProfileId.ProviderApi, domains: ["api.openai.com"] });
    expect(admitHostedReadonlyInputs({ ...request(), sourceEnv, providerEgressPolicy: ordinary })).toBeUndefined();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    admitted();
    // The default factory has no captured research ticket and remains closed.
    expect(() => spawnCodexAppServerProcess({ ...invocation(), env: {} })).toThrow();
    expect(host.spawn).not.toHaveBeenCalled();
    await expect(admitHostedTestEgress({ ...request(), executionEngine: "plain-exec" })).rejects.toThrow();
    await expect(admitHostedTestEgress({ ...request(), modelBackend: CodexModelBackend.XiaomiMimoTokenPlan })).rejects.toThrow();
  });
  it.each(["command", "cwd", "home"])("rejects a foreign provider %s before transport submission", field => {
    admitted(); const factory = admitResearchProcessFactory(request()), input = invocation();
    factory(input); host.spawn.mockClear();
    expect(() => factory({ ...input, ...(field === "command" ? { command: "/usr/bin/foreign" } : {}),
      ...(field === "cwd" ? { cwd: "/TEST-project/sibling" } : {}),
      ...(field === "home" ? { env: { ...input.env, CODEX_HOME: "/TEST-auth" } } : {}) })).toThrow();
    expect(host.spawn).not.toHaveBeenCalled();
  });
  it("checks and cancels only its retained service, retains ownership after grant revocation, and refuses PID reuse", () => {
    const current = admitted(); revokeResearchLaunch(current.jobId);
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: true, unit: current.unit });
    host.birth = "54321";
    expect(() => cancelResearchLaunch(current.jobId)).toThrow();
    expect(host.calls.filter(c => c.args[0] === "stop")).toHaveLength(0);
    host.birth = "12345";
    expect(cancelResearchLaunch(current.jobId)).toMatchObject({ terminal: true, unit: current.unit });
    expect(host.calls.filter(c => c.args[0] === "stop").map(c => c.args[1])).toEqual([current.unit]);
    expect(host.calls.some(c => c.args.includes("TEST-session.scope"))).toBe(false);
    expect(() => researchCurrentStart(current.jobId)).toThrow();
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: false, startId: current.startId, unit: current.unit });
  });
  it("cancels its protected pending service before PID binding without granting provider/auth effects", () => {
    const current = start(); host.units.get(current.unit)!.pending = true;
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ unit: current.unit, active: true });
    expect(cancelResearchLaunch(current.jobId)).toMatchObject({ terminal: true, startId: current.startId });
    expect(host.calls.filter(c => c.args[0] === "stop").map(c => c.args[1])).toEqual([current.unit]);
    expect(host.authReads).toBe(0); expect(host.spawn).not.toHaveBeenCalled();
  });
});

describe("portable TEST custody substitutions", () => {
  it.each(["none", "directory-owner", "file-owner", "directory-mode", "file-mode", "directory-symlink", "file-symlink"])(
    "corroborates sync/async protected physical fixtures and preserves %s rejection", async fault => {
      host.physicalPaths = true;
      const root = join(host.root, "TEST-async-authority"), path = join(root, hostedTestEgressGrantName(request().jobId));
      mkdirSync(root, { mode: 0o700 });
      const grant = { schemaVersion: 1, jobId: request().jobId, jobRootDir: request().jobRootDir,
        workspacePath: request().workspacePath, profileId: CodexProviderEgressProfileId.TestNpmQualification };
      writeFileSync(path, JSON.stringify(grant), { mode: 0o600 });
      researchCustody(request().authRootDir); researchCustody(root);
      expect(await readHostedTestEgressGrantFile(root, request())).toEqual(grant);
      const sync = await import("node:fs"), asyncFs = await import("node:fs/promises");
      expect((await asyncFs.lstat(root)).uid).toBe(sync.lstatSync(root).uid);
      const handle = await asyncFs.open(path, "r");
      try { expect((await handle.stat()).uid).toBe(sync.lstatSync(path).uid); } finally { await handle.close(); }
      if (fault === "none") return;
      if (fault === "directory-owner") host.foreign.add(root);
      if (fault === "file-owner") host.foreign.add(path);
      if (fault === "directory-mode") chmodSync(root, 0o777);
      if (fault === "file-mode") chmodSync(path, 0o666);
      if (fault.endsWith("symlink")) {
        const target = fault === "directory-symlink" ? root : path;
        renameSync(target, target + "-saved"); symlinkSync(target + "-saved", target);
      }
      await expect(readHostedTestEgressGrantFile(root, request())).rejects.toThrow();
      expect(() => researchCustody(fault.startsWith("file") ? path : root)).toThrow();
    });
});
