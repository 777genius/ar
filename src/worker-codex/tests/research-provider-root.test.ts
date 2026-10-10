import { publicTestCa, publicTestLeaf, host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { prepareResearchProviderRoot, assertResearchProviderRoot, researchProviderRootFailureCheck, ResearchProviderRootCheck, ResearchRootMountAccess, ResearchRootReadRole, type ResearchProviderRootHost } from "../research-provider-root";
import { trustedResearchProviderLaunch } from "../trusted-custody-systemd-launch";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";
import type { ResearchStartSpec } from "../research-launch-contract";
import { parseResearchOperatorRequest } from "../research-launch-contract";
import { researchDurableDirectory } from "../research-durable-handoff-directory";
import * as scratchAdapter from "../host-scratch-temp";
import { CodexModelBackend, codexMimoDefaultModel } from "../../provider-codex/codex-model-backend";
import { HostedMimoProfile } from "../../provider-codex/hosted-mimo-profile";
import { researchMimoCodingPublicMaterials } from "../research-mimo-coding-public-materials";
import { researchMimoCodingBootstrapPaths, researchMimoCodingCodexHome, researchMimoCodingHome } from "../research-mimo-coding-root";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const unit = "subscription-runtime-research-provider-11111111-1111-1111-1111-111111111111.service";
function captured(job = request().jobRootDir, runtime = "/TEST-artifact", externalCodex = false) {
  const req = { ...request(), jobRootDir: job, workspacePath: "/TEST-project/disjoint-workspace", promptPath: join(job, "prompt.md"),
    ...(externalCodex ? { codexBinaryPath: "/opt/codex/bin/codex" } : {}) };
  for (const path of [job, req.workspacePath, join(job, "home/TEST-a"), runtime]) fs.mkdirSync(local(path), { recursive: true, mode: 0o700 });
  if (externalCodex) {
    fs.mkdirSync(local("/opt/codex/bin"), { recursive: true, mode: 0o755 });
    fs.writeFileSync("/opt/codex/bin/codex", "TEST executable", { mode: 0o755 });
    fs.writeFileSync("/opt/codex/package.json", '{"name":"@openai/codex"}', { mode: 0o644 });
  }
  fs.writeFileSync(req.promptPath, "TEST root contract prompt", { mode: 0o600 });
  fs.writeFileSync("/TEST-operator/request.json", JSON.stringify(req) + "\n", { mode: 0o600 });
  grantResearchLaunch(req.jobId, job, req.workspacePath);
  const start = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  const current = researchCurrentStart(start.jobId);
  // The fixture's trusted owner captures an immutable runtime at an alternate
  // path to test ancestry independently of the installed source directory.
  const spec: ResearchStartSpec = { ...current.spec, runtimeDirectory: runtime };
  researchPublish(join(current.directory, "spec.json"), spec);
  const specSha256 = researchHash(researchRead(join(current.directory, "spec.json")));
  researchPublish(join(current.directory, "providers", unit + ".json"), { schemaVersion: 1, unit, runtimeUnit: spec.unit,
    specSha256, description: `subscription-runtime-research-provider:${spec.startId}:${unit}` }, true);
  host.spawn.mockClear();
  return { spec, directory: current.directory, home: join(job, "home/TEST-a") };
}
function withRegisteredSink(f: ReturnType<typeof captured>, registryRootDir: string) {
  const sink = join(registryRootDir, "durable-handoffs");
  fs.mkdirSync(local(sink), { recursive: true, mode: 0o700 });
  const request = parseResearchOperatorRequest({ ...f.spec.request, durableHandoffRootDir: sink });
  const spec: ResearchStartSpec = { ...f.spec, request, registeredHandoff: { registryRootDir,
    controllerJobId: "TEST-controller", manifestSha256: "a".repeat(64), scopeSha256: "b".repeat(64),
    receiptSha256: "c".repeat(64), requestSha256: researchHash(JSON.stringify(request)), durableDirectory: researchDurableDirectory(sink) } };
  researchPublish(join(f.directory, "spec.json"), spec);
  const specSha256 = researchHash(researchRead(join(f.directory, "spec.json")));
  researchPublish(join(f.directory, "providers", unit + ".json"), { schemaVersion: 1, unit, runtimeUnit: spec.unit,
    specSha256, description: `subscription-runtime-research-provider:${spec.startId}:${unit}` });
  return { ...f, spec, sink };
}
function observingHost() {
  const effects: string[] = [], extraMounts: string[] = [], overrides = new Map<string, ReturnType<ResearchProviderRootHost["info"]>>();
  let tableTransform = (value: string): string => value;
  const adapter: ResearchProviderRootHost = {
    info: path => overrides.get(path) ?? fs.lstatSync(path), canonical: fs.realpathSync, link: fs.readlinkSync,
    read: path => path === "/proc/self/mountinfo" ? tableTransform(fs.readFileSync(path, "utf8") + extraMounts.join("\n") + (extraMounts.length ? "\n" : "")) : fs.readFileSync(path, "utf8"),
    entries: fs.readdirSync,
    mkdir: (path, mode) => { effects.push("mkdir:" + path); fs.mkdirSync(path, { mode }); },
    symlink: (target, path) => { effects.push("symlink:" + path); fs.symlinkSync(target, path); },
    file: path => { effects.push("file:" + path); fs.writeFileSync(path, "", { mode: 0o644, flag: "wx" }); },
    regular: (path, expected, role) => {
      const limit = role === ResearchRootReadRole.ScratchPolicy ? 8 * 1024 * 1024 : role === ResearchRootReadRole.CaBundle ? 1024 * 1024 : 65536;
      const info = overrides.get(path) ?? fs.lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.dev !== expected.dev || info.ino !== expected.ino || info.uid !== expected.uid || info.gid !== expected.gid || info.mode !== expected.mode || fs.lstatSync(path).size > limit) throw new Error("TEST resolver identity denied");
      return fs.readFileSync(path, "utf8");
    },
    snapshot: (path, bytes) => { effects.push("snapshot:" + path); fs.writeFileSync(path, bytes, { mode: 0o444, flag: "wx" }); },
    publish: (path, value) => { effects.push("publish:" + path); researchPublish(path, value, true); },
    record: path => researchRead(path).toString("utf8"),
  };
  return { adapter, effects, extraMounts, overrides, transform: (fn: typeof tableTransform) => { tableTransform = fn; } };
}
function resolvedFixture(observed: ReturnType<typeof observingHost>) {
  fs.unlinkSync("/etc/resolv.conf"); fs.symlinkSync("../run/systemd/resolve/stub-resolv.conf", "/etc/resolv.conf");
  fs.mkdirSync(local("/run/systemd/resolve"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(local("/usr/lib/systemd/system"), { recursive: true, mode: 0o755 });
  fs.writeFileSync("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\nsystemd-resolve:x:992:992:Resolver:/:/usr/sbin/nologin\n", { mode: 0o644 });
  fs.writeFileSync("/usr/lib/systemd/system/systemd-resolved.service", "[Service]\nUser=systemd-resolve\n", { mode: 0o644 });
  const target = "/run/systemd/resolve/stub-resolv.conf";
  fs.writeFileSync(target, "nameserver 192.0.2.1\n", { mode: 0o644 });
  for (const path of ["/run/systemd/resolve", target]) observed.overrides.set(path, Object.assign(Object.create(fs.lstatSync(path)), { uid: 992, gid: 992 }));
  return target;
}
async function resolvedSocketFixture(observed: ReturnType<typeof observingHost>) {
  resolvedFixture(observed);
  const conf = "/run/systemd/resolve/resolv.conf";
  fs.writeFileSync(conf, "nameserver 192.0.2.2\n", { mode: 0o644 });
  observed.overrides.set(conf, Object.assign(Object.create(fs.lstatSync(conf)), { uid: 992, gid: 992 }));
  // Real TEST sockets; the directory fd keeps long scratch paths below sun_path.
  const fd = fs.openSync(local("/run/systemd/resolve"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const servers: Server[] = [];
  const close = async () => {
    try { await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); }
    finally { fs.closeSync(fd); }
  };
  const paths = ["/run/systemd/resolve/io.systemd.Resolve", "/run/systemd/resolve/io.systemd.Resolve.Monitor"] as const;
  try {
    for (const [index, path] of paths.entries()) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(`/proc/self/fd/${fd}/${path.slice(path.lastIndexOf("/") + 1)}`, resolve);
      });
      servers.push(server);
      fs.chmodSync(local(path), index === 0 ? 0o666 : 0o600);
      observed.overrides.set(path, Object.assign(Object.create(fs.lstatSync(path)), { uid: 992, gid: 992 }));
    }
    return { paths, close };
  } catch (error) { await close(); throw error; }
}
function expectNoRootEffects(f: ReturnType<typeof captured>, observed: ReturnType<typeof observingHost>) {
  expect(observed.effects).toEqual([]);
  expect(fs.existsSync(local(join(f.directory, "provider-roots")))).toBe(false);
  expect(host.spawn).not.toHaveBeenCalled();
  expect(fs.existsSync(local(join(f.directory, "providers", unit + ".submission.json")))).toBe(false);
  expect(host.authReads).toBe(0);
}
const namespaceMount = (point: string, root = "net:[4026531840]", device = "0:4", filesystem = "nsfs", source = "nsfs") =>
  `900 1 ${device} ${root} ${point} rw - ${filesystem} ${source} rw`;
const deletedMount = (point: string, root = "/jobs/TEST-foreign/.research/.cache/toolchain//deleted", filesystem = "ext4") =>
  `900 1 8:1 ${root} ${point} rw - ${filesystem} /dev/TEST rw`;

function codingCaptured() {
  const f = captured();
  // Root-layout preparation only: independent CodingV1 activation stays closed.
  const request = parseResearchOperatorRequest({ ...f.spec.request, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns: 64, model: codexMimoDefaultModel, accounts: ["account-q"],
    maxAccountCycles: 1, prewarmOnStart: false });
  const spec = { ...f.spec, request };
  researchPublish(join(f.directory, "spec.json"), spec);
  const specSha256 = researchHash(researchRead(join(f.directory, "spec.json")));
  researchPublish(join(f.directory, "providers", unit + ".json"), { schemaVersion: 1, unit, runtimeUnit: spec.unit,
    specSha256, description: `subscription-runtime-research-provider:${spec.startId}:${unit}` });
  for (const path of researchMimoCodingBootstrapPaths(spec.runtimeDirectory)) {
    fs.mkdirSync(local(dirname(path)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path, path.endsWith("package.json") ? '{"type":"module"}' : 'export {};', { mode: 0o644 });
  }
  return { ...f, spec };
}

describe("closed provider root graph (native adapter over disposable TEST files)", () => {
  it("prepares CodingV1 with only its pinned workspace writable and a finite launcher closure", () => {
    const f = codingCaptured(), observed = observingHost();
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    expect(plan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite).map(bind => [bind.source, bind.target]))
      .toEqual([[join(f.directory, "pins/workspace"), f.spec.request.workspacePath]]);
    expect(plan.bindings.some(bind => bind.target === f.spec.request.jobRootDir || bind.target === f.spec.runtimeDirectory ||
      bind.target === researchMimoCodingHome || bind.target === researchMimoCodingCodexHome)).toBe(false);
    expect(plan.bindings.filter(bind => bind.target.startsWith(f.spec.runtimeDirectory + "/")).map(bind => bind.target).sort())
      .toEqual([...researchMimoCodingBootstrapPaths(f.spec.runtimeDirectory)].sort());
    for (const path of [researchMimoCodingHome, researchMimoCodingCodexHome]) {
      expect(fs.readdirSync(join(plan.fixedRootDirectory, path.slice(1)))).toEqual(path === researchMimoCodingHome ? [".codex"] : []);
    }
    expect(plan.codingBootstrap).toEqual({ schemaVersion: 1, startId: f.spec.startId,
      specSha256: researchHash(researchRead(join(f.directory, "spec.json"))), workspacePath: f.spec.request.workspacePath });
    expect(Object.isFrozen(plan.codingBootstrap)).toBe(true);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).not.toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it("captures only fixed CodingV1 policy bytes despite Host and project config", () => {
    const f = codingCaptured(), observed = observingHost();
    fs.mkdirSync(local("/etc/codex"), { recursive: true, mode: 0o755 });
    fs.writeFileSync("/etc/codex/requirements.toml", "TEST_HOST_POLICY_NEVER_IMPORT", { mode: 0o644 });
    fs.mkdirSync(local(join(f.spec.request.workspacePath, ".codex")), { mode: 0o755 });
    fs.writeFileSync(join(f.spec.request.workspacePath, ".codex/config.toml"),
      'model_catalog_json = "/TEST/foreign-models.json"\n[mcp_servers.TEST]\ncommand = "/TEST/foreign"\n', { mode: 0o644 });
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    for (const file of researchMimoCodingPublicMaterials) {
      const bind = plan.bindings.find(bind => bind.target === file.target)!;
      expect(bind.source).toBe(join(f.directory, "provider-roots", unit, file.name));
      expect(bind.access).toBe(ResearchRootMountAccess.ReadOnly); expect(bind.file).toBe(true);
      expect(fs.readFileSync(bind.source, "utf8")).toBe(file.bytes);
      expect(fs.lstatSync(bind.source).mode & 0o7777).toBe(0o444);
      expect(fs.lstatSync(bind.source).nlink).toBe(1);
      expect(fs.readFileSync(join(plan.fixedRootDirectory, file.target.slice(1)), "utf8")).toBe("");
    }
    expect(fs.lstatSync(join(plan.fixedRootDirectory, "etc/codex")).mode & 0o7777).toBe(0o755);
    expect(plan.bindings.some(bind => bind.source === "/etc/codex" || bind.source.startsWith("/etc/codex/"))).toBe(false);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).not.toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each(researchMimoCodingPublicMaterials.flatMap(file => ["bytes", "symlink", "writable", "mount"].map(fault => ({ file, fault }))))(
    "rejects changed CodingV1 $file.name $fault before a retained root can be used", ({ file, fault }) => {
      const f = codingCaptured(), observed = observingHost();
      const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
      const bind = plan.bindings.find(bind => bind.target === file.target)!;
      if (fault === "bytes") {
        fs.chmodSync(local(bind.source), 0o644); fs.writeFileSync(bind.source, "X".repeat(Buffer.byteLength(file.bytes))); fs.chmodSync(local(bind.source), 0o444);
      }
      if (fault === "symlink") { fs.unlinkSync(bind.source); fs.symlinkSync(f.spec.request.promptPath, local(bind.source)); }
      if (fault === "writable") fs.chmodSync(local(bind.source), 0o644);
      if (fault === "mount") observed.extraMounts.push(`900 1 8:1 /TEST-foreign ${bind.source} rw - ext4 /dev/TEST rw`);
      expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    });
  it("rejects a guest home as the Host CodingV1 admission home before creating any root", () => {
    const f = codingCaptured(), observed = observingHost();
    expect(() => prepareResearchProviderRoot(f.spec, unit, researchMimoCodingCodexHome, undefined, observed.adapter))
      .toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it("rejects a symlink in the Host admission home without exposing it to CodingV1", () => {
    const f = codingCaptured(), observed = observingHost();
    fs.rmdirSync(local(f.home)); fs.symlinkSync(f.spec.request.workspacePath, local(f.home));
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it("rejects a symlink in the finite CodingV1 launcher closure before root effects", () => {
    const f = codingCaptured(), observed = observingHost();
    const path = researchMimoCodingBootstrapPaths(f.spec.runtimeDirectory)[1]!;
    fs.unlinkSync(path); fs.symlinkSync(f.spec.request.promptPath, path);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it("revalidates CodingV1 workspace mounts after preparation", () => {
    const f = codingCaptured(), observed = observingHost();
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    observed.extraMounts.push(`900 1 8:2 / ${f.spec.request.workspacePath}/TEST-foreign rw - ext4 /dev/TEST-other rw`);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // RED if the creator retains a stale initial Host witness while its other
  // sealed filesystem observations remain unchanged.
  it("re-observes the Host mount namespace before a branded root can be sealed again", () => {
    const f = captured(), observed = observingHost();
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).not.toThrow();
    const effects = [...observed.effects];
    host.processNamespaces.set(1, { user: "user:[4026531837]", mnt: "mnt:[4026533000]", pid: "pid:[4026531836]", net: "net:[4026531840]" });
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
    expect(() => trustedResearchProviderLaunch(f.spec, unit, f.home, plan)).toThrow("hosted_research_launch_denied");
    expect(observed.effects).toEqual(effects); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: Linux emits unrelated NSFS descriptors and deleted roots in
  // mountinfo. Rejecting the entire table prevents every admitted root plan.
  it("retains unrelated opaque kernel mount roots without importing them", () => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(
      "900 1 0:44 net:[4026533000] /TEST-opaque-net rw - nsfs nsfs rw",
      "901 1 8:2 /TEST-retired//deleted /TEST-opaque-deleted rw - ext4 /dev/TEST-other rw",
    );
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    expect(plan.bindings.some(bind => bind.source.startsWith("/TEST-opaque") || bind.target.startsWith("/TEST-opaque"))).toBe(false);
    expect(fs.existsSync(join(plan.fixedRootDirectory, "TEST-opaque-net"))).toBe(false);
    expect(fs.existsSync(join(plan.fixedRootDirectory, "TEST-opaque-deleted"))).toBe(false);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    // Revalidation must still see an opaque child; dropping opaque rows would
    // conceal it from the unchanged nonrecursive bind topology checks.
    observed.extraMounts.push(`902 1 0:45 net:[4026533001] ${f.spec.request.workspacePath}/TEST-opaque rw - nsfs nsfs rw`);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
  });
  it.each([
    ["namespace-pin", "net:[4026533000]", "nsfs", "pin-ancestor"],
    ["namespace-protected", "net:[4026533000]", "nsfs", "protected"],
    ["deleted-pin", "/TEST-retired//deleted", "ext4", "pin-ancestor"],
    ["deleted-protected", "/TEST-retired//deleted", "ext4", "protected"],
  ] as const)("denies %s opaque ancestry before all effects", (_kind, root, filesystem, selected) => {
    const f = captured(), observed = observingHost();
    // A different-device opaque ancestor remains forbidden even beneath an
    // intentional pin mount with a normal selected root and matching inode.
    const point = selected === "pin-ancestor" ? join(f.directory, "pins") : f.spec.request.authRootDir;
    const device = filesystem === "nsfs" ? "0:44" : "8:2", source = filesystem === "nsfs" ? "nsfs" : "/dev/TEST-other";
    observed.extraMounts.push(`900 1 ${device} ${root} ${point} rw - ${filesystem} ${source} rw`);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it.each([
    ["namespace", "net:[4026533000]", "nsfs"], ["deleted", "/TEST-retired//deleted", "ext4"],
  ] as const)("keeps nested %s opaque mounts visible to RO and RW vetoes", (_kind, root, filesystem) => {
    const f = captured(), observed = observingHost();
    const device = filesystem === "nsfs" ? "0:44" : "8:2", source = filesystem === "nsfs" ? "nsfs" : "/dev/TEST-other";
    observed.extraMounts.push(`900 1 ${device} ${root} /usr/TEST-opaque rw - ${filesystem} ${source} rw`);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
    observed.extraMounts[0] = `900 1 ${device} ${root} ${f.spec.request.workspacePath}/TEST-opaque rw - ${filesystem} ${source} rw`;
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it.each([
    ["net:[4026533000]", "ext4", "8:2", "/dev/TEST-other"],
    // mnt is a native namespace type; this row spoofs nsfs's major-zero device.
    ["mnt:[4026533000]", "nsfs", "8:2", "nsfs"], ["net:[0]", "nsfs", "0:44", "nsfs"],
    ["net:[04026533000]", "nsfs", "0:44", "nsfs"], ["net:[-1]", "nsfs", "0:44", "nsfs"],
    ["net:[1]/extra", "nsfs", "0:44", "nsfs"],
    ["/TEST/../retired//deleted", "ext4", "8:2", "/dev/TEST-other"],
    ["/TEST-retired///deleted", "ext4", "8:2", "/dev/TEST-other"],
    ["/TEST-retired//deleted/extra", "ext4", "8:2", "/dev/TEST-other"],
    ["/TEST-retired//deleted", "nsfs", "0:44", "nsfs"],
  ] as const)("rejects unknown or malformed opaque root %s on %s", (root, filesystem, device, source) => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(`900 1 ${device} ${root} /TEST-unrelated rw - ${filesystem} ${source} rw`);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it("a registered sink is absent from every provider RO/RW binding and skeleton", () => {
    const f = withRegisteredSink(captured(), "/TEST-project/registry"), observed = observingHost();
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    expect(plan.bindings.some(bind => bind.target === f.sink || bind.source === f.sink)).toBe(false);
    expect(plan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite).map(bind => bind.target))
      .toEqual([f.spec.request.jobRootDir, f.spec.request.workspacePath]);
    expect(fs.existsSync(join(plan.fixedRootDirectory, f.sink))).toBe(false);
    expect(trustedResearchProviderLaunch(f.spec, unit, f.home, plan).args.some(arg => arg.includes(f.sink))).toBe(false);
  });
  it("refuses a sink under a provider-readable runtime ancestor before skeleton effects", () => {
    const f = withRegisteredSink(captured(), "/TEST-artifact/registry"), observed = observingHost();
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
    expect(observed.effects).toEqual([]);
  });
  it("refuses a nominally separate sink whose mount backing aliases provider-writable source", () => {
    const f = withRegisteredSink(captured(), "/TEST-project/registry"), observed = observingHost();
    const path = join(f.spec.request.jobRootDir, "durable-handoffs");
    observed.extraMounts.push(`50 1 8:1 ${path} ${f.sink} rw - ext4 /dev/TEST rw`);
    const spec: ResearchStartSpec = { ...f.spec, registeredHandoff: { ...f.spec.registeredHandoff!,
      durableDirectory: { ...f.spec.registeredHandoff!.durableDirectory, mountId: 50, mountPoint: f.sink, mountRoot: path } } };
    researchPublish(join(f.directory, "spec.json"), spec);
    researchPublish(join(f.directory, "providers", unit + ".json"), { schemaVersion: 1, unit, runtimeUnit: spec.unit,
      specSha256: researchHash(researchRead(join(f.directory, "spec.json"))), description: `subscription-runtime-research-provider:${spec.startId}:${unit}` });
    expect(() => prepareResearchProviderRoot(spec, unit, f.home, undefined, observed.adapter)).toThrow();
    expect(observed.effects).toEqual([]);
  });
  // Regression: Linux's deleted dentry ROOT is opaque, but an unrelated cache
  // mount must not prevent a plan. Dropping it would lose graph/reassert vetoes.
  it.each([
    "/jobs/TEST-foreign/.research/.cache/toolchain//deleted",
    "/jobs/TEST-foreign/.research/.cache/go-modcache//deleted",
    "/jobs/TEST\\040foreign/TEST\\011cache/TEST\\012line/TEST\\134name//deleted",
  ])("accepts unrelated native ext4 deleted ROOT %s with an assertable plan", root => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(deletedMount("/jobs/TEST-foreign/home/cache", root));
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    expect(plan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite).map(bind => bind.target))
      .toEqual([f.spec.request.jobRootDir, f.spec.request.workspacePath]);
    expect(fs.lstatSync(plan.fixedRootDirectory).isDirectory()).toBe(true);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each(["grant", "workspace", "job-pin", "workspace-pin", "pin-ancestor", "dependency", "ancestor"])(
    "rejects opaque deleted %s backing before effects", kind => {
      const f = captured(), observed = observingHost();
      const point = kind === "grant" ? f.spec.request.jobRootDir : kind === "workspace" ? f.spec.request.workspacePath :
        kind === "job-pin" ? join(f.directory, "pins/job") : kind === "workspace-pin" ? join(f.directory, "pins/workspace") :
        kind === "pin-ancestor" ? join(f.directory, "pins") : kind === "dependency" ? "/usr" : "/";
      observed.transform(table => table.split("\n").filter(line => line.split(" ")[0] === "900" || line.split(" ")[4] !== point).join("\n"));
      observed.extraMounts.push(deletedMount(point));
      // Rejection must happen before join() can erase the kernel marker, even
      // for a pin alias whose ordinary canonical ROOT is intentionally allowed.
      try { prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter); throw new Error("TEST expected denial"); }
      catch (error) { expect(researchProviderRootFailureCheck(error)).toBe(ResearchProviderRootCheck.Backing); }
      expectNoRootEffects(f, observed);
    });
  it.each(["dependency-child", "pin-child", "grant-child", "skeleton"])("retains opaque deleted %s vetoes before effects", kind => {
    const f = captured(), observed = observingHost();
    const point = kind === "dependency-child" ? "/usr/bin/TEST-deleted" : kind === "pin-child" ? join(f.directory, "pins/job/TEST-deleted") :
      kind === "grant-child" ? join(f.spec.request.jobRootDir, "TEST-deleted") : join(f.directory, "provider-roots", unit, "root/TEST-deleted");
    observed.extraMounts.push(deletedMount(point));
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it.each([
    ["relative//deleted", "ext4"], ["//deleted", "ext4"], ["///deleted", "ext4"],
    ["/jobs/TEST-foreign///deleted", "ext4"], ["/jobs/../TEST-foreign//deleted", "ext4"],
    ["/jobs/./TEST-foreign//deleted", "ext4"], ["/jobs//TEST-foreign//deleted", "ext4"],
    ["/jobs/TEST-foreign//deleted/child", "ext4"], ["/jobs/TEST-foreign//deleted//deleted", "ext4"],
    ["/jobs/TEST\\000foreign//deleted", "ext4"], ["/jobs/TEST\\041foreign//deleted", "ext4"],
    ["/jobs/TEST\u0000foreign//deleted", "ext4"], ["/jobs/TEST\tforeign//deleted", "ext4"],
    ["/jobs/TEST-foreign//deleted", "nsfs"], ["/jobs/TEST-foreign//deleted", "tmpfs"],
    ["net:[4026531840]//deleted", "ext4"],
  ])("rejects malformed or unsupported deleted ROOT %s (%s)", (root, filesystem) => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(deletedMount("/jobs/TEST-foreign/home/cache", root, filesystem));
    try { prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter); throw new Error("TEST expected denial"); }
    catch (error) { expect(researchProviderRootFailureCheck(error)).toBe(ResearchProviderRootCheck.MountTable); }
    expectNoRootEffects(f, observed);
  });
  it.each(["dependency", "grant-child", "skeleton"])("denies a newly relevant retained deleted %s without new effects", kind => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(deletedMount("/jobs/TEST-foreign/home/cache"));
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter), effects = [...observed.effects];
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    const point = kind === "dependency" ? "/usr" : kind === "grant-child" ? join(f.spec.request.jobRootDir, "TEST-deleted") : plan.fixedRootDirectory;
    observed.extraMounts[0] = deletedMount(point);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
    expect(observed.effects).toEqual(effects); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: unrelated native nsfs handles must not prevent preparation;
  // removing the rows instead would lose descendant and revalidation vetoes.
  it("accepts unrelated native namespace handles while retaining an assertable root", () => {
    const f = captured(), observed = observingHost();
    for (const [index, type] of ["cgroup", "ipc", "mnt", "net", "pid", "time", "user", "uts"].entries()) {
      observed.extraMounts.push(namespaceMount(`/run/docker/netns/TEST-${type}`, `${type}:[${4026531840 + index}]`).replace(/^900 /, `${900 + index} `));
    }
    observed.extraMounts.push(namespaceMount("/run/docker/netns/TEST-upper-bound", "net:[4294967295]", "0:1048575").replace(/^900 /, "908 "));
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    expect(plan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite).map(bind => bind.target))
      .toEqual([f.spec.request.jobRootDir, f.spec.request.workspacePath]);
    expect(fs.lstatSync(plan.fixedRootDirectory).isDirectory()).toBe(true);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each(["grant", "workspace", "job-pin", "workspace-pin", "dependency", "ancestor"])(
    "rejects namespace-handle %s backing before effects", kind => {
      const f = captured(), observed = observingHost();
      const point = kind === "grant" ? f.spec.request.jobRootDir : kind === "workspace" ? f.spec.request.workspacePath :
        kind === "job-pin" ? join(f.directory, "pins/job") : kind === "workspace-pin" ? join(f.directory, "pins/workspace") :
        kind === "dependency" ? "/usr" : "/";
      observed.transform(table => table.split("\n").filter(line => line.split(" ")[0] === "900" || line.split(" ")[4] !== point).join("\n"));
      observed.extraMounts.push(namespaceMount(point));
      // The row must reach backing(), which rejects it before path joining,
      // irrespective of the fixture's real leaf device/inode observations.
      try { prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter); throw new Error("TEST expected denial"); }
      catch (error) { expect(researchProviderRootFailureCheck(error)).toBe(ResearchProviderRootCheck.Backing); }
      expectNoRootEffects(f, observed);
    });
  it.each(["dependency-child", "pin-child", "grant-child", "skeleton"])("retains namespace %s vetoes before effects", kind => {
    const f = captured(), observed = observingHost();
    const point = kind === "dependency-child" ? "/usr/TEST-namespace" : kind === "pin-child" ? join(f.directory, "pins/job/TEST-namespace") :
      kind === "grant-child" ? join(f.spec.request.jobRootDir, "TEST-namespace") : join(f.directory, "provider-roots", unit, "root/TEST-namespace");
    observed.extraMounts.push(namespaceMount(point));
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  it.each([
    ["net:[4026531840]", "0:4", "ext4", "nsfs"], ["net:[4026531840]", "0:4", "nsfs", "/dev/TEST"],
    ["net:[4026531840]", "8:1", "nsfs", "nsfs"], ["net:[4026531840]", "0:0", "nsfs", "nsfs"],
    ["net:[4026531840]", "0:1048576", "nsfs", "nsfs"], ["net:[4026531840]", "0:04", "nsfs", "nsfs"],
    ["unknown:[4026531840]", "0:4", "nsfs", "nsfs"], ["pid_for_children:[4026531840]", "0:4", "nsfs", "nsfs"],
    ["net:[0]", "0:4", "nsfs", "nsfs"], ["net:[04026531840]", "0:4", "nsfs", "nsfs"],
    ["net:[4294967296]", "0:4", "nsfs", "nsfs"], ["net:[4026531840]/child", "0:4", "nsfs", "nsfs"],
    ["net:[-1]", "0:4", "nsfs", "nsfs"], ["relative/root", "0:4", "nsfs", "nsfs"],
  ])("rejects malformed or spoofed namespace ROOT %s (%s %s %s)", (root, device, filesystem, source) => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(namespaceMount("/run/docker/netns/TEST-unrelated", root, device, filesystem, source));
    try { prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter); throw new Error("TEST expected denial"); }
    catch (error) { expect(researchProviderRootFailureCheck(error)).toBe(ResearchProviderRootCheck.MountTable); }
    expectNoRootEffects(f, observed);
  });
  it.each(["dependency", "grant-child", "skeleton"])("denies a newly relevant retained namespace %s without new effects", kind => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push(namespaceMount("/run/docker/netns/TEST-unrelated"));
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter), effects = [...observed.effects];
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    const point = kind === "dependency" ? "/usr" : kind === "grant-child" ? join(f.spec.request.jobRootDir, "TEST-namespace") : plan.fixedRootDirectory;
    observed.extraMounts[0] = namespaceMount(point);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
    expect(observed.effects).toEqual(effects); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: an admitted writable equal, child or ancestor path would make
  // an immutable dependency writable or hide it, before systemd ordering helps.
  it.each([
    ["/usr", "/TEST-artifact", false], ["/usr/TEST-job", "/TEST-artifact", false],
    ["/etc", "/TEST-artifact", false], ["/etc/TEST-job", "/TEST-artifact", false],
    ["/TEST-artifact", "/TEST-artifact", false], ["/TEST-artifact/TEST-job", "/TEST-artifact", false],
    ["/TEST-project", "/TEST-project/immutable/runtime", false],
    ["/opt", "/TEST-artifact", true], ["/opt/codex", "/TEST-artifact", true], ["/opt/codex/TEST-job", "/TEST-artifact", true],
  ] as const)("denies writable %s against retained runtime %s", (job, runtime, external) => {
    const f = captured(job, runtime, external), observed = observingHost();
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow("hosted_research_launch_denied");
    expectNoRootEffects(f, observed);
  });
  // Regression: a distinct path can alias a protected filesystem subtree even
  // while its leaf inode passes the existing retained directory check.
  it.each(["/usr/TEST-backed-job", "/etc/TEST-backed-job", "/TEST-artifact/TEST-backed-job", "/opt/codex/TEST-backed-job"])(
    "denies an alternate RW backing subtree %s before all new effects", backing => {
      const f = captured(undefined, undefined, true), observed = observingHost(), job = f.spec.request.jobRootDir;
      observed.extraMounts.push(`900 1 8:1 ${backing} ${job} rw - ext4 /dev/TEST rw`);
      const pin = join(f.directory, "pins/job");
      observed.transform(table => table.replace(`${job} ${pin} rw`, `${backing} ${pin} rw`));
      expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
      expectNoRootEffects(f, observed);
    });
  it("denies displaced pin ancestry with the unchanged leaf identity", () => {
    const f = captured(), observed = observingHost(), pin = join(f.directory, "pins/job");
    const original = fs.lstatSync(pin);
    observed.transform(table => table.replace(`${f.spec.request.jobRootDir} ${pin} rw`, `/TEST-displaced ${pin} rw`));
    expect(fs.lstatSync(pin).ino).toBe(original.ino);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
    expectNoRootEffects(f, observed);
  });
  // Regression: accepting an unreviewed distro alias would expose a Host root.
  it("rejects a changed /lib alias before skeleton publication", () => {
    const f = captured(), observed = observingHost();
    fs.unlinkSync("/lib"); fs.symlinkSync("../../TEST-project", "/lib");
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
    expectNoRootEffects(f, observed);
  });
  it.each(["/bin", "/lib"])("denies an approved %s destination normalizing into /usr", alias => {
    const f = captured(), observed = observingHost(), original = f.spec.request.jobRootDir;
    // This fixture owner supplies the tuple directly, without relying on the
    // request issuer's separate symlink rejection to enforce adapter admission.
    const spec = { ...f.spec, request: { ...f.spec.request, jobRootDir: alias + "/TEST-job", promptPath: alias + "/TEST-job/prompt.md" },
      jobDirectory: { ...f.spec.jobDirectory, path: alias + "/TEST-job" } };
    researchPublish(join(f.directory, "spec.json"), spec);
    const reservationPath = join(f.directory, "providers", unit + ".json"), reservation = JSON.parse(researchRead(reservationPath).toString());
    researchPublish(reservationPath, { ...reservation, specSha256: researchHash(researchRead(join(f.directory, "spec.json"))) });
    observed.overrides.set(alias + "/TEST-job", fs.lstatSync(original));
    expect(() => prepareResearchProviderRoot(spec, unit, alias + "/TEST-job/home/TEST-a", undefined, observed.adapter)).toThrow();
    expectNoRootEffects(f, observed);
  });
  // Regression: recursive dependency imports could conceal a foreign child mount.
  it("rejects a foreign child mount of /usr without importing it", () => {
    const f = captured(), observed = observingHost();
    observed.extraMounts.push("900 1 0:44 / /usr/TEST-foreign rw - tmpfs tmpfs rw");
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
    expectNoRootEffects(f, observed);
  });
  it("preserves independently classified RO dependencies, exact RW destinations and skeleton custody", () => {
    const f = captured(), observed = observingHost(), plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    expect(plan.bindings.filter(b => b.access === ResearchRootMountAccess.ReadOnly).map(b => b.target)).toEqual([
      "/usr", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts", "/etc/gai.conf", "/etc/host.conf",
      "/etc/ssl/certs/ca-certificates.crt", "/etc/resolv.conf", "/TEST-artifact", ...(process.execPath.startsWith("/usr/") ? [] : [process.execPath]),
    ]);
    expect(plan.bindings.filter(b => b.access === ResearchRootMountAccess.ReadWrite).map(b => [b.source, b.target, ...b.identity])).toEqual([
      [join(f.directory, "pins/job"), f.spec.request.jobRootDir, f.spec.jobDirectory.device, f.spec.jobDirectory.inode],
      [join(f.directory, "pins/workspace"), f.spec.request.workspacePath, f.spec.workspaceDirectory.device, f.spec.workspaceDirectory.inode],
    ]);
    expect(fs.lstatSync(plan.fixedRootDirectory).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(join(plan.fixedRootDirectory, "lib"))).toBe("usr/lib");
    const launch = trustedResearchProviderLaunch(f.spec, unit, f.home, plan);
    expect(launch.args.slice(launch.args.indexOf("--") + 1, launch.args.indexOf("--") + 5)).toEqual(["/usr/bin/unshare", "--mount", "--propagation", "private"]);
    expect(launch.args).toContain("--property=DevicePolicy=closed");
    expect(launch.args).toContain("--property=SystemCallFilter=~@raw-io @module");
    expect(launch.args).toContain("--property=NoNewPrivileges=yes");
    expect(launch.args).toContain("--property=CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP");
    const namespaceProperties = /^(?:RootDirectory|RootImage|BindPaths|BindReadOnlyPaths|TemporaryFileSystem|MountFlags|MountAPIVFS|ProtectSystem|PrivateDevices|ProtectControlGroups|ProtectKernelModules|ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|PrivateTmp|PrivateMounts)=/;
    expect(launch.args.filter(arg => arg.startsWith("--property=")).some(arg => namespaceProperties.test(arg.slice("--property=".length)))).toBe(false);
    expect(launch.args.slice(-5, -2)).toEqual([f.spec.request.jobId, unit, f.home]);
    expect(fs.readdirSync(join(f.directory, "providers"))).toEqual([unit + ".json"]);
    expect(() => assertResearchProviderRoot({ ...plan }, f.spec, unit, f.home)).toThrow();
    expect(() => { (plan.bindings[0] as { source: string }).source = "/"; }).toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: a forged receipt or changed skeleton cannot authorize a later launch.
  it("predeclares an empty /root anchor without importing Host /root and rejects later contents", () => {
    const f = captured(), observed = observingHost(), plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    const anchor = join(plan.fixedRootDirectory, "root"), info = fs.lstatSync(anchor);
    expect(info.isDirectory()).toBe(true); expect(info.uid).toBe(0); expect(info.mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(anchor)).toEqual([]);
    expect(plan.bindings.some(bind => [bind.source, bind.target].some(path => path === "/root" || path.startsWith("/root/")))).toBe(false);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).not.toThrow();
    const foreign = join(anchor, "TEST-unexpected"); fs.writeFileSync(foreign, "TEST", { mode: 0o644 });
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow("hosted_research_launch_denied");
    fs.unlinkSync(foreign);
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).not.toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each(["record", "foreign-root", "writable-parent", "extra-entry", "mounted-root", "source-inode"])("rejects retained %s changes before submission", fault => {
    const f = captured(), observed = observingHost(), plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    if (fault === "record") researchPublish(join(dirname(plan.fixedRootDirectory), "plan.json"), { schemaVersion: 1 });
    if (fault === "foreign-root") observed.overrides.set(plan.fixedRootDirectory, Object.assign(Object.create(fs.lstatSync(plan.fixedRootDirectory)), { uid: 999 }));
    if (fault === "writable-parent") fs.chmodSync(local(dirname(plan.fixedRootDirectory)), 0o777);
    if (fault === "extra-entry") fs.writeFileSync(join(plan.fixedRootDirectory, "TEST-unexpected"), "TEST", { mode: 0o644 });
    if (fault === "mounted-root") observed.extraMounts.push(`900 1 8:1 / ${plan.fixedRootDirectory} rw - ext4 /dev/TEST rw`);
    if (fault === "source-inode") { const pin = join(f.directory, "pins/job"), original = fs.lstatSync(pin); observed.overrides.set(pin, Object.assign(Object.create(original), { ino: original.ino + 1 })); }
    expect(() => trustedResearchProviderLaunch(f.spec, unit, f.home, plan)).toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: intended workspace/scratch nesting must work, while a fourth or
  // replaced backing source cannot be admitted as an extra writable alias.
  it("retains workspace-in-job and exactly three prepared scratch identities", async () => {
    const f = captured(), workspace = join(f.spec.request.jobRootDir, "workspace");
    fs.mkdirSync(local(workspace), { recursive: true, mode: 0o700 }); host.pins.set(join(f.directory, "pins/workspace"), workspace);
    const info = fs.lstatSync(workspace), spec = { ...f.spec, request: { ...f.spec.request, workspacePath: workspace },
      workspaceDirectory: { path: workspace, device: info.dev, inode: info.ino } };
    researchPublish(join(f.directory, "spec.json"), spec);
    const path = join(f.directory, "providers", unit + ".json"), reservation = JSON.parse(researchRead(path).toString());
    researchPublish(path, { ...reservation, specSha256: researchHash(researchRead(join(f.directory, "spec.json"))) });
    const scratch = await preparedResearchScratch(spec.request.jobRootDir, f.home), observed = observingHost();
    const plan = prepareResearchProviderRoot(spec, unit, f.home, scratch.host, observed.adapter);
    expect(plan.bindings.filter(b => b.access === ResearchRootMountAccess.ReadWrite).map(b => b.target)).toEqual([
      spec.request.jobRootDir, workspace, join(spec.request.jobRootDir, "tmp"), join(f.home, "plugins/cache"), join(f.home, "cache/remote_plugin_catalog"),
    ]);
    for (const prepared of scratch.prepared) {
      const binding = plan.bindings.find(b => b.target === prepared.target)!;
      expect(binding.source).toBe(prepared.source); expect(binding.identity).toEqual([11, scratch.nodes.get(prepared.source)!.ino]);
    }
    scratch.mounts.set(scratch.prepared[0]!.target, { target: scratch.prepared[0]!.target, uuid: scratch.uuid, fsroot: "/TEST-foreign" });
    expect(() => assertResearchProviderRoot(plan, spec, unit, f.home)).toThrow();
    expect(host.spawn).not.toHaveBeenCalled();
  });
  it("denies an unprepared fourth RW child mount before creating any root", async () => {
    const f = captured(), scratch = await preparedResearchScratch(f.spec.request.jobRootDir, f.home), observed = observingHost();
    observed.extraMounts.push(`900 1 0:11 /TEST-extra ${f.spec.request.jobRootDir}/TEST-fourth rw - ext4 /dev/TEST-scratch rw`);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, scratch.host, observed.adapter)).toThrow();
    expectNoRootEffects(f, observed);
  });
  // Regression: the original 0-or-3 guard rejects supported mixed legacy leaves
  // even though the scratch adapter independently verifies every mounted leaf.
  it.each([1, 2])("preserves a supported subset of %s mounted scratch leaves", async count => {
    const f = captured(), scratch = await preparedResearchScratch(f.spec.request.jobRootDir, f.home), observed = observingHost();
    const legacyTemps: Record<string, { device: number; inode: number }> = {};
    for (const [index, { target }] of scratch.prepared.entries()) {
      if (index < count) continue;
      scratch.mounts.delete(target); host.scratchMounts.delete(target);
      const legacy = { ...scratch.nodes.get(target)!, dev: 2049, ino: 90000 + index };
      scratch.nodes.set(target, legacy); host.scratchNodes.set(target, legacy);
      legacyTemps[target] = { device: 2049, inode: 90000 + index };
    }
    scratch.setPolicy({ schemaVersion: 1, root: scratch.root, uuid: scratch.uuid, legacyTemps });
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, scratch.host, observed.adapter);
    const writable = plan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite);
    expect(writable.map(bind => bind.target)).toEqual([f.spec.request.jobRootDir, f.spec.request.workspacePath,
      f.spec.request.jobRootDir + "/tmp", ...(count === 2 ? [f.home + "/plugins/cache"] : [])]);
    expect(writable.slice(2).map(bind => [bind.source, ...bind.identity])).toEqual(scratch.prepared.slice(0, count)
      .map(({ source }) => [source, 11, scratch.nodes.get(source)!.ino]));
    expect(writable.some(bind => Object.hasOwn(legacyTemps, bind.target))).toBe(false);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: admitting subsets must not turn the fixed list into a mount bag.
  it.each(["duplicate", "extra"])("still denies an adapter-replaced %s target before root effects", async fault => {
    const f = captured(), scratch = await preparedResearchScratch(f.spec.request.jobRootDir, f.home), observed = observingHost();
    const target = fault === "duplicate" ? scratch.prepared[0]!.target : f.spec.request.jobRootDir + "/TEST-extra";
    vi.spyOn(scratchAdapter, "resolvePreparedHostScratchBinds").mockReturnValue([
      scratch.prepared[0]!, { source: scratch.prepared[1]!.source, target },
    ]);
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, scratch.host, observed.adapter)).toThrow();
    expectNoRootEffects(f, observed);
  });
  // Regression: importing Host /etc exposes unknown/private leaves through
  // native minimal reads. Only named immutable public snapshots may enter.
  it("constructs only the fixed public /etc closure and excludes a private TEST sentinel", () => {
    const f = captured(), observed = observingHost();
    fs.mkdirSync(local("/etc/TEST-private"), { mode: 0o700 });
    fs.writeFileSync("/etc/TEST-private/sentinel", "TEST private bytes", { mode: 0o600 });
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    expect(fs.readdirSync(join(plan.fixedRootDirectory, "etc")).sort()).toEqual([
      "gai.conf", "group", "host.conf", "hosts", "nsswitch.conf", "passwd", "resolv.conf", "ssl",
    ]);
    expect(fs.existsSync(join(plan.fixedRootDirectory, "etc/TEST-private"))).toBe(false);
    expect(plan.bindings.some(bind => bind.source === "/etc" || bind.target === "/etc" || bind.source.includes("TEST-private"))).toBe(false);
    const binding = plan.bindings.find(bind => bind.target === "/etc/passwd")!;
    expect(binding.source).toBe(join(f.directory, "provider-roots", unit, "public-passwd.snapshot"));
    expect(binding.access).toBe(ResearchRootMountAccess.ReadOnly);
    expect(fs.readFileSync(binding.source, "utf8")).toBe("root:x:0:0:root:/root:/bin/sh\n");
    expect(fs.lstatSync(binding.source).mode & 0o777).toBe(0o444);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: a public CA bundle normally exceeds the DNS reader ceiling.
  // This exercises closed CA-role routing and retained source/snapshot reads.
  it("retains a certificate-only bundle larger than DNS through the CA-role contract", () => {
    const f = captured(), observed = observingHost(), bytes = publicTestCa.repeat(94);
    expect(Buffer.byteLength(bytes)).toBeGreaterThan(65536);
    fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt", bytes, { mode: 0o644 });
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    const binding = plan.bindings.find(bind => bind.target === "/etc/ssl/certs/ca-certificates.crt")!;
    expect(binding.source).toBe(join(f.directory, "provider-roots", unit, "public-ca-certificates.crt.snapshot"));
    expect(fs.readFileSync(binding.source, "utf8")).toBe(bytes);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
  });
  it.each(["passwd-hash", "group-hash", "account-shape", "private-key", "opaque-tail", "extra-der", "non-ca", "bad-mode", "hardlink", "symlink", "backing"])(
    "denies invalid public /etc %s before effects, then accepts the restored same path", fault => {
      const f = captured(), observed = observingHost(), ca = "/etc/ssl/certs/ca-certificates.crt", passwd = "/etc/passwd", group = "/etc/group";
      const path = fault === "group-hash" ? group : ["private-key", "opaque-tail", "extra-der", "non-ca"].includes(fault) ? ca : passwd;
      const original = fs.readFileSync(path, "utf8");
      if (fault === "passwd-hash") fs.writeFileSync(path, "root:$6$TEST$hash:0:0:root:/root:/bin/sh\n");
      if (fault === "group-hash") fs.writeFileSync(path, "root:$6$TEST$hash:0:\n");
      if (fault === "account-shape") fs.writeFileSync(path, "root:x:0:0:missing-fields\n");
      if (fault === "private-key") fs.writeFileSync(path, publicTestCa + "-----BEGIN PRIVATE KEY-----\nVEVTVCBvbmx5\n-----END PRIVATE KEY-----\n");
      if (fault === "non-ca") fs.writeFileSync(path, publicTestLeaf);
      if (fault === "opaque-tail") fs.writeFileSync(path, publicTestCa + "TEST hidden tail\n");
      if (fault === "extra-der") {
        const encoded = publicTestCa.replace(/-----[^\n]+-----|\s/g, "");
        fs.writeFileSync(path, "-----BEGIN CERTIFICATE-----\n" + Buffer.concat([Buffer.from(encoded, "base64"), Buffer.from("TEST tail")]).toString("base64") + "\n-----END CERTIFICATE-----\n");
      }
      if (fault === "bad-mode") observed.overrides.set(path, Object.assign(Object.create(fs.lstatSync(path)), { mode: 0o100600 }));
      if (fault === "hardlink") observed.overrides.set(path, Object.assign(Object.create(fs.lstatSync(path)), { nlink: 2 }));
      if (fault === "symlink") { fs.unlinkSync(path); fs.symlinkSync("group", path); }
      if (fault === "backing") observed.extraMounts.push(`900 1 8:1 /TEST-foreign ${path} rw - ext4 /dev/TEST rw`);
      expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
      expectNoRootEffects(f, observed);
      observed.overrides.clear(); observed.extraMounts.length = 0;
      if (fault === "symlink") fs.unlinkSync(path);
      fs.writeFileSync(path, original, { mode: 0o644 });
      const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
      assertResearchProviderRoot(plan, f.spec, unit, f.home);
    });
  it.each(["source", "snapshot", "optional-appearance", "snapshot-mount"])(
    "invalidates the same public receipt after %s drift and accepts restoration", fault => {
      const f = captured(), observed = observingHost(), path = "/etc/hosts", original = fs.readFileSync(path, "utf8");
      if (fault === "optional-appearance") fs.unlinkSync("/etc/gai.conf");
      const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
      assertResearchProviderRoot(plan, f.spec, unit, f.home);
      const binding = plan.bindings.find(bind => bind.target === path)!;
      if (fault === "source") fs.writeFileSync(path, "192.0.2.1 TEST changed\n");
      if (fault === "snapshot") {
        fs.chmodSync(local(binding.source), 0o644); fs.writeFileSync(binding.source, "192.0.2.1 TEST changed\n"); fs.chmodSync(local(binding.source), 0o444);
      }
      if (fault === "optional-appearance") fs.writeFileSync("/etc/gai.conf", "# TEST appeared\n", { mode: 0o644 });
      if (fault === "snapshot-mount") observed.extraMounts.push(`900 1 8:1 /TEST-foreign ${binding.source} rw - ext4 /dev/TEST rw`);
      expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow();
      observed.extraMounts.length = 0;
      if (fault === "source") fs.writeFileSync(path, original);
      if (fault === "snapshot") {
        fs.chmodSync(local(binding.source), 0o644); fs.writeFileSync(binding.source, original); fs.chmodSync(local(binding.source), 0o444);
      }
      if (fault === "optional-appearance") fs.unlinkSync("/etc/gai.conf");
      assertResearchProviderRoot(plan, f.spec, unit, f.home);
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    });
  // Regression: binding a daemon-mutable DNS pathname could expose a Host
  // credential through a late symlink. Only retained public-byte snapshots enter.
  it("snapshots the fixed daemon-owned DNS leaf into root-owned read-only custody", () => {
    const f = captured(), observed = observingHost(), target = resolvedFixture(observed);
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter), binding = plan.bindings.find(b => b.target === target)!;
    expect(binding.source).toBe(join(f.directory, "provider-roots", unit, "resolver-stub-resolv.conf.snapshot"));
    expect(binding.access).toBe(ResearchRootMountAccess.ReadOnly);
    expect(fs.lstatSync(binding.source).uid).toBe(0); expect(fs.lstatSync(binding.source).mode & 0o777).toBe(0o444);
    expect(fs.readFileSync(binding.source, "utf8")).toBe("nameserver 192.0.2.1\n");
    expect(plan.bindings.some(b => b.source === "/run" || b.source === "/run/systemd/resolve")).toBe(false);
    expect(fs.lstatSync(join(plan.fixedRootDirectory, "run/systemd/resolve/stub-resolv.conf")).isFile()).toBe(true);
    expect(fs.readlinkSync(join(plan.fixedRootDirectory, "etc/resolv.conf"))).toBe("../run/systemd/resolve/stub-resolv.conf");
    expect(fs.realpathSync(join(plan.fixedRootDirectory, "etc/resolv.conf"))).toBe(local(join(plan.fixedRootDirectory, "run/systemd/resolve/stub-resolv.conf")));
    fs.writeFileSync(target, "nameserver 192.0.2.2\n", { mode: 0o644 });
    expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow();
    expect(fs.readFileSync(binding.source, "utf8")).toBe("nameserver 192.0.2.1\n");
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: resolved's native control sockets reject an otherwise valid
  // Host. They must remain absent from bindings and the confined filesystem.
  it("snapshots both DNS files while authenticating and omitting real resolved sockets", async () => {
    const f = captured(), observed = observingHost(), sockets = await resolvedSocketFixture(observed);
    try {
      for (const path of sockets.paths) expect(fs.lstatSync(path).isSocket()).toBe(true);
      const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
      expect(plan.bindings.filter(binding => binding.target.startsWith("/run/systemd/resolve/")).map(binding => binding.target)).toEqual([
        "/run/systemd/resolve/resolv.conf", "/run/systemd/resolve/stub-resolv.conf",
      ]);
      expect(fs.readdirSync(join(plan.fixedRootDirectory, "run/systemd/resolve")).sort()).toEqual(["resolv.conf", "stub-resolv.conf"]);
      expect(plan.bindings.some(binding => binding.source === "/run/systemd/resolve" || sockets.paths.some(path => binding.source === path || binding.target === path))).toBe(false);
      expect(observed.effects.some(effect => sockets.paths.some(path => effect.endsWith(path)))).toBe(false);
      assertResearchProviderRoot(plan, f.spec, unit, f.home);
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    } finally { await sockets.close(); }
  });
  it.each(["unknown-name", "wrong-owner", "wrong-group", "wrong-mode", "monitor-mode", "file", "symlink", "hardlink", "backing"])(
    "denies a known resolver socket with %s before root effects", async fault => {
      const f = captured(), observed = observingHost(), sockets = await resolvedSocketFixture(observed);
      try {
        const path = fault === "monitor-mode" ? sockets.paths[1] : sockets.paths[0];
        const original = observed.overrides.get(path)!;
        if (fault === "unknown-name") fs.writeFileSync("/run/systemd/resolve/io.systemd.Resolve.Unknown", "TEST", { mode: 0o644 });
        if (fault === "wrong-owner") observed.overrides.set(path, Object.assign(Object.create(original), { uid: 999 }));
        if (fault === "wrong-group") observed.overrides.set(path, Object.assign(Object.create(original), { gid: 999 }));
        if (fault === "wrong-mode" || fault === "monitor-mode") observed.overrides.set(path, Object.assign(Object.create(original), { mode: 0o140644 }));
        if (fault === "file") observed.overrides.set(path, Object.assign(Object.create(original), { mode: 0o100666 }));
        if (fault === "symlink") observed.overrides.set(path, Object.assign(Object.create(original), { mode: 0o120666 }));
        if (fault === "hardlink") observed.overrides.set(path, Object.assign(Object.create(original), { nlink: 2 }));
        if (fault === "backing") observed.extraMounts.push(`900 1 0:44 / ${path} rw - tmpfs tmpfs rw`);
        expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
        expectNoRootEffects(f, observed);
      } finally { await sockets.close(); }
    });
  it("invalidates retained socket omission after its inode changes", async () => {
    const f = captured(), observed = observingHost(), sockets = await resolvedSocketFixture(observed);
    try {
      const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter), path = sockets.paths[0];
      const original = observed.overrides.get(path)!;
      observed.overrides.set(path, Object.assign(Object.create(original), { ino: original.ino + 1 }));
      expect(() => assertResearchProviderRoot(plan, f.spec, unit, f.home)).toThrow();
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    } finally { await sockets.close(); }
  });
  // Regression: a replacement immediately after a checked stat must not
  // supply a fresh unchecked descriptor tuple, then fail only after effects.
  it.each(["public", "resolved"])("denies a physical %s replacement after its checked leaf observation before effects", kind => {
    const f = captured(), observed = observingHost(), path = kind === "resolved" ? resolvedFixture(observed) : "/etc/hosts";
    const originalInfo = observed.adapter.info, originalOverride = observed.overrides.get(path), saved = "/TEST-operator/TEST-" + kind + "-saved";
    let replaced = false;
    observed.adapter.info = current => {
      const checked = originalInfo(current);
      if (current === path && !replaced) {
        replaced = true; fs.renameSync(path, saved);
        fs.writeFileSync(path, kind === "resolved" ? "nameserver 192.0.2.99\n" : "192.0.2.99 TEST replacement\n", { mode: 0o644 });
        if (kind === "resolved") observed.overrides.set(path, Object.assign(Object.create(fs.lstatSync(path)), { uid: 999, gid: 992 }));
      }
      return checked;
    };
    expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
    expect(replaced).toBe(true); expectNoRootEffects(f, observed);
    fs.unlinkSync(path); fs.renameSync(saved, path); observed.adapter.info = originalInfo;
    if (originalOverride) observed.overrides.set(path, originalOverride); else observed.overrides.delete(path);
    const plan = prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter);
    assertResearchProviderRoot(plan, f.spec, unit, f.home);
    expect(plan.bindings.find(bind => bind.target === path)!.access).toBe(ResearchRootMountAccess.ReadOnly);
  });
  it.each(["unknown-leaf", "wrong-owner", "writable-file", "wrong-account", "oversize", "source-symlink", "unknown-resolver-alias"])(
    "denies unsupported resolver %s before any new root effect", fault => {
      const f = captured(), observed = observingHost(), target = resolvedFixture(observed);
      if (fault === "unknown-leaf") fs.writeFileSync("/run/systemd/resolve/TEST-socket-like", "TEST", { mode: 0o644 });
      if (fault === "wrong-owner") observed.overrides.set(target, Object.assign(Object.create(fs.lstatSync(target)), { uid: 999, gid: 992 }));
      if (fault === "writable-file") observed.overrides.set(target, Object.assign(Object.create(fs.lstatSync(target)), { uid: 992, gid: 992, mode: 0o100666 }));
      if (fault === "wrong-account") fs.writeFileSync("/etc/passwd", "systemd-resolve:x:991:991:Resolver:/:/usr/sbin/nologin\n", { mode: 0o644 });
      if (fault === "oversize") fs.writeFileSync(target, "x".repeat(65537), { mode: 0o644 });
      if (fault === "source-symlink") { observed.overrides.delete(target); fs.unlinkSync(target); fs.symlinkSync("/TEST-auth", target); }
      if (fault === "unknown-resolver-alias") { fs.unlinkSync("/etc/resolv.conf"); fs.symlinkSync("/TEST-auth/unknown", "/etc/resolv.conf"); }
      expect(() => prepareResearchProviderRoot(f.spec, unit, f.home, undefined, observed.adapter)).toThrow();
      expectNoRootEffects(f, observed);
    });
});
