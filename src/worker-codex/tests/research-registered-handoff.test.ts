import { host, local, request, setupResearchFixture, cleanupResearchFixture, enterResearchOperatorScope } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmdirSync, statSync, cpSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { InMemoryWorkerAccountCapacityStore, AccessBoundary, NetworkAccessMode, createAccessPolicyService, type ProjectAccessScope, buildRuntimeResultEnvelope } from "@vioxen/subscription-runtime/worker-core";
import { execFile } from "node:child_process";
import * as childProcess from "node:child_process";
import * as nativeFiles from "node:fs";
import * as runtimeArtifact from "../research-runtime-artifact";
import { promisify } from "node:util";
import * as workspaceChanges from "../codex-goal-workspace-changes";
import { projectControlWorkspaceLocks } from "../codex-goal-project-workspace-lock";
import { CodexModelBackend, codexMimoDefaultModel, HostedMimoProfile } from "@vioxen/subscription-runtime/provider-codex";
import { prepareProjectResearchLaunch } from "../research-project-launch-adapter";
import { authorizeResearchProjectLaunch, consumeResearchProjectLaunchAuthorization } from "../research-project-launch-authorization";
import { authorizeRegisteredResearchHandoff, consumeRegisteredResearchHandoffAuthorization, RegisteredResearchSinkPreparationUnresolved, RegisteredResearchHandoffUnsupportedSink } from "../research-registered-handoff";
import { revokeProjectResearchLaunch, grantOwnedMimoWorkerLaunch, grantRegisteredResearchLaunch, startRegisteredResearchLaunch, startResearchLaunch, revokeResearchLaunch, revokeRegisteredResearchLaunch } from "../research-launch-owner";
import { observeResearchJobWriterAuthority, prepareResearchJobWriterObservation } from "../research-writer-observation";
import { admitResearchProcessFactory, assertResearchCurrentAuthority, bindProjectResearchRuntime, captureResearchRuntime, bindRegisteredResearchRuntime, researchCurrentStart, researchJobAuthority, researchTerminalHandoffGuard } from "../research-launch-admission";
import { abortUnsubmittedRegisteredResearchLaunch, cancelResearchLaunch, cancelRegisteredResearchLaunch, finalizeOwnedMimoWorker, recoverOwnedMimoWorkerPreservation,
  terminalResearchStart, type UnsubmittedResearchStartSubmitterProof } from "../research-launch-lifecycle";
import { researchArtifactDigest, researchDirectoryIdentity, researchHash, researchRead, researchPublish } from "../research-launch-files";
import { bindResearchMimoWritableFootprint, observeResearchMimoAllocationWritableRoots, prepareResearchProviderRoot } from "../research-provider-root";
import { researchMimoCodingBootstrapPaths } from "../research-mimo-coding-root";
import { reserveCodexProjectAccount, assertCodexProjectReservedLaunchAuthority } from "../application/project-control/codex-goal-project-account-reservation";
import { loadJobLaunch } from "../codex-goal-mcp-project-control-deps";
import { parseResearchOperatorRequest, researchRunConfig, researchHashRequest } from "../research-launch-contract";
import { readCodexGoalJob, codexGoalJobManifestPath, CodexGoalAccountSelectionMode } from "../codex-goal-jobs";
import { registeredTerminalRepairTests, registeredStoppedBeforeProviderTests } from "./research-terminal-handoff-repair-test-support";
import { parseCodexGoalProjectAccessScope } from "../codex-goal-access-plan";

const state = vi.hoisted(() => ({ scope: undefined as ProjectAccessScope | undefined, checkpointRequired: false, mimo: false, registry: "/TEST-project/registry" }));
// This suite exercises the native registered boundary with real TEST manifests,
// receipt bytes and directory replacements. The upstream clean Git admission
// and controller loader have their own tests; neither Host services nor models run.
vi.mock("../codex-goal-mcp-project-control-deps", () => {
  // Finish mock initialization before importing any real loader dependency.
  // The composition root participates in the native broker import cycle.
  return { loadJobLaunch: async (input: Parameters<typeof import("../application/codex-goal-job-launch-loader").loadJobLaunch>[0]) =>
    (await import("../application/codex-goal-job-launch-loader")).loadJobLaunch(input),
    loadProjectControlController: async () => ({ registryRootDir: state.registry,
    controller: { jobId: "TEST-controller", jobRootDir: "/TEST-project/controller", checkpointRequired: state.checkpointRequired }, scope: state.scope! }) };
});
vi.mock("../application/project-control/codex-goal-project-pre-start-admission", async original => {
  const real = await original<typeof import("../application/project-control/codex-goal-project-pre-start-admission")>();
  return { ...real, readLaunchAuthorizedWorkerLaunchAttestation: async (input: { manifest: { projectPreStartAdmission: { receiptPath: string } } }) => {
    const { researchRead, researchHash } = await import("../research-launch-files");
    return { launch: {}, receiptSha256: researchHash(researchRead(input.manifest.projectPreStartAdmission.receiptPath)) };
  } };
});
let registry = "/TEST-project/registry", sink = join(registry, "durable-handoffs");
const selected = () => parseResearchOperatorRequest({ ...request(), ...(state.mimo ? { accounts: ["account-q"], modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel } : { accounts: ["TEST-a"] }), projectId: "TEST-original-project", maxAccountCycles: 1,
  prewarmOnStart: false, appServerStartupTimeoutMs: 330_000 });
const receiptPath = () => join(selected().jobRootDir, "pre-start-admission/receipt.json");
beforeEach(async () => {
  // CodingV1 protects /tmp and /dev. Allocate real TEST bytes beneath the
  // canonical unit runner workspace; retain the labelled Host namespace port.
  setupResearchFixture({ allocationParent: process.cwd() }); state.mimo = false; registry = state.registry = "/TEST-project/registry"; sink = join(registry, "durable-handoffs");
  await initializeRegisteredFixture();
});
async function initializeRegisteredFixture() {
  state.checkpointRequired = false;
  vi.stubEnv("SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET", undefined);
  const r = selected(), descriptorRoot = join(r.jobRootDir, "pre-start-admission");
  state.scope = { projectId: "TEST-project", registryRoot: registry, workspaceRoots: [r.workspacePath],
    authRoot: r.authRootDir, jobIdPrefixes: ["TEST-research"], allowedAccountIds: state.mimo ? ["account-q"] : ["TEST-a"] };
  for (const path of [sink, join(registry, r.jobId), join(registry, "TEST-controller"), descriptorRoot, "/TEST-project/controller"]) {
    mkdirSync(local(path), { recursive: true, mode: 0o700 });
  }
  writeFileSync(local(codexGoalJobManifestPath({ registryRootDir: registry, jobId: "TEST-controller" })), "{}", { mode: 0o600 });
  writeFileSync(local(join(descriptorRoot, "contract.json")), "{}", { mode: 0o600 });
  writeFileSync(local(join(descriptorRoot, "state.json")), "{}", { mode: 0o600 });
  writeFileSync(local(codexGoalJobManifestPath({ registryRootDir: registry, jobId: r.jobId })), JSON.stringify({ ...r,
    durableHandoffRootDir: sink, maxAccountCycles: state.mimo ? 1 : 5, accounts: state.mimo ? ["account-q"] : request().accounts,
    accountSelectionMode: CodexGoalAccountSelectionMode.Explicit,
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, networkAccess: NetworkAccessMode.Unrestricted,
    projectAccessScope: { projectId: "TEST-original-project", projectSlug: "TEST/original-project",
      readRoots: [r.workspacePath, registry], workspaceRoots: [r.workspacePath], registryRoot: registry,
      isolatedWorkspaceRoot: r.workspacePath, authRoot: r.authRootDir },
    createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
    projectPreStartAdmission: { schemaVersion: 1, mode: "serial-builtin", contractPath: join(descriptorRoot, "contract.json"),
      statePath: join(descriptorRoot, "state.json"), receiptPath: receiptPath() },
  }), { mode: 0o600 });
  const manifest = await readCodexGoalJob({ registryRootDir: registry, jobId: r.jobId });
  writeFileSync(local(receiptPath()), JSON.stringify({ status: "launch_authorized", launchAuthorizationCount: 1,
    jobId: r.jobId, manifestSha256: researchHash(JSON.stringify(manifest)), contractSha256: researchHash("{}"),
    stateSha256: researchHash("{}"), promptSha256: researchHash(researchRead(r.promptPath)),
  }), { mode: 0o600 });
}
afterEach(() => { vi.unstubAllEnvs(); cleanupResearchFixture(); });
async function reserved() {
  const loaded = await loadJobLaunch({ registryRootDir: registry, jobId: selected().jobId });
  const reservation = await reserveCodexProjectAccount({ manifest: loaded.manifest, launch: loaded.launch,
    deps: { capacityStore: new InMemoryWorkerAccountCapacityStore(), leaseMode: "shared" } });
  return { ...loaded, reservedLaunch: reservation.launch };
}
const authorize = async () => authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller",
  request: state.mimo ? parseResearchOperatorRequest({ ...selected(), hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns: 64 }) : selected(), reservedLaunch: (await reserved()).reservedLaunch });
async function grantAndRequest() {
  const authorization = await authorize();
  await grantRegisteredResearchLaunch(authorization);
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(authorization.request) + "\n", { mode: 0o600 });
  return authorization.request;
}
const start = () => startRegisteredResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
describe("explicit registered abort before the first bind (labelled Host fixture)", () => {
  const platform = process.platform;
  beforeEach(() => {
    // All Host effects still go through the existing offline kernel/service
    // fixture. Exercise the Linux contract locally without a real Host launch.
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(runtimeArtifact, "assertQualifiedResearchRuntimeArtifact").mockImplementation((directory, digest) => {
      expect(directory).toBe("/TEST-artifact"); expect(researchArtifactDigest(directory)).toBe(digest);
    });
  });
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }));
  async function incomplete() {
    state.mimo = true; await initializeRegisteredFixture(); await grantAndRequest();
    const original = childProcess.spawnSync;
    const bind = vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], options: unknown) => {
      if (command === "/usr/bin/mount" && args[0] === "--bind") return { status: 1, stdout: "", stderr: "" };
      return Reflect.apply(original, childProcess, [command, args, options]);
    }) as typeof original);
    await expect(start()).rejects.toThrow(); bind.mockRestore();
    const current = researchCurrentStart(selected().jobId), jobId = current.spec.request.jobId;
    const requestBytes = researchRead("/TEST-operator/request.json");
    writeFileSync(local(join(researchJobAuthority(jobId), "project-worker-request.json")), requestBytes, { mode: 0o600 });
    const expected = { jobId, startId: current.spec.startId, specSha256: researchHash(current.bytes), requestSha256: current.spec.requestSha256 };
    const proof: UnsubmittedResearchStartSubmitterProof = { ...expected, ownerSha256: "1".repeat(64), auditSha256: "2".repeat(64), assertTerminal: vi.fn() };
    const manifest = await readCodexGoalJob({ registryRootDir: registry, jobId });
    return { current, expected, proof, manifest };
  }
  it("discharges only the exact unsubmitted reservation and preserves real inputs without a result", async () => {
    const { current, expected, proof, manifest } = await incomplete(), authority = researchJobAuthority(expected.jobId);
    const paths = [join(authority, "grant.json"), join(authority, "project-worker-request.json"), join(current.directory, "spec.json"),
      manifest.promptPath, receiptPath(), codexGoalJobManifestPath({ registryRootDir: registry, jobId: expected.jobId })];
    const before = paths.map(path => researchRead(path));
    // The retained first-pin failure is not a successful normal cancellation:
    // its historical pinned handoff contract still fails closed.
    await expect(cancelRegisteredResearchLaunch(expected)).rejects.toThrow();
    await expect(abortUnsubmittedRegisteredResearchLaunch(expected, proof)).resolves.toEqual({ ...expected, terminal: true, abortedBeforeSubmission: true });
    expect(paths.map(path => researchRead(path))).toEqual(before);
    expect(existsSync(local(join(authority, "active.json")))).toBe(false);
    expect(terminalResearchStart(expected.jobId).spec.startId).toBe(expected.startId);
    expect(existsSync(local(join(current.directory, "durable-pin.json")))).toBe(false);
    expect(existsSync(local(join(current.directory, "mimo-publication.json")))).toBe(false);
    expect(await (await prepareResearchJobWriterObservation(manifest))()).toEqual({ status: "released" });
    expect(vi.mocked(proof.assertTerminal).mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(host.calls.filter(call => call.command === "/usr/bin/systemd-run" || call.command === "/usr/bin/mount" ||
      call.command === "/usr/bin/systemctl" && ["stop", "kill"].includes(call.args[0]!))).toEqual([]);
    expect(host.authReads).toBe(0);
  });
  it.each([
    ["model", "prepare"], ["model", "read"],
    ["reasoningEffort", "prepare"], ["reasoningEffort", "read"],
    ["accounts", "prepare"], ["accounts", "read"],
    ["invalidAccounts", "prepare"], ["invalidAccounts", "read"],
  ] as const)("refuses caller-only %s contradiction at %s without changing the registered manifest", async (field, phase) => {
    const { expected, proof, manifest } = await incomplete();
    await abortUnsubmittedRegisteredResearchLaunch(expected, proof);
    const manifestPath = codexGoalJobManifestPath({ registryRootDir: registry, jobId: expected.jobId });
    const registeredBytes = researchRead(manifestPath);
    // A reordered caller object must normalize to the same registered identity.
    const supplied = Object.fromEntries(Object.entries(manifest).reverse()) as typeof manifest;
    const prepared = phase === "read" ? await prepareResearchJobWriterObservation(supplied) : undefined;
    if (prepared) expect(await prepared()).toEqual({ status: "released" });
    Object.assign(supplied, field === "model" ? { model: "TEST-contradictory-model" }
      : field === "reasoningEffort" ? { reasoningEffort: "none" }
      : { accounts: field === "invalidAccounts" ? [] : ["TEST-contradictory-account"] });
    expect(await (prepared ?? await prepareResearchJobWriterObservation(supplied))()).toEqual({ status: "unknown" });
    expect(researchRead(manifestPath)).toEqual(registeredBytes);
    expect(await (await prepareResearchJobWriterObservation(manifest))()).toEqual({ status: "released" });
    expect(host.authReads).toBe(0);
  });
  it.each(["submitter", "closing", "late-closing", "queued", "live", "mount", "binding", "provider", "receipt"] as const)("retains active on %s uncertainty", async fault => {
    const { current, expected, proof } = await incomplete(), active = researchRead(join(researchJobAuthority(expected.jobId), "active.json"));
    if (fault === "submitter") vi.mocked(proof.assertTerminal).mockImplementation(() => { throw Error("TEST owner still active"); });
    if (fault === "closing") researchPublish(join(current.directory, "closing.json"), { schemaVersion: 1, specSha256: "0".repeat(64) });
    if (fault === "late-closing") vi.mocked(proof.assertTerminal).mockImplementation(() => {
      if (existsSync(local(join(current.directory, "closing.json")))) researchPublish(join(current.directory, "closing.json"), {});
    });
    if (fault === "queued") host.jobs.add(current.spec.unit);
    if (fault === "live") host.units.set(current.spec.unit, { active: true, pid: process.pid, invocation: "3".repeat(32), description: "TEST live replacement" });
    if (fault === "mount") host.pins.set(join(current.directory, "pins/job/nested"), current.spec.request.workspacePath);
    if (fault === "binding") researchPublish(join(current.directory, "binding.json"), {});
    if (fault === "provider") researchPublish(join(current.directory, "providers", "subscription-runtime-research-provider-11111111-1111-1111-1111-111111111111.service.json"), {});
    if (fault === "receipt") mutateReceipt();
    await expect(abortUnsubmittedRegisteredResearchLaunch(expected, proof)).rejects.toThrow();
    expect(researchRead(join(researchJobAuthority(expected.jobId), "active.json"))).toEqual(active);
    expect(existsSync(local(join(current.directory, "unsubmitted-abort.json")))).toBe(false);
  });
  it("retains Unknown across interruption before active release and resumes only the exact proof", async () => {
    const { current, expected, proof, manifest } = await incomplete();
    const unlink = nativeFiles.unlinkSync;
    const fail = vi.spyOn(nativeFiles, "unlinkSync").mockImplementation(path => {
      if (path === join(researchJobAuthority(expected.jobId), "active.json")) throw Error("TEST interrupted release");
      return unlink(path);
    });
    await expect(abortUnsubmittedRegisteredResearchLaunch(expected, proof)).rejects.toThrow("TEST interrupted release");
    fail.mockRestore();
    expect(existsSync(local(join(current.directory, "unsubmitted-abort.json")))).toBe(true);
    expect(await (await prepareResearchJobWriterObservation(manifest))()).toEqual({ status: "unknown" });
    await expect(start()).rejects.toThrow(); // Original grant/request cannot resubmit this active closing start.
    await abortUnsubmittedRegisteredResearchLaunch(expected, proof);
    expect(await (await prepareResearchJobWriterObservation(manifest))()).toEqual({ status: "released" });
  });
  it.each(["queued", "mount", "binding", "artifact", "closing", "receipt", "descendant", "missing-events"] as const)("fresh abort reader refuses post-prepare %s drift", async fault => {
    const { current, expected, proof, manifest } = await incomplete();
    await abortUnsubmittedRegisteredResearchLaunch(expected, proof);
    const read = await prepareResearchJobWriterObservation(manifest);
    if (fault === "queued") host.jobs.add(current.spec.unit);
    if (fault === "mount") host.pins.set(join(current.directory, "pins/workspace"), current.spec.request.workspacePath);
    if (fault === "binding") researchPublish(join(current.directory, "binding.json"), {});
    if (fault === "artifact") writeFileSync(local("/TEST-artifact/dist/main.js"), "changed TEST artifact", { mode: 0o644 });
    if (fault === "closing") researchPublish(join(current.directory, "closing.json"), {});
    if (fault === "receipt") mutateReceipt();
    if (fault === "descendant" || fault === "missing-events") {
      const group = "/sys/fs/cgroup/system.slice/" + current.spec.unit, stat = nativeFiles.lstatSync, readFile = nativeFiles.readFileSync;
      vi.spyOn(nativeFiles, "lstatSync").mockImplementation(((path: string) => path === group
        ? stat(current.directory) : stat(path)) as typeof stat);
      vi.spyOn(nativeFiles, "readFileSync").mockImplementation(((path: string, options: unknown) => {
        if (path === group + "/cgroup.events") {
          if (fault === "missing-events") throw Object.assign(Error("TEST events absent within existing group"), { code: "ENOENT" });
          return "populated 1\nfrozen 0\n";
        }
        return Reflect.apply(readFile, nativeFiles, [path, options]);
      }) as typeof readFile);
    }
    expect(await read()).toEqual({ status: "unknown" });
  });
  it("does not infer release from an incomplete native namespace or a serialized owner flag", async () => {
    const { expected, proof, manifest } = await incomplete();
    expect(await (await prepareResearchJobWriterObservation(manifest))()).toEqual({ status: "unknown" });
    await expect(abortUnsubmittedRegisteredResearchLaunch(expected, { ...proof, assertTerminal: true } as unknown as UnsubmittedResearchStartSubmitterProof)).rejects.toThrow();
  });
});
function mutateReceipt() {
  const receipt = JSON.parse(readFileSync(local(receiptPath()), "utf8"));
  writeFileSync(local(receiptPath()), JSON.stringify({ ...receipt, status: "admitted" }), { mode: 0o600 });
}
describe("registered durable handoff authorization (NEW TEST source fixtures only)", () => {
  it("retains registered prompt authority after sandbox preparation makes only the job root traversable", async () => {
    const authorization = await authorize();
    const before = readFileSync(local(selected().promptPath));
    // This is the real permission transition performed by sandboxTraverse.
    chmodSync(local(selected().jobRootDir), 0o701);
    expect(() => researchRead(selected().promptPath)).toThrow();
    const binding = await consumeRegisteredResearchHandoffAuthorization(authorization);
    expect(binding.requestSha256).toBeDefined();
    expect(readFileSync(local(selected().promptPath))).toEqual(before);
    expect(statSync(local(selected().promptPath)).mode & 0o7777).toBe(0o600);
    expect(statSync(local(selected().jobRootDir)).mode & 0o7777).toBe(0o701);
    expect(statSync(local(join(selected().jobRootDir, "pre-start-admission"))).mode & 0o7777).toBe(0o700);
    expect(host.authReads).toBe(0);
  });
  it.each(["public-prompt", "public-root", "traversable-admission"] as const)("keeps %s outside the registered prompt exception", async fault => {
    const authorization = await authorize();
    chmodSync(local(selected().jobRootDir), fault === "public-root" ? 0o755 : 0o701);
    if (fault === "public-prompt") chmodSync(local(selected().promptPath), 0o644);
    if (fault === "traversable-admission") chmodSync(local(join(selected().jobRootDir, "pre-start-admission")), 0o701);
    await expect(consumeRegisteredResearchHandoffAuthorization(authorization)).rejects.toThrow();
    expect(host.authReads).toBe(0);
  });
  it("prepares only the missing canonical private leaf after current authorized admission", async () => {
    rmdirSync(local(sink));
    await authorize();
    expect(statSync(local(sink)).mode & 0o777).toBe(0o700);
    expect(host.pins.size).toBe(0);
  });
  it("reports unsupported stored custom sinks before foreign-directory effects", async () => {
    const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: selected().jobId });
    const manifest = JSON.parse(readFileSync(local(path), "utf8"));
    writeFileSync(local(path), JSON.stringify({ ...manifest, durableHandoffRootDir: "/TEST-project/foreign-sink" }), { mode: 0o600 });
    await expect(authorize()).rejects.toBeInstanceOf(RegisteredResearchHandoffUnsupportedSink);
    expect(existsSync(local("/TEST-project/foreign-sink"))).toBe(false);
    expect(host.pins.size).toBe(0);
  });
  it("creates no missing sink when its authorized receipt is revoked", async () => {
    rmdirSync(local(sink)); mutateReceipt();
    await expect(authorize()).rejects.toThrow();
    expect(existsSync(local(sink))).toBe(false);
  });
  it("retains its canonical preparation as unresolved if authority changes after mkdir", async () => {
    rmdirSync(local(sink));
    const fs = await import("node:fs"), mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((path: string, options: Parameters<typeof mkdir>[1]) => {
      const result = mkdir(path, options);
      if (path === sink) mutateReceipt();
      return result;
    }) as typeof mkdir);
    await expect(authorize()).rejects.toBeInstanceOf(RegisteredResearchSinkPreparationUnresolved);
    expect(statSync(local(sink)).mode & 0o777).toBe(0o700);
    expect(host.pins.size).toBe(0);
  });
  // RED: the leaf exists, but failure during its final cold witness escapes
  // the retained-preparation classification after all intermediate checks pass.
  it.each(["receipt", "sink"] as const)("retains preparation on final cold readback %s drift", async fault => {
    rmdirSync(local(sink));
    let changed = false;
    host.findmntHook = () => {
      const command = host.calls.at(-1)!;
      if (command.args[command.args.indexOf("--target") + 1] !== sink) return;
      host.findmntHook = undefined;
      changed = true;
      if (fault === "receipt") mutateReceipt();
      if (fault === "sink") {
        renameSync(local(sink), local(sink) + "-retained");
        mkdirSync(local(sink), { mode: 0o700 });
      }
    };
    const error = await authorize().catch(error => error);
    expect(changed).toBe(true);
    expect(error).toBeInstanceOf(RegisteredResearchSinkPreparationUnresolved);
    expect(error.preparationRetained).toBe(true);
    expect(statSync(local(sink)).mode & 0o777).toBe(0o700);
    if (fault === "sink") expect(existsSync(local(sink) + "-retained")).toBe(true);
    expect(host.pins.size).toBe(0);
    expect(host.calls.filter(call => call.command === "/usr/bin/mount" || call.command === "/usr/bin/systemd-run")).toEqual([]);
  });
  // RED: a cold bind alias of a provider-readable root can create the sink
  // before the eventual provider graph rejects exposure.
  it("rejects a provider-readable physical alias before missing-leaf preparation", async () => {
    rmdirSync(local(sink));
    cpSync(local(registry), local("/usr"), { recursive: true });
    host.pins.set(registry, "/usr");
    await expect(authorize()).rejects.toThrow();
    expect(existsSync(local(sink))).toBe(false);
  });
  it("rejects a reserved launch clone before preparing a missing sink", async () => {
    rmdirSync(local(sink)); const selection = await reserved();
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: selected(),
      reservedLaunch: { ...selection.reservedLaunch, config: { ...selection.reservedLaunch.config } },
    })).rejects.toThrow("project_control_reserved_launch_authority_invalid");
    expect(existsSync(local(sink))).toBe(false);
  });
  it("consumes the real original selection once and never re-reserves for grant/lifetime checks", async () => {
    const selection = await reserved();
    await authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: selected(),
      reservedLaunch: selection.reservedLaunch });
    expect(() => assertCodexProjectReservedLaunchAuthority({ manifest: selection.manifest, sourceLaunch: selection.launch,
      reservedLaunch: selection.reservedLaunch })).toThrow("project_control_reserved_launch_authority_invalid");
  });
  // RED: omission inherits native 330000 rather than ordinary provider
  // 120000; genuine declared max5 is mistaken for the reserved attempt budget1.
  it("preserves ordinary omitted startup and stored prewarm without re-reserving", async () => {
    const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: selected().jobId });
    const manifest = JSON.parse(readFileSync(local(path), "utf8"));
    delete manifest.appServerStartupTimeoutMs;
    writeFileSync(local(path), JSON.stringify(manifest), { mode: 0o600 });
    const loaded = await readCodexGoalJob({ registryRootDir: registry, jobId: selected().jobId });
    const receipt = JSON.parse(readFileSync(local(receiptPath()), "utf8"));
    writeFileSync(local(receiptPath()), JSON.stringify({ ...receipt, manifestSha256: researchHash(JSON.stringify(loaded)) }), { mode: 0o600 });
    const selection = await reserved();
    expect(selection.launch.config.maxAccountCycles).toBe(5);
    expect(selection.reservedLaunch.config.maxAccountCycles).toBe(1);
    const authorization = await authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller",
      request: parseResearchOperatorRequest({ ...selected(), appServerStartupTimeoutMs: 120_000 }), reservedLaunch: selection.reservedLaunch });
    await grantRegisteredResearchLaunch(authorization);
    expect(researchRunConfig(authorization.request)).toMatchObject({ maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: 120_000 });
  });
  it.each([{ workerReportMode: "structured-output" }, { codexGoalObjective: "TEST objective" }, { staleLockMs: 5000 }])(
    "rejects unsupported stored execution semantics before sink preparation: %j", async fields => {
      rmdirSync(local(sink));
      const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: selected().jobId });
      const manifest = JSON.parse(readFileSync(local(path), "utf8"));
      writeFileSync(local(path), JSON.stringify({ ...manifest, ...fields }), { mode: 0o600 });
      const receiptBefore = readFileSync(local(receiptPath()));
      await expect(authorize()).rejects.toThrow("hosted_research_registered_execution_unsupported");
      expect(existsSync(local(sink))).toBe(false);
      expect(readFileSync(local(receiptPath()))).toEqual(receiptBefore);
      expect(host.pins.size).toBe(0);
    });
  it.each(["controller", "host"] as const)("rejects effective %s checkpoint requirements before sink creation", async source => {
    rmdirSync(local(sink));
    if (source === "controller") state.checkpointRequired = true;
    if (source === "host") vi.stubEnv("SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET", "/TEST-host/checkpoint.sock");
    await expect(authorize()).rejects.toThrow("hosted_research_registered_execution_unsupported");
    expect(existsSync(local(sink))).toBe(false);
    expect(host.authReads).toBe(0);
  });
  it("rejects request budget override before effects without consuming a valid selection", async () => {
    rmdirSync(local(sink)); const selection = await reserved();
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller",
      request: parseResearchOperatorRequest({ ...selected(), maxAccountCycles: 5 }), reservedLaunch: selection.reservedLaunch,
    })).rejects.toThrow("hosted_research_registered_execution_unsupported");
    expect(existsSync(local(sink))).toBe(false);
    expect(assertCodexProjectReservedLaunchAuthority({ manifest: selection.manifest, sourceLaunch: selection.launch,
      reservedLaunch: selection.reservedLaunch }).maxAccountCycles).toBe(1);
  });
  // RED: dropping a negative source scope constraint widens permission to
  // an otherwise admitted subtree, even when positive read roots are narrowed.
  it.each(["deniedRoots", "registryRoot"] as const)("rejects restrictive source %s before leaf creation", async field => {
    rmdirSync(local(sink));
    const forbidden = join(selected().workspacePath, "TEST-private-subtree");
    mkdirSync(local(forbidden), { mode: 0o700 });
    const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: selected().jobId });
    const manifest = JSON.parse(readFileSync(local(path), "utf8"));
    manifest.projectAccessScope[field] = field === "deniedRoots" ? [forbidden] : forbidden;
    writeFileSync(local(path), JSON.stringify(manifest), { mode: 0o600 });
    const loaded = await loadJobLaunch({ registryRootDir: registry, jobId: selected().jobId });
    const sourcePolicy = createAccessPolicyService({ boundary: loaded.launch.config.accessBoundary!, scope: loaded.launch.config.projectAccessScope! });
    const derived = researchRunConfig(selected());
    const derivedPolicy = createAccessPolicyService({ boundary: derived.accessBoundary!, scope: derived.projectAccessScope! });
    const target = join(forbidden, "TEST-result.txt");
    expect(sourcePolicy.canWritePath({ path: target }).allowed).toBe(false);
    if (field === "deniedRoots") expect(sourcePolicy.canReadPath({ path: target }).allowed).toBe(false);
    expect(derivedPolicy.canWritePath({ path: target }).allowed).toBe(true);
    const receiptBefore = readFileSync(local(receiptPath()));
    await expect(authorize()).rejects.toThrow("hosted_research_registered_execution_unsupported");
    expect(existsSync(local(sink))).toBe(false);
    expect(readFileSync(local(receiptPath()))).toEqual(receiptBefore);
    expect(host.pins.size).toBe(0);
    expect(host.authReads).toBe(0);
  });
  it("rejects the actual declared registry when it contains the admitted workspace", async () => {
    rmdirSync(local(sink));
    const workspace = join(registry, "TEST-workspace");
    mkdirSync(local(workspace), { mode: 0o700 });
    const request = parseResearchOperatorRequest({ ...selected(), workspacePath: workspace });
    state.scope = { ...state.scope!, workspaceRoots: [workspace] };
    const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: request.jobId });
    const manifest = JSON.parse(readFileSync(local(path), "utf8"));
    manifest.workspacePath = workspace;
    manifest.projectAccessScope = { ...manifest.projectAccessScope, isolatedWorkspaceRoot: workspace, workspaceRoots: [workspace] };
    writeFileSync(local(path), JSON.stringify(manifest), { mode: 0o600 });
    const loaded = await loadJobLaunch({ registryRootDir: registry, jobId: request.jobId });
    const source = createAccessPolicyService({ boundary: loaded.launch.config.accessBoundary!, scope: loaded.launch.config.projectAccessScope! });
    const derived = researchRunConfig(request);
    expect(source.canWritePath({ path: workspace }).allowed).toBe(false);
    expect(createAccessPolicyService({ boundary: derived.accessBoundary!, scope: derived.projectAccessScope! }).canWritePath({ path: workspace }).allowed).toBe(true);
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request,
      reservedLaunch: (await reserved()).reservedLaunch })).rejects.toThrow("hosted_research_registered_execution_unsupported");
    expect(existsSync(local(sink))).toBe(false);
    expect(host.pins.size).toBe(0);
  });
  it("rejects a caller project identity substitution without widening the derived child scope", async () => {
    rmdirSync(local(sink)); const selection = await reserved();
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller",
      request: parseResearchOperatorRequest({ ...selected(), projectId: "TEST-foreign-project" }), reservedLaunch: selection.reservedLaunch,
    })).rejects.toThrow("hosted_research_registered_execution_unsupported");
    expect(existsSync(local(sink))).toBe(false);
    expect(host.authReads).toBe(0);
  });
  it("rejects a changed nested reserved account rather than blessing its original object", async () => {
    rmdirSync(local(sink)); const selection = await reserved();
    Object.assign(selection.reservedLaunch.config.accounts[0]!, { authJsonPath: "/TEST-foreign/account.json" });
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: selected(),
      reservedLaunch: selection.reservedLaunch })).rejects.toThrow("project_control_reserved_launch_authority_invalid");
    expect(existsSync(local(sink))).toBe(false);
    expect(host.authReads).toBe(0);
  });
  it("mints a single-use derived sink capability and rejects a serialized lookalike", async () => {
    const authorization = await authorize();
    expect(authorization.request.durableHandoffRootDir).toBe(sink);
    await expect(consumeRegisteredResearchHandoffAuthorization({ ...authorization })).rejects.toThrow();
    await grantRegisteredResearchLaunch(authorization);
    await expect(grantRegisteredResearchLaunch(authorization)).rejects.toThrow();
    expect(host.calls.filter(call => call.command === "/usr/bin/mount" || call.command === "/usr/bin/systemd-run")).toEqual([]);
    expect(host.authReads).toBe(0);
  });
  // RED: stale authority still publishes a native grant or touches the sink.
  it.each(["receipt", "receipt-bytes", "manifest", "scope"] as const)("denies changed %s before grant/native effects", async fault => {
    const authorization = await authorize();
    if (fault === "receipt") mutateReceipt();
    if (fault === "receipt-bytes") writeFileSync(local(receiptPath()), readFileSync(local(receiptPath()), "utf8") + "\n", { mode: 0o600 });
    if (fault === "manifest") {
      const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: selected().jobId });
      const manifest = JSON.parse(readFileSync(local(path), "utf8"));
      writeFileSync(local(path), JSON.stringify({ ...manifest, taskId: "TEST-other" }), { mode: 0o600 });
    }
    if (fault === "scope") state.scope = { ...state.scope!, allowedAccountIds: ["TEST-other"] };
    await expect(grantRegisteredResearchLaunch(authorization)).rejects.toThrow();
    expect(existsSync(local(join("/run/user/subscription-runtime-research-v1", researchHash(selected().jobId), "grant.json")))).toBe(false);
    expect(host.calls.filter(call => call.command === "/usr/bin/mount" || call.command === "/usr/bin/systemd-run")).toEqual([]);
    expect(host.authReads).toBe(0);
  });
  it("refuses free/native sinks without retained registered authority", async () => {
    const r = await grantAndRequest();
    expect(() => startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")))).toThrow();
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: r, reservedLaunch: (await reserved()).reservedLaunch })).rejects.toThrow();
    expect(host.pins.size).toBe(0);
  });
  it("detects a scope revocation during an awaited authorized receipt read before grant", async () => {
    const authorization = await authorize();
    const receipts = await import("../application/project-control/codex-goal-project-pre-start-launch-authorization");
    const read = receipts.readCurrentAuthorizedProjectPreStartLaunchReceipt;
    vi.spyOn(receipts, "readCurrentAuthorizedProjectPreStartLaunchReceipt").mockImplementationOnce(async manifest => {
      const result = await read(manifest);
      state.scope = { ...state.scope!, allowedAccountIds: ["TEST-other"] };
      return result;
    });
    await expect(grantRegisteredResearchLaunch(authorization)).rejects.toThrow();
    expect(existsSync(local(join("/run/user/subscription-runtime-research-v1", researchHash(selected().jobId), "grant.json")))).toBe(false);
  });
  it("cold-checks the scoped receipt after the live account observation before publishing a grant", async () => {
    const authorization = await authorize();
    const accounts = await import("../application/project-control/codex-goal-project-account-reservation");
    const read = accounts.assertCodexProjectReservedAccountReceiptCurrent;
    vi.spyOn(accounts, "assertCodexProjectReservedAccountReceiptCurrent").mockImplementationOnce(async input => {
      await read(input); mutateReceipt();
    });
    await expect(grantRegisteredResearchLaunch(authorization)).rejects.toThrow();
    expect(existsSync(local(join(researchJobAuthority(selected().jobId), "grant.json")))).toBe(false);
    expect(host.calls.filter(call => call.command === "/usr/bin/mount" || call.command === "/usr/bin/systemd-run")).toEqual([]);
    expect(host.authReads).toBe(0);
  });
  it("retains a verified durable pin and forwards its sink only to the trusted runtime", async () => {
    await grantAndRequest();
    const started = await start(), current = researchCurrentStart(started.jobId);
    host.group = `/system.slice/${started.unit}`;
    await bindRegisteredResearchRuntime(started.jobId, started.startId);
    expect(host.pins.get(join(current.directory, "pins/durable-handoff"))).toBe(sink);
    const submission = host.calls.find(call => call.command === "/usr/bin/systemd-run")!;
    expect(submission.args).toContain(`--property=BindPaths=${join(current.directory, "pins/durable-handoff")}:${sink}:norbind`);
    expect(researchRunConfig(current.spec.request).durableHandoffRootDir).toBe(sink);
    expect(researchRunConfig(current.spec.request)).toMatchObject({ maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: 330_000 });
    expect(current.spec.registeredHandoff?.registeredExecution?.maxAccountCycles).toBe(1);
    expect(researchRunConfig(current.spec.request).projectAccessScope).toEqual({ projectId: "TEST-original-project",
      isolatedWorkspaceRoot: current.spec.request.workspacePath, authRoot: current.spec.request.authRootDir });
    await expect(researchTerminalHandoffGuard(started.jobId, started.startId)()).resolves.toBeUndefined();
    expect(host.authReads).toBe(0);
  });
  // RED: blocking mount observation revokes the grant but submission/guard
  // still succeeds from a native read performed before the observation.
  it("does not submit a grant revoked during the final cold mount witness", async () => {
    await grantAndRequest();
    host.findmntHook = () => {
      if (host.pins.size !== 3) return;
      host.findmntHook = undefined;
      writeFileSync(local(join("/run/user/subscription-runtime-research-v1", researchHash(selected().jobId), "grant.json")), "{}", { mode: 0o600 });
    };
    await expect(start()).rejects.toThrow();
    expect(host.calls.filter(call => call.command === "/usr/bin/systemd-run")).toEqual([]);
  });
  it("rechecks the scoped receipt before the next pin effect after a blocking mount", async () => {
    await grantAndRequest();
    host.findmntHook = () => {
      if (host.pins.size !== 1) return;
      host.findmntHook = undefined; mutateReceipt();
    };
    await expect(start()).rejects.toThrow();
    const current = researchCurrentStart(selected().jobId);
    expect(host.pins.has(join(current.directory, "pins/job"))).toBe(true);
    expect(host.pins.has(join(current.directory, "pins/workspace"))).toBe(false);
    expect(host.calls.filter(call => call.command === "/usr/bin/systemd-run")).toEqual([]);
    expect(host.authReads).toBe(0);
  });
  it("keeps the exact registered receipt live in synchronous runtime effect guards", async () => {
    const platform = process.platform; Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await grantAndRequest(); const started = await start(); host.group = `/system.slice/${started.unit}`;
      await bindRegisteredResearchRuntime(started.jobId, started.startId);
      const captured = captureResearchRuntime(selected()), current = researchCurrentStart(started.jobId);
      const shows = () => host.calls.filter(call => call.command === "/usr/bin/systemctl" && call.args[0] === "show").length;
      const mounts = () => host.calls.filter(call => call.command === "/usr/bin/findmnt").length;
      let tick = 0; const clock = vi.spyOn(performance, "now").mockImplementation(() => tick);
      host.findmntHook = () => { tick += 1; };
      const before = shows(), beforeMounts = mounts(), timing = captured.assertCurrent();
      clock.mockRestore(); host.findmntHook = undefined;
      expect([shows() - before, mounts() - beforeMounts]).toEqual([2, 10]);
      expect(timing).toMatchObject({ admissionAuthorityElapsedMs: 10, admissionAuthorityServiceElapsedMs: 0,
        admissionAuthorityScalarWitnessElapsedMs: 6, admissionAuthorityPairedPinElapsedMs: 4, admissionAuthorityScalarTargetQueryElapsedMs: 6, admissionAuthorityPairedTargetQueryElapsedMs: 4 });
      const nextMounts = mounts(); captured.assertCurrent(); expect(mounts() - nextMounts).toBe(10);
      const inertShows = shows(), inertMounts = mounts(); captured.assertInertAuthorityCurrent();
      expect([shows() - inertShows, mounts() - inertMounts]).toEqual([0, 10]);
      const authorityShows = shows(), authorityMounts = mounts(); captured.assertAuthorityCurrent();
      expect([shows() - authorityShows, mounts() - authorityMounts]).toEqual([1, 20]);
      const observers = { scalarWitness: () => { throw Error("TEST observer"); }, pairedPin: () => { throw Error("TEST observer"); }, scalarTargetQuery: () => { throw Error("TEST observer"); }, pairedTargetQuery: () => { throw Error("TEST observer"); } };
      expect(() => assertResearchCurrentAuthority(started.jobId, current, undefined, false, observers)).not.toThrow();
      mutateReceipt(); expect(() => captured.assertAuthorityCurrent()).toThrow();
      expect(researchCurrentStart(started.jobId).spec.startId).toBe(started.startId);
      expect(host.authReads).toBe(0);
    } finally { Object.defineProperty(process, "platform", { value: platform }); }
  });
  // RED: dropping the final complete fence admits receipt/pin drift; dropping
  // its native/process readback admits changes during the last cold witness.
  it.each([
    ["service", "receipt"], ["service", "service"], ["service", "process"],
    ["material", "receipt"], ["material", "pin"],
    ["final-mount", "grant"], ["final-mount", "receipt"], ["final-mount", "process"], ["pin-mount", "pin"],
  ] as const)("refuses %s observation drift in %s before a runtime effect", async (phase, fault) => {
    await grantAndRequest(); const started = await start();
    host.group = `/system.slice/${started.unit}`;
    await bindRegisteredResearchRuntime(started.jobId, started.startId);
    const captured = captureResearchRuntime(selected()), current = researchCurrentStart(started.jobId);
    let changed = false;
    const mutate = (): void => {
      changed = true;
      if (fault === "receipt") mutateReceipt();
      if (fault === "process") host.birth = "98765";
      if (fault === "service") host.units.get(started.unit)!.invocation = "e".repeat(32);
      if (fault === "pin") host.pins.delete(join(current.directory, "pins/durable-handoff"));
      if (fault === "grant") researchPublish(join(researchJobAuthority(started.jobId), "grant.json"), {});
    };
    if (phase === "service") {
      const sync = childProcess.spawnSync;
      vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], options: unknown) => {
        if (!changed && command === "/usr/bin/systemctl" && args[0] === "show" && args[1] === started.unit) mutate();
        return Reflect.apply(sync, childProcess, [command, args, options]);
      }) as typeof sync);
    } else if (phase === "material") {
      const files = await import("../research-launch-files"), read = files.researchArtifactDigest;
      vi.spyOn(files, "researchArtifactDigest").mockImplementation(path => { const result = read(path); mutate(); return result; });
    } else {
      let observations = 0;
      host.findmntHook = () => { if (++observations === (phase === "pin-mount" ? 8 : 10)) mutate(); };
    }
    const effect = vi.fn();
    expect(() => { captured.assertCurrent(); effect(); }).toThrow();
    expect(changed).toBe(true); expect(effect).not.toHaveBeenCalled();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it("denies publication if the native grant changes during cold mount observation", async () => {
    await grantAndRequest(); const started = await start();
    host.group = `/system.slice/${started.unit}`;
    await bindRegisteredResearchRuntime(started.jobId, started.startId);
    const guard = researchTerminalHandoffGuard(started.jobId, started.startId);
    host.findmntHook = () => {
      host.findmntHook = undefined;
      writeFileSync(local(join("/run/user/subscription-runtime-research-v1", researchHash(selected().jobId), "grant.json")), "{}", { mode: 0o600 });
    };
    await expect(guard()).rejects.toThrow();
    expect(researchCurrentStart(started.jobId).spec.startId).toBe(started.startId);
  });
  it("requires the registered revoke port and retains active ownership after receipt invalidation", async () => {
    await grantAndRequest(); const started = await start();
    const grantPath = join("/run/user/subscription-runtime-research-v1", researchHash(selected().jobId), "grant.json");
    const sha = researchHash(researchRead(grantPath));
    expect(() => revokeResearchLaunch(started.jobId)).toThrow();
    mutateReceipt();
    await expect(revokeRegisteredResearchLaunch(started.jobId, "0".repeat(64))).rejects.toThrow();
    expect(existsSync(local(grantPath))).toBe(true);
    await revokeRegisteredResearchLaunch(started.jobId, sha);
    expect(existsSync(local(grantPath))).toBe(false);
    expect(researchCurrentStart(started.jobId).spec.startId).toBe(started.startId);
  });
  it("a stale registered cancel nonce cannot fence or stop the current start", async () => {
    await grantAndRequest(); const started = await start(), current = researchCurrentStart(started.jobId);
    const before = host.calls.length;
    await expect(cancelRegisteredResearchLaunch({ jobId: started.jobId,
      startId: "11111111-1111-1111-1111-111111111111", specSha256: started.specSha256,
      requestSha256: current.spec.requestSha256 })).rejects.toThrow();
    expect(host.calls.slice(before)).toEqual([]);
    expect(existsSync(local(join(current.directory, "closing.json")))).toBe(false);
  });
  it.each(["directory", "pin", "receipt"] as const)("denies replaced %s at publication and retains active ownership", async fault => {
    await grantAndRequest(); const started = await start();
    host.group = `/system.slice/${started.unit}`;
    await bindRegisteredResearchRuntime(started.jobId, started.startId);
    const guard = researchTerminalHandoffGuard(started.jobId, started.startId), current = researchCurrentStart(started.jobId);
    if (fault === "directory") { renameSync(local(sink), local(sink) + "-retired"); mkdirSync(local(sink), { mode: 0o700 }); }
    if (fault === "pin") host.pins.delete(join(current.directory, "pins/durable-handoff"));
    if (fault === "receipt") mutateReceipt();
    await expect(guard()).rejects.toThrow();
    expect(researchCurrentStart(started.jobId).spec.startId).toBe(started.startId);
    expect(() => cancelResearchLaunch(started.jobId)).toThrow();
    await expect(cancelRegisteredResearchLaunch({ jobId: started.jobId, startId: started.startId,
      specSha256: started.specSha256, requestSha256: current.spec.requestSha256 })).rejects.toThrow();
    expect(researchCurrentStart(started.jobId).spec.startId).toBe(started.startId);
  });
});

/** Same protected manifest/receipt boundary; no additional service mock suite. */
async function nativeProjectSelection() {
  const request = parseResearchOperatorRequest({ ...selected(), accounts: ["account-q"],
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel });
  state.scope = { ...state.scope!, allowedAccountIds: ["account-q"] };
  const path = codexGoalJobManifestPath({ registryRootDir: registry, jobId: request.jobId });
  const old = JSON.parse(readFileSync(local(path), "utf8"));
  delete old.durableHandoffRootDir;
  writeFileSync(local(path), JSON.stringify({ ...old, ...request, executionEngine: "app-server",
    workerReportMode: "structured-output", maxGoalTurns: 8,
    safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled", retryOnCapacity: false,
      retryOnAccountUnavailable: false, retryOnReconnectRequired: false } }), { mode: 0o600 });
  const loaded = await loadJobLaunch({ registryRootDir: registry, jobId: request.jobId });
  const receipt = JSON.parse(readFileSync(local(receiptPath()), "utf8"));
  writeFileSync(local(receiptPath()), JSON.stringify({ ...receipt,
    manifestSha256: researchHash(JSON.stringify(loaded.manifest)) }), { mode: 0o600 });
  const reservation = await reserveCodexProjectAccount({ manifest: loaded.manifest, launch: loaded.launch,
    deps: { capacityStore: new InMemoryWorkerAccountCapacityStore(), leaseMode: "shared" } });
  return { request, ...loaded, reservedLaunch: reservation.launch };
}
describe("native project launch authorization", () => {
  // RED: a clone/serialized reservation must never mint native effect authority.
  it("requires the original reservation and consumes its native authorization once without preparing a sink", async () => {
    const selected = await nativeProjectSelection(); rmdirSync(local(sink));
    const input = { registryRootDir: registry, controllerJobId: "TEST-controller", request: selected.request,
      reservedLaunch: selected.reservedLaunch };
    await expect(authorizeResearchProjectLaunch({ ...input, reservedLaunch: { ...selected.reservedLaunch } }))
      .rejects.toThrow("project_control_reserved_launch_authority_invalid");
    const authorization = await authorizeResearchProjectLaunch(input);
    const binding = await consumeResearchProjectLaunchAuthorization(authorization);
    expect(binding).toMatchObject({ registryRootDir: registry, controllerJobId: "TEST-controller",
      registeredExecution: { accountId: "account-q", maxAccountCycles: 1 } });
    expect(authorization.request.durableHandoffRootDir).toBeUndefined();
    expect(existsSync(local(sink))).toBe(false); expect(host.pins.size).toBe(0);
    await expect(consumeResearchProjectLaunchAuthorization(authorization)).rejects.toThrow();
  });
  // A project launch must traverse its owner port, and revoke cannot downgrade it.
  it("submits the reserved native adapter once and retains its project origin on revoke", async () => {
    const selected = await nativeProjectSelection();
    const start = await prepareProjectResearchLaunch({ registryRootDir: registry,
      controllerJobId: "TEST-controller", reservedLaunch: selected.reservedLaunch });
    expect(start).toBeTypeOf("function");
    const started = await start!();
    const current = researchCurrentStart(started.jobId);
    expect(current.spec.projectLaunchBinding?.registeredExecution?.accountId).toBe("account-q");
    expect(current.spec.registeredHandoff).toBeUndefined();
    expect(host.pins.has(join(current.directory, "pins/durable-handoff"))).toBe(false);
    host.group = `/system.slice/${started.unit}`;
    await bindProjectResearchRuntime(started.jobId, started.startId);
    const captured = captureResearchRuntime(selected.request);
    await expect(start!()).rejects.toThrow("project_control_native_launch_already_submitted");
    host.group = "/user.slice/TEST-operator.scope";
    await revokeProjectResearchLaunch(started.jobId, current.spec.grantSha256);
    expect(researchHash(researchRead(join("/run/user/subscription-runtime-research-v1", researchHash(started.jobId), "grant.json"))))
      .toBe(current.spec.grantSha256);
    host.group = `/system.slice/${started.unit}`;
    expect(() => captured.assertAuthorityCurrent()).toThrow();
    host.group = "/user.slice/TEST-operator.scope";
    expect(() => grantOwnedMimoWorkerLaunch(started.jobId, selected.request.jobRootDir, selected.request.workspacePath)).toThrow();
    expect(host.authReads).toBe(0);
  });
  // A terminal closure may release only its exact owner; a successor must
  // invalidate the prepared reader without systemd observation under topology.
  it.each(["grant", "active"] as const)("cold-checks a prepared native terminal release against successor %s", async successor => {
    const selected = await nativeProjectSelection();
    const start = await prepareProjectResearchLaunch({ registryRootDir: registry,
      controllerJobId: "TEST-controller", reservedLaunch: selected.reservedLaunch });
    const started = await start!(), authority = researchJobAuthority(started.jobId);
    const activePath = join(authority, "active.json"), activeBytes = researchRead(activePath);
    host.group = `/system.slice/${started.unit}`;
    await bindProjectResearchRuntime(started.jobId, started.startId);
    enterResearchOperatorScope(started.unit);
    cancelResearchLaunch(started.jobId);
    const read = await prepareResearchJobWriterObservation(selected.manifest);
    const calls = host.calls.length;
    expect(await read()).toEqual({ status: "released" });
    expect(host.calls).toHaveLength(calls);
    if (successor === "active") writeFileSync(local(activePath), activeBytes, { mode: 0o600 });
    else {
      const path = join(authority, "grant.json"), grant = JSON.parse(researchRead(path).toString());
      writeFileSync(local(path), JSON.stringify({ ...grant, grantId: "00000000-0000-4000-8000-000000000001" }), { mode: 0o600 });
    }
    expect(await read()).toEqual({ status: "unknown" });
    expect(host.calls).toHaveLength(calls);
    expect(host.authReads).toBe(0);
  });
  // RED: revocation between broker authorization and native grant consumption.
  it("rejects an authorization after its exact receipt is revoked", async () => {
    const selected = await nativeProjectSelection();
    const authorization = await authorizeResearchProjectLaunch({ registryRootDir: registry,
      controllerJobId: "TEST-controller", request: selected.request, reservedLaunch: selected.reservedLaunch });
    mutateReceipt();
    await expect(consumeResearchProjectLaunchAuthorization(authorization)).rejects.toThrow();
    expect(host.pins.size).toBe(0);
  });
});

async function registeredMimoCandidate(dirty = false, normalizedScope = false, status: "partial" | "failed" = "partial") {
  state.mimo = true; host.physicalPaths = true;
  registry = state.registry = join(host.root, "project/registry"); sink = join(registry, "durable-handoffs");
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  await initializeRegisteredFixture();
  if (normalizedScope) state.scope = parseCodexGoalProjectAccessScope(state.scope);
  const coding = await grantAndRequest();
  // Explicit retained pre-CodingV1 fixture: the current-authority path must
  // still settle old Worker attempts; fresh authorization cannot mint one.
  const { hostedProfile: _profile, maxGoalTurns: _turns, ...base } = coding;
  const legacy = parseResearchOperatorRequest(base);
  const grantPath = join(researchJobAuthority(legacy.jobId), "grant.json");
  const grant = JSON.parse(researchRead(grantPath).toString());
  expect(grant.hostedProfile).toBe(HostedMimoProfile.CodingV1);
  grant.hostedProfile = HostedMimoProfile.Worker;
  grant.registeredHandoff.requestSha256 = researchHashRequest(legacy);
  researchPublish(grantPath, grant);
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(legacy) + "\n", { mode: 0o600 });
  const started = await start(), current = researchCurrentStart(started.jobId);
  host.group = `/system.slice/${started.unit}`; await bindRegisteredResearchRuntime(started.jobId, started.startId);
  if (dirty) {
    const git = async (args: string[]) => await promisify(execFile)("git", ["-C", selected().workspacePath, ...args], { env: {
      ...process.env, GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
      GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
    } });
    await git(["init"]); writeFileSync(join(selected().workspacePath, "proof.txt"), "TEST baseline\n");
    await git(["add", "proof.txt"]);
    expect((await git(["var", "GIT_AUTHOR_IDENT"])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
    expect((await git(["var", "GIT_COMMITTER_IDENT"])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
    await git(["commit", "-m", "test: create registered MiMo TEST baseline"]);
    writeFileSync(join(selected().workspacePath, "proof.txt"), "TEST registered MiMo change\n");
  }
  researchPublish(join(current.directory, "mimo-candidate.json"), { schemaVersion: 1, jobId: started.jobId,
    taskId: current.spec.request.taskId, startId: started.startId, specSha256: started.specSha256,
    bindingSha256: researchHash(researchRead(join(current.directory, "binding.json"))),
    result: buildRuntimeResultEnvelope({ provider: "codex", runId: started.jobId, taskId: current.spec.request.taskId,
      status, evidence: ["TEST report retained"], nextAction: "continue" }) });
  enterResearchOperatorScope(started.unit);
  return { ...started, ...current };
}

describe.skipIf(process.platform !== "linux")("registered MiMo terminal publication", () => {
  it("preserves truthful partial report and actual patch in the registered durable sink", async () => {
    const current = await registeredMimoCandidate(true);
    expect(await finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).toMatchObject({ status: "partial" });
    const result = JSON.parse(readFileSync(join(selected().jobRootDir, `${selected().taskId}.latest-result.json`), "utf8"));
    expect(result).toMatchObject({ status: "partial", nextAction: "continue", evidence: ["TEST report retained"], changedFiles: ["proof.txt"] });
    expect(result.details.handoffPacketPath.startsWith(sink + "/")).toBe(true);
    const patch = result.artifacts.find((artifact: { kind: string }) => artifact.kind === "handoff_worktree");
    expect(readFileSync(patch.path, "utf8")).toContain("+TEST registered MiMo change");
    expect(existsSync(local(join(current.directory, "../../active.json")))).toBe(false);
    expect(host.units.get(current.unit)?.active).toBe(false);
  });
  it("refuses revoked registered receipt and retains active ownership and candidate", async () => {
    const current = await registeredMimoCandidate(); mutateReceipt();
    await expect(finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).rejects.toThrow();
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
    expect(existsSync(local(join(current.directory, "mimo-candidate.json")))).toBe(true);
    expect(existsSync(join(selected().jobRootDir, `${selected().taskId}.latest-result.json`))).toBe(false);
  });
  // Regression: clean capture bypassed the workspace lease and could race another writer.
  it("holds the actual registered workspace lease for clean capture through terminal release", async () => {
    const current = await registeredMimoCandidate(); let captureObserved = false;
    vi.spyOn(workspaceChanges, "changedFilesFromWorkspace").mockImplementationOnce(async path => {
      captureObserved = true;
      await expect(projectControlWorkspaceLocks(registry).acquire({ workspacePath: path, owner: "TEST-competing-writer" })).rejects.toThrow();
      expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
      return { changedFiles: [] };
    });
    const handoff = await import("../codex-goal-terminal-handoff-materialization");
    vi.spyOn(handoff, "materializeReconciledTerminalCodexGoalHandoff").mockResolvedValueOnce({ handoff: null, artifacts: [], changedPaths: [], baseCommit: undefined });
    expect(await finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).toMatchObject({ status: "partial" });
    expect(captureObserved).toBe(true);
    const locks = projectControlWorkspaceLocks(registry), lease = await locks.acquire({ workspacePath: selected().workspacePath, owner: "TEST-after-publication" });
    await locks.release(lease);
    const result = JSON.parse(readFileSync(join(selected().jobRootDir, `${selected().taskId}.latest-result.json`), "utf8"));
    expect(result).toMatchObject({ status: "partial", nextAction: "continue", evidence: ["TEST report retained"] });
    expect(existsSync(local(join(current.directory, "../../active.json")))).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("fresh registered fixed coding policy", () => {
  it.each([undefined, 63, 65])("rejects a new MiMo Worker or noncanonical budget %s before granting", async turns => {
    state.mimo = true; await initializeRegisteredFixture();
    const r = turns === undefined ? selected() : parseResearchOperatorRequest({ ...selected(), hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns: turns });
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: r,
      reservedLaunch: (await reserved()).reservedLaunch })).rejects.toThrow("hosted_research_registered_execution_unsupported");
    expect(existsSync(local(join(researchJobAuthority(r.jobId), "grant.json")))).toBe(false);
  });
  it("seals CodingV1/64 in its grant and derives the registered coding run config", async () => {
    state.mimo = true; await initializeRegisteredFixture();
    const r = await grantAndRequest();
    expect(r).toMatchObject({ hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns: 64 });
    const grant = JSON.parse(researchRead(join(researchJobAuthority(r.jobId), "grant.json")).toString());
    expect(grant.hostedProfile).toBe(HostedMimoProfile.CodingV1);
    expect(grant.registeredHandoff.requestSha256).toBe(researchHashRequest(r));
    // Registered coding uses the sealed budget and exact single-account policy.
    expect(researchRunConfig(r)).toMatchObject({ hostedProfile: HostedMimoProfile.CodingV1, executionEngine: "app-server", workerReportMode: "structured-output",
      maxGoalTurns: 64, maxAccountCycles: 1, prewarmOnStart: false, maxReconnectRetriesPerAccount: 0 });
  });
});

/** Real registered authorization, native allocation, root plan and lifetime
 * witness. Only the shared TEST fixture substitutes Host process/kernel IO. */
async function registeredCodingAllocation(beforeProvider = false) {
  state.mimo = true; host.physicalPaths = true;
  registry = state.registry = join(host.root, "project/registry"); sink = join(registry, "durable-handoffs");
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  await initializeRegisteredFixture();
  if (beforeProvider) state.scope = parseCodexGoalProjectAccessScope(state.scope);
  for (const path of researchMimoCodingBootstrapPaths("/TEST-artifact")) {
    mkdirSync(local(dirname(path)), { recursive: true, mode: 0o700 });
    writeFileSync(local(path), path.endsWith("package.json") ? '{"type":"module"}' : "export {};", { mode: 0o644 });
  }
  await grantAndRequest(); const started = await start(), current = researchCurrentStart(started.jobId);
  host.group = `/system.slice/${started.unit}`;
  await bindRegisteredResearchRuntime(started.jobId, started.startId);
  if (beforeProvider) { enterResearchOperatorScope(started.unit); return { ...started, ...current, provider: "",
    manifest: await readCodexGoalJob({ registryRootDir: registry, jobId: started.jobId }) }; }
  const home = join(current.spec.request.jobRootDir, "home/mimo-TEST/codex-home");
  mkdirSync(local(home), { recursive: true, mode: 0o700 });
  researchPublish(join(current.directory, "mimo-home.json"), { schemaVersion: 1,
    specSha256: researchHash(current.bytes), identity: researchDirectoryIdentity(home) }, true);
  const helper = admitResearchProcessFactory(current.spec.request)({ command: current.spec.request.codexBinaryPath,
    args: ["app-server"], cwd: current.spec.request.workspacePath, env: { HOME: dirname(home), CODEX_HOME: home } });
  const provider = readdirSync(local(join(current.directory, "providers")))[0]!.slice(0, -5);
  const plan = prepareResearchProviderRoot(current.spec, provider, home);
  bindResearchMimoWritableFootprint(plan);
  for (const stream of [helper.stdin, helper.stdout, helper.stderr]) {
    if (!(stream instanceof PassThrough)) throw new Error("Expected disposable TEST provider stream");
    stream.destroy();
  }
  return { ...started, ...current, provider,
    manifest: await readCodexGoalJob({ registryRootDir: registry, jobId: started.jobId }) };
}

describe.skipIf(process.platform !== "linux")("registered CodingV1 writer census", () => {
  it("counts the actual one-workspace allocation before provider heartbeat with no omitted caches", async () => {
    const current = await registeredCodingAllocation();
    const plan = JSON.parse(researchRead(join(current.directory, "provider-roots", current.provider, "plan.json")).toString());
    expect(plan.captured.omittedCaches).toEqual([]);
    const roots = observeResearchMimoAllocationWritableRoots(current.spec);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ source: join(current.directory, "pins/workspace"), target: current.manifest.workspacePath });
    expect(host.units.has(current.provider)).toBe(false);
    const calls = host.calls.filter(call => call.command === "/usr/bin/systemctl").length;
    expect(await observeResearchJobWriterAuthority(current.manifest)).toEqual({ status: "allocated",
      roots: roots.map(({ device, backingPath }) => ({ device, backingPath })) });
    expect(host.calls.filter(call => call.command === "/usr/bin/systemctl")).toHaveLength(calls);
    expect(host.authReads).toBe(0);
  });
  it.each(["claim", "scope", "receipt", "late-receipt", "pin", "plan", "active"] as const)("retains Unknown on allocated %s drift", async fault => {
    const current = await registeredCodingAllocation();
    if (fault === "scope") state.scope = { ...state.scope!, allowedAccountIds: [] };
    if (fault === "receipt") mutateReceipt();
    let changedDuringPinRead = false;
    if (fault === "late-receipt") {
      const fs = await import("node:fs"), stat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation(((path: string) => {
        const result = stat(path);
        if (path === join(current.directory, "pins/workspace") && !changedDuringPinRead) {
          changedDuringPinRead = true; mutateReceipt();
        }
        return result;
      }) as typeof stat);
    }
    if (fault === "pin") host.pins.set(join(current.directory, "pins/workspace"), current.spec.request.jobRootDir);
    if (fault === "plan") {
      const path = join(current.directory, "provider-roots", current.provider, "plan.json"), plan = JSON.parse(researchRead(path).toString());
      researchPublish(path, { ...plan, captured: { ...plan.captured, omittedCaches: [{}] } });
    }
    if (fault === "active") writeFileSync(local(join(researchJobAuthority(current.jobId), "active.json")), "{}", { mode: 0o600 });
    const manifest = fault === "claim" ? { ...current.manifest, taskId: "TEST-unrelated-claim" } : current.manifest;
    expect(await observeResearchJobWriterAuthority(manifest)).toEqual({ status: "unknown" });
    if (fault === "late-receipt") expect(changedDuringPinRead).toBe(true);
    expect(existsSync(local(join(researchJobAuthority(current.jobId), "active.json")))).toBe(true);
    expect(host.authReads).toBe(0);
  });
  it.each(["receipt", "controller", "grant", "active", "spec"] as const)("releases only its prepared exact terminal start and cold-checks %s", async fault => {
    const current = await registeredCodingAllocation(), authority = researchJobAuthority(current.jobId);
    const active = researchRead(join(authority, "active.json"));
    // Terminal capture sees actual clean Git state in this allocated TEST
    // workspace. No terminal reader or publication guard is replaced.
    const git = async (args: string[]) => await promisify(execFile)("git", ["-C", current.manifest.workspacePath, ...args], { env: {
      ...process.env, GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
      GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
    } });
    await git(["init"]); writeFileSync(join(current.manifest.workspacePath, "proof.txt"), "TEST registered Coding census\n");
    await git(["add", "proof.txt"]); await git(["commit", "-m", "test: initialize registered Coding census"]);
    enterResearchOperatorScope(current.unit);
    await cancelRegisteredResearchLaunch({ jobId: current.jobId, startId: current.startId,
      specSha256: current.specSha256, requestSha256: current.spec.requestSha256 });
    const read = await prepareResearchJobWriterObservation(current.manifest), calls = host.calls.filter(call => call.command === "/usr/bin/systemctl").length;
    expect(await read()).toEqual({ status: "released" }); expect(host.calls.filter(call => call.command === "/usr/bin/systemctl")).toHaveLength(calls);
    if (fault === "receipt") mutateReceipt();
    if (fault === "controller") writeFileSync(local(codexGoalJobManifestPath({ registryRootDir: registry, jobId: "TEST-controller" })), '{"revoked":true}', { mode: 0o600 });
    if (fault === "grant") {
      const path = join(authority, "grant.json"), grant = JSON.parse(researchRead(path).toString());
      researchPublish(path, { ...grant, grantId: "00000000-0000-4000-8000-000000000001" });
    }
    if (fault === "active") writeFileSync(local(join(authority, "active.json")), active, { mode: 0o600 });
    if (fault === "spec") researchPublish(join(current.directory, "spec.json"), { ...current.spec, artifactSha256: "e".repeat(64) });
    expect(await read()).toEqual({ status: "unknown" }); expect(host.calls.filter(call => call.command === "/usr/bin/systemctl")).toHaveLength(calls);
    expect(host.authReads).toBe(0);
  });
});


describe("qualified preservation recovery (explicit offline Linux Host fixture)", () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(runtimeArtifact, "assertQualifiedResearchRuntimeArtifact").mockImplementation((directory, digest) => {
      expect(directory).toBe("/TEST-artifact"); expect(researchArtifactDigest(directory)).toBe(digest);
    });
  });
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }));
  registeredTerminalRepairTests({ candidate: (dirty, status) => registeredMimoCandidate(dirty, true, status), scope: () => state.scope!,
    setScope: scope => { state.scope = scope; }, registry: () => registry, allocation: () => registeredCodingAllocation() });
  registeredStoppedBeforeProviderTests({ start: () => registeredCodingAllocation(true), scope: () => state.scope!, setScope: scope => { state.scope = scope; } });
  it("uses the qualified producer with original registered authority and releases only after durable publication", async () => {
    const current = await registeredMimoCandidate(true);
    const retained = ["spec.json", "binding.json", "mimo-candidate.json", "durable-pin.json"].map(name =>
      [name, researchRead(join(current.directory, name))] as const);
    expect(await recoverOwnedMimoWorkerPreservation({ jobId: current.jobId, startId: current.startId,
      specSha256: current.specSha256, requestSha256: current.spec.requestSha256 })).toMatchObject({ status: "partial" });
    for (const [name, bytes] of retained) expect(researchRead(join(current.directory, name))).toEqual(bytes);
    const output = JSON.parse(readFileSync(join(selected().jobRootDir, `${selected().taskId}.latest-result.json`), "utf8"));
    expect(output.status).toBe("partial"); expect(output.details.handoffPacketPath.startsWith(sink + "/")).toBe(true);
    expect(existsSync(local(join(researchJobAuthority(current.jobId), "active.json")))).toBe(false);
    expect(runtimeArtifact.assertQualifiedResearchRuntimeArtifact).toHaveBeenCalled();
  });
  it("denies a changed original request before release or result publication", async () => {
    const current = await registeredMimoCandidate(true);
    await expect(recoverOwnedMimoWorkerPreservation({ jobId: current.jobId, startId: current.startId,
      specSha256: current.specSha256, requestSha256: "0".repeat(64) })).rejects.toThrow("hosted_research_launch_denied");
    expect(existsSync(local(join(researchJobAuthority(current.jobId), "active.json")))).toBe(true);
    expect(existsSync(local(join(current.directory, "mimo-publication.json")))).toBe(false);
  });
});
