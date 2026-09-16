import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes,
  withHostedActivationFence,
  type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedInstallationActivation, readHostedOrdinaryBirth } from "../hosted-installation-activation";

// Real disposable no-follow reads and mkdir contention. Only private root paths,
// root metadata and kernel namespace/boot facts are substituted. No authority,
// process factory or lock implementation is injected into production APIs.
const fixture = vi.hoisted(() => ({ root: "", boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  namespace: "host", uidMap: "0 0 4294967295\n", wrongOwner: false, drift: false, stats: 0 }));
const prefix = "/var/lib/subscription-runtime-host-policy";
function mapped(path: string): string {
  if (["/", "/var", "/var/lib", prefix].includes(path)) return fixture.root;
  if (path.startsWith(prefix + "/")) return join(fixture.root, path.slice(prefix.length + 1));
  return path;
}
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    readFileSync: (path: string, options: Parameters<typeof real.readFileSync>[1]) => {
      if (path === "/proc/self/uid_map") return fixture.uidMap;
      if (path === "/proc/sys/kernel/random/boot_id") return fixture.boot + "\n";
      return real.readFileSync(mapped(path), options);
    },
    readlinkSync: (path: string) => path.startsWith("/proc/self/ns/") ? fixture.namespace :
      path.startsWith("/proc/1/ns/") ? "host" : real.readlinkSync(mapped(path)),
    lstatSync: (path: string) => Object.assign(real.lstatSync(mapped(path)), { uid: fixture.wrongOwner ? 65532 : 0 }),
    fstatSync: (fd: number) => {
      const stat = real.fstatSync(fd);
      return Object.assign(stat, { uid: 0, ctimeMs: stat.ctimeMs + (fixture.drift && ++fixture.stats % 2 === 0 ? 1 : 0) });
    },
    openSync: (path: string, flags: number, mode: number) => real.openSync(mapped(path), flags, mode),
    mkdirSync: (path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(mapped(path), options),
    rmdirSync: (path: string) => real.rmdirSync(mapped(path)),
  };
});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = "a".repeat(64);
const birth = { schemaVersion: 1, installationId: "install-1", jobId: "job-1", jobRootDir: "/jobs/job-1",
  workspacePath: "/work/job-1", origin: "ordinary" };
const activation = { schemaVersion: 1, installationId: "install-1", hostId: "host-1", bootId: "boot-1",
  supervisorId: "supervisor-1", generation: 2, phase: "ORDINARY", ordinaryOriginsSha256: sha,
  exclusiveEnrollmentSha256: null, ordinaryStarts: [] };
function put(name: string, value: unknown): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) + "\n");
  writeFileSync(join(fixture.root, name), bytes, { mode: 0o600 });
  return bytes;
}
function read(name: string) { return JSON.parse(readFileSync(join(fixture.root, name), "utf8")); }
function seed() {
  for (const dir of ["ordinary-origins", "ordinary-starts", "codex-readonly-custody", "codex-readonly-revoked"]) {
    mkdirSync(join(fixture.root, dir), { mode: 0o700 });
  }
  put("host-installation.json", { schemaVersion: 1, installationId: "install-1", hostId: "host-1",
    runtimeDirectory: "/opt/runtime", runtimeSha: "a".repeat(40), runtimeManifestSha256: sha, inventorySha256: sha });
  const birthBytes = put("ordinary-origins/" + hash(Buffer.from(birth.jobId)) + ".json", birth);
  const catalog = put("ordinary-origins.json", { schemaVersion: 1, installationId: "install-1", revision: 1,
    origins: [{ jobId: birth.jobId, jobRootDir: birth.jobRootDir, workspacePath: birth.workspacePath, birthSha256: hash(birthBytes) }] });
  put("host-activation.json", { ...activation, ordinaryOriginsSha256: hash(catalog) });
}
function managed(jobId: string) {
  const value = { schemaVersion: 1, hostId: "host-1", bootId: "boot-1", supervisorId: "supervisor-1",
    generation: 1, requirement: "test_managed_qualification", phase: "closed", revoked: false,
    reservations: [], outerRuntime: null, identity: { jobId, jobRootDir: "/managed/job", workspacePath: "/managed/W",
      runtimeSha: "a".repeat(40), runtimeManifestSha256: sha, issuerDeploymentDigest: sha,
      policySha256: sha, reviewSha256: sha, stageSha256: sha, grantSha256: sha } };
  const bytes = put("readonly-enrollment.json", value);
  put("readonly-epoch.json", value);
  put("host-activation.json", { ...read("host-activation.json"), exclusiveEnrollmentSha256: hash(bytes) });
}
beforeEach(() => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  fixture.root = mkdtempSync(join(tmpdir(), "hosted-activation-"));
  fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fixture.namespace = "host"; fixture.uidMap = "0 0 4294967295\n";
  fixture.wrongOwner = false; fixture.drift = false; fixture.stats = 0; seed();
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("strict positive ordinary evidence", () => {
  it("reads an enrolled ordinary birth while keeping its proof distinct from admission", () => {
    const result = readHostedOrdinaryBirth("job-1");
    expect(result.birth).toEqual(birth);
    expect(result.originSha256).toBe(hash(Buffer.from(JSON.stringify(birth) + "\n")));
    expect(() => readHostedOrdinaryBirth("unknown-job")).toThrow();
  });
  it.each(["CLOSED", "ENTERING_EXCLUSIVE", "EXCLUSIVE", "LEAVING_EXCLUSIVE", "revoked"])(
    "cannot select ordinary from %s", phase => {
      put("host-activation.json", { ...read("host-activation.json"), phase });
      expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
    });
  it.each(["host-installation.json", "host-activation.json", "ordinary-origins.json"])(
    "missing %s cannot confer origin", name => {
      rmSync(join(fixture.root, name));
      expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
    });
  it.each(["host-activation.next", "ordinary-origins.next", "readonly-epoch.next"])(
    "retained %s requires recovery without deleting it", name => {
      put(name, Buffer.from("{"));
      expect(() => readHostedOrdinaryBirth("job-1")).toThrow("publication_recovery_required");
      expect(readFileSync(join(fixture.root, name), "utf8")).toBe("{");
    });
  it("retains managed priority despite a positive ordinary birth and no mutable grant", () => {
    managed("job-1");
    expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
    put("readonly-epoch.json", { ...read("readonly-epoch.json"), revoked: true });
    expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
  });
  it("permits distinct positive identities with complete closed managed history", () => {
    managed("managed-job");
    put("readonly-epoch.json", { ...read("readonly-epoch.json"), revoked: true });
    expect(readHostedOrdinaryBirth("job-1").birth).toEqual(birth);
  });
  it.each(["readonly-enrollment.json", "readonly-epoch.json"])("rejects deleted referenced %s", name => {
    managed("managed-job"); rmSync(join(fixture.root, name));
    expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
  });
  it.each(["codex-readonly-custody", "codex-readonly-revoked"])("retains partial %s as managed priority", dir => {
    put(dir + "/" + hash(Buffer.from(birth.jobId)) + ".json", Buffer.from("{"));
    expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
  });
  it("rejects changed birth/catalog bytes, installation and enrollment", () => {
    put("ordinary-origins/" + hash(Buffer.from(birth.jobId)) + ".json", { ...birth, workspacePath: "/other" });
    expect(() => readHostedOrdinaryBirth("job-1")).toThrow();
    put("host-activation.json", { ...read("host-activation.json"), installationId: "other" });
    expect(() => readHostedInstallationActivation()).toThrow();
  });
  it("rejects corrupt UTF-8 instead of replacing bytes", () => {
    expect(() => decodeHostedActivationBytes(Buffer.from([0x22, 0xff, 0x22]))).toThrow();
  });
});

describe("private reader and shared synchronous fence", () => {
  it("does not require or create a managed epoch to hold the common mutex", () => {
    let saved: HostedActivationFence | undefined;
    withHostedActivationFence(fence => {
      saved = fence;
      assertHostedActivationFence(fence);
      expect(() => withHostedActivationFence(() => {})).toThrow();
    });
    expect(() => assertHostedActivationFence(saved!)).toThrow();
    expect(() => assertHostedActivationFence({ held: true })).toThrow();
    expect(readHostedActivationBytes("readonly-epoch.json")).toBeNull();
    expect(() => withHostedActivationFence(() => {})).not.toThrow();
  });
  it("retains crashed boot mutex and unversioned lock evidence", () => {
    const lock = join(fixture.root, `readonly-epoch.${fixture.boot}.lock`);
    mkdirSync(lock, { mode: 0o700 });
    expect(() => withHostedActivationFence(() => {})).toThrow();
    fixture.boot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(() => withHostedActivationFence(() => {})).not.toThrow();
    expect(() => mkdirSync(lock)).toThrow();
    mkdirSync(join(fixture.root, "readonly-epoch.lock"), { mode: 0o700 });
    expect(() => withHostedActivationFence(() => {})).toThrow();
  });
  it("invalidates capability after thrown or asynchronous callback", () => {
    let saved: HostedActivationFence | undefined;
    expect(() => withHostedActivationFence(fence => { saved = fence; throw new Error("failed"); })).toThrow("failed");
    expect(() => assertHostedActivationFence(saved!)).toThrow();
    expect(() => withHostedActivationFence(fence => { saved = fence; return Promise.resolve(); })).toThrow("synchronous_fence_required");
    expect(() => assertHostedActivationFence(saved!)).toThrow();
  });
  it.each(["host-installation.json", "host-activation.json"])("rejects symlink and hardlinked %s", name => {
    const path = join(fixture.root, name), target = join(fixture.root, "target");
    writeFileSync(target, readFileSync(path), { mode: 0o600 }); rmSync(path); symlinkSync(target, path);
    expect(() => readHostedActivationBytes(name)).toThrow();
    rmSync(path); linkSync(target, path);
    expect(() => readHostedActivationBytes(name)).toThrow();
  });
  it("denies missing ancestry, public records, namespace root, drift and foreign owners", () => {
    chmodSync(join(fixture.root, "host-installation.json"), 0o644);
    expect(() => readHostedActivationBytes("host-installation.json")).toThrow();
    chmodSync(join(fixture.root, "host-installation.json"), 0o600);
    fixture.namespace = "worker";
    expect(() => withHostedActivationFence(() => {})).toThrow("host_operator_required");
    fixture.namespace = "host"; fixture.uidMap = "65532 0 1\n";
    expect(() => readHostedActivationBytes("host-installation.json")).toThrow("host_operator_required");
    fixture.uidMap = "0 0 4294967295\n"; fixture.wrongOwner = true;
    expect(() => withHostedActivationFence(() => {})).toThrow();
    fixture.wrongOwner = false; fixture.drift = true;
    expect(() => readHostedActivationBytes("host-installation.json")).toThrow();
    fixture.drift = false; rmSync(join(fixture.root, "ordinary-origins"), { recursive: true });
    expect(() => readHostedActivationBytes("ordinary-origins/" + sha + ".json")).toThrow();
    expect(() => readHostedActivationBytes("../host-installation.json")).toThrow();
  });
});
