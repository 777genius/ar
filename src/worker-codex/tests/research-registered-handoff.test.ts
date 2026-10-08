import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmdirSync, statSync, cpSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { authorizeRegisteredResearchHandoff, consumeRegisteredResearchHandoffAuthorization, RegisteredResearchSinkPreparationUnresolved, RegisteredResearchHandoffUnsupportedSink } from "../research-registered-handoff";
import { grantRegisteredResearchLaunch, startRegisteredResearchLaunch, startResearchLaunch, revokeResearchLaunch, revokeRegisteredResearchLaunch } from "../research-launch-owner";
import { bindRegisteredResearchRuntime, researchCurrentStart, researchTerminalHandoffGuard } from "../research-launch-admission";
import { cancelResearchLaunch, cancelRegisteredResearchLaunch } from "../research-launch-lifecycle";
import { researchHash, researchRead } from "../research-launch-files";
import { parseResearchOperatorRequest, researchRunConfig } from "../research-launch-contract";
import { readCodexGoalJob, codexGoalJobManifestPath } from "../codex-goal-jobs";

const state = vi.hoisted(() => ({ scope: undefined as ProjectAccessScope | undefined }));
// This suite exercises the native registered boundary with real TEST manifests,
// receipt bytes and directory replacements. The upstream clean Git admission
// and controller loader have their own tests; neither Host services nor models run.
vi.mock("../codex-goal-mcp-project-control-deps", async original => {
  const real = await original<typeof import("../codex-goal-mcp-project-control-deps")>();
  return { ...real, loadProjectControlController: async () => ({ registryRootDir: "/TEST-project/registry",
    controller: { jobId: "TEST-controller", jobRootDir: "/TEST-project/controller" }, scope: state.scope! }) };
});
vi.mock("../application/project-control/codex-goal-project-pre-start-admission", async original => {
  const real = await original<typeof import("../application/project-control/codex-goal-project-pre-start-admission")>();
  return { ...real, readLaunchAuthorizedWorkerLaunchAttestation: async (input: { manifest: { projectPreStartAdmission: { receiptPath: string } } }) => {
    const { researchRead, researchHash } = await import("../research-launch-files");
    return { launch: {}, receiptSha256: researchHash(researchRead(input.manifest.projectPreStartAdmission.receiptPath)) };
  } };
});
const registry = "/TEST-project/registry", sink = join(registry, "durable-handoffs");
const selected = () => parseResearchOperatorRequest({ ...request(), accounts: ["TEST-a"] });
const receiptPath = () => join(selected().jobRootDir, "pre-start-admission/receipt.json");
beforeEach(async () => {
  setupResearchFixture();
  const r = selected(), descriptorRoot = join(r.jobRootDir, "pre-start-admission");
  state.scope = { projectId: "TEST-project", registryRoot: registry, workspaceRoots: [r.workspacePath],
    authRoot: r.authRootDir, jobIdPrefixes: ["TEST-research"], allowedAccountIds: ["TEST-a"] };
  for (const path of [sink, join(registry, r.jobId), join(registry, "TEST-controller"), descriptorRoot, "/TEST-project/controller"]) {
    mkdirSync(local(path), { recursive: true, mode: 0o700 });
  }
  writeFileSync(local(codexGoalJobManifestPath({ registryRootDir: registry, jobId: "TEST-controller" })), "{}", { mode: 0o600 });
  writeFileSync(local(join(descriptorRoot, "contract.json")), "{}", { mode: 0o600 });
  writeFileSync(local(join(descriptorRoot, "state.json")), "{}", { mode: 0o600 });
  writeFileSync(local(codexGoalJobManifestPath({ registryRootDir: registry, jobId: r.jobId })), JSON.stringify({ ...r,
    durableHandoffRootDir: sink, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
    projectPreStartAdmission: { schemaVersion: 1, mode: "serial-builtin", contractPath: join(descriptorRoot, "contract.json"),
      statePath: join(descriptorRoot, "state.json"), receiptPath: receiptPath() },
  }), { mode: 0o600 });
  const manifest = await readCodexGoalJob({ registryRootDir: registry, jobId: r.jobId });
  writeFileSync(local(receiptPath()), JSON.stringify({ status: "launch_authorized", launchAuthorizationCount: 1,
    jobId: r.jobId, manifestSha256: researchHash(JSON.stringify(manifest)), contractSha256: researchHash("{}"),
    stateSha256: researchHash("{}"), promptSha256: researchHash(researchRead(r.promptPath)),
  }), { mode: 0o600 });
});
afterEach(cleanupResearchFixture);
const authorize = () => authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: selected() });
async function grantAndRequest() {
  const authorization = await authorize();
  await grantRegisteredResearchLaunch(authorization);
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(authorization.request) + "\n", { mode: 0o600 });
  return authorization.request;
}
const start = () => startRegisteredResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
function mutateReceipt() {
  const receipt = JSON.parse(readFileSync(local(receiptPath()), "utf8"));
  writeFileSync(local(receiptPath()), JSON.stringify({ ...receipt, status: "admitted" }), { mode: 0o600 });
}

describe("registered durable handoff authorization (NEW TEST source fixtures only)", () => {
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
    await expect(authorizeRegisteredResearchHandoff({ registryRootDir: registry, controllerJobId: "TEST-controller", request: r })).rejects.toThrow();
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
  it("retains a verified durable pin and forwards its sink only to the trusted runtime", async () => {
    await grantAndRequest();
    const started = await start(), current = researchCurrentStart(started.jobId);
    host.group = `/system.slice/${started.unit}`;
    await bindRegisteredResearchRuntime(started.jobId, started.startId);
    expect(host.pins.get(join(current.directory, "pins/durable-handoff"))).toBe(sink);
    const submission = host.calls.find(call => call.command === "/usr/bin/systemd-run")!;
    expect(submission.args).toContain(`--property=BindPaths=${join(current.directory, "pins/durable-handoff")}:${sink}:norbind`);
    expect(researchRunConfig(current.spec.request).durableHandoffRootDir).toBe(sink);
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
