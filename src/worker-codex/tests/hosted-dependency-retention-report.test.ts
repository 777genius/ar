import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { classifyHostedRetentionDependency, hostedRetentionActivity, HostedRetentionFactsStatus, HostedRetentionDiagnosticReason,
  HostedRetentionNominationState } from "../hosted-dependency-retention-facts";
import { parseHostedDependencyRetentionPolicy, parseHostedRetentionNativeEvidence, HostedRetentionPolicyReason,
  HostedRetentionNativeScope, HostedRetentionNativeEvidenceKind } from "../hosted-dependency-retention-policy";
import { LocalDependencyReceiptStore } from "../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { claimDependencyConsumer, markDependencyConsumerRunning } from "../../worker-core/dependency-environment/application/dependency-consumer-ownership";
import { DependencyInstallProofKind, DependencyPreservationKind, DependencyReceiptState,
  type DependencyReceipt } from "../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyRetentionFactState, DependencyRetentionHold } from "../../worker-core/dependency-environment/domain/dependency-retention-policy";
import { DependencyTreeAllocationBasis, DependencyManifestEntryKind } from "../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { parseDependencyOwner } from "../../core/dependency-environment/dependency-owner";
import { parseHostedDependencyBinding, hostedDependencyBindingName, hostedDependencyJobRoot,
  hostedDependencyOwnerRoot } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { withHostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";

// NEW private TEST files only. Initial-host /proc/systemd/UID facts are finite
// synthetic environment facts, not mocked permits: actual operator/fence,
// installed-origin resolver, history and owner stores execute unchanged.
// No native/G1 positive is inferred; the legacy profile cannot nominate.
const fixture = vi.hoisted(() => ({ root: "" }));
const policyRoot = "/var/lib/subscription-runtime-host-policy", volatile = "/run/user/0/subscription-runtime-host-policy";
const jobId = "TEST-readonly-retention", jobRoot = hostedDependencyJobRoot(jobId), workspace = jobRoot + "/workspace";
const installationId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const bootId = process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  : "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function local(path: string): string {
  for (const [prefix, dir] of [[policyRoot, "policy"], [volatile, "volatile"]] as const) {
    if (path === prefix || path.startsWith(prefix + "/")) return join(fixture.root, dir, path.slice(prefix.length));
  }
  if (["/", "/var", "/var/lib", "/run", "/run/user", "/run/user/0"].includes(path)) return fixture.root;
  return path;
}
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: Parameters<typeof real.lstatSync>[0], options?: { bigint?: boolean }) =>
      Object.assign(real.lstatSync(typeof path === "string" ? local(path) : path, options as { bigint: true }), { uid: options?.bigint ? 0n : 0 }),
    fstatSync: (fd: number, options?: { bigint?: boolean }) => Object.assign(real.fstatSync(fd, options as { bigint: true }), { uid: options?.bigint ? 0n : 0 }),
    realpathSync: (path: string, options?: Parameters<typeof real.realpathSync>[1]) => {
      const physical = local(path), result = real.realpathSync(physical, options);
      if (Buffer.isBuffer(result)) return result.equals(Buffer.from(physical)) ? Buffer.from(path) : result;
      return result === physical ? path : result;
    },
    readlinkSync: (path: string) => /^\/proc\/(?:self|1)\/ns\/(?:user|mnt|pid)$/.test(path) ? "TEST-initial-namespace" : real.readlinkSync(local(path)),
    readFileSync: (path: string | number, options?: Parameters<typeof real.readFileSync>[1]) => {
      if (path === "/proc/self/uid_map") return "0 0 4294967295\n";
      if (path === "/proc/self/cgroup") return "0::/system.slice/TEST-supervisor.service\n";
      if (path === "/proc/123/stat") return "123 (TEST supervisor) " + [...Array(19).fill("0"), "456"].join(" ");
      if (path === "/etc/machine-id") return "a".repeat(32);
      return real.readFileSync(typeof path === "string" ? local(path) : path, options);
    },
    openSync: (path: string, flags: number, mode?: number) => real.openSync(local(path), flags, mode),
    readdirSync: (path: Parameters<typeof real.readdirSync>[0], options: Parameters<typeof real.readdirSync>[1]) =>
      real.readdirSync(typeof path === "string" ? local(path) : path, options),
    mkdirSync: (path: string, options?: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), options),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
  };
});
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, open: (path: string, flags: Parameters<typeof real.open>[1], mode?: number) => real.open(local(path), flags, mode) };
});
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw new Error("TEST forbids runtime launch"); },
  spawnSync: (command: string, args: string[]) => {
    if (command !== "/usr/bin/systemctl" || args[0] !== "show" || args.at(-1) !== "TEST-supervisor.service")
      throw new Error("TEST forbids external effect");
    return { status: 0, stdout: "Id=TEST-supervisor.service\nFragmentPath=/etc/systemd/system/TEST-supervisor.service\nDropInPaths=\nControlGroup=/system.slice/TEST-supervisor.service\nMainPID=123\n" };
  },
}));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
const runtimeDirectory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
function put(name: string, value: unknown) { fs.writeFileSync(local(policyRoot + "/" + name), encode(value), { mode: 0o600 }); }
function identity(path: string) { const s = fs.lstatSync(local(path), { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; }
function binding() { return parseHostedDependencyBinding({ version: 1, jobId, jobRootDir: jobRoot,
  workspace: { canonicalPath: workspace, ...identity(workspace) }, installationId, runtimeSha: "c".repeat(40),
  grantDigest: hash(fs.readFileSync(local(volatile + "/codex-egress/" + hash(jobId) + ".json"))) }); }
function consumerLaunch(b: ReturnType<typeof binding>) {
  const startId = randomUUID(); return { installationId, bootId, runtimeSha: b.runtimeSha, grantDigest: b.grantDigest,
    startId, unit: `subscription-runtime-ordinary-${startId}.service` };
}
function owners() { return LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 }); }
function receipts() { return LocalDependencyReceiptStore.open({ rootPath: policyRoot + "/dependency-receipt-history", maxRecordBytes: 16384, maxHistorySteps: 2048 }); }
function preparedReady(withMeasurement = false): Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }> {
  const b = binding(), coverageRevision = hash(encode(b)), generation = randomUUID(), installKey = "d".repeat(64), tree = identity(workspace + "/node_modules");
  const base = { version: 1 as const, generation, workspace: b.workspace, coverageRevision };
  const installing: DependencyReceipt = { ...base, revision: 1, state: DependencyReceiptState.Installing, operationId: generation, requestedKey: installKey,
    preservation: { kind: DependencyPreservationKind.KnownFreshAbsence, generation, workspace: b.workspace,
      coverageRevision, operationId: generation, absenceEvidenceId: "e".repeat(64) } };
  const proof = { generation, workspace: b.workspace, coverageRevision, installKey, tree, manifestDigest: "f".repeat(64) };
  const directoryBytes = fs.lstatSync(local(workspace + "/node_modules"), { bigint: true }).blocks * 512n;
  const fileBytes = fs.lstatSync(local(workspace + "/node_modules/authored-TEST-file"), { bigint: true }).blocks * 512n;
  const ready: Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }> = { ...base, ...proof, revision: 2, state: DependencyReceiptState.Ready,
    ...(withMeasurement ? { treeMeasurement: { allocationBasis: DependencyTreeAllocationBasis.RetainedInodeBlocks512,
      allocatedBytesEstimate: String(directoryBytes + fileBytes), observedScanDurationMs: "0", allocationByKind: {
        [DependencyManifestEntryKind.Directory]: { inodeCount: "1", allocatedBytesEstimate: String(directoryBytes) },
        [DependencyManifestEntryKind.File]: { inodeCount: "1", allocatedBytesEstimate: String(fileBytes) },
        [DependencyManifestEntryKind.Symlink]: { inodeCount: "0", allocatedBytesEstimate: "0" } } } } : {}),
    provenance: { ...proof, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation, verificationEvidenceId: "1".repeat(64), installerDrainEvidenceId: "2".repeat(64) } };
  const store = receipts(); try { store.compareAndSwap(b.workspace, null, installing); store.compareAndSwap(b.workspace, 1, ready); } finally { store.close(); }
  return ready;
}
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(path: string, prefix: string) {
    for (const name of fs.readdirSync(path).sort()) {
      const child = join(path, name), key = prefix + "/" + name, info = fs.lstatSync(child);
      out[key] = info.isDirectory() ? "directory" : hash(fs.readFileSync(child));
      if (info.isDirectory()) walk(child, key);
    }
  }
  walk(fixture.root, ""); return out;
}
beforeEach(() => {
  if (process.platform !== "linux") return;
  fixture.root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "retention-report-TEST-")));
  vi.spyOn(process, "getuid").mockReturnValue(0); vi.spyOn(process, "geteuid").mockReturnValue(0);
  for (const directory of [policyRoot, volatile, volatile + "/codex-readonly", volatile + "/codex-egress", volatile + "/codex-readonly-stages",
    jobRoot, jobRoot + "/state/registry", jobRoot + "/output", workspace, workspace + "/.git", workspace + "/node_modules", hostedDependencyOwnerRoot,
    policyRoot + "/dependency-bindings", policyRoot + "/ordinary-origins", policyRoot + "/codex-readonly-custody",
    policyRoot + "/codex-readonly-revoked", policyRoot + "/dependency-receipt-history"])
    fs.mkdirSync(local(directory), { recursive: true, mode: 0o700 });
  fs.writeFileSync(local(workspace + "/node_modules/authored-TEST-file"), "original authored TEST bytes", { mode: 0o600 });
  fs.writeFileSync(local(workspace + "/dirty-source"), "preserved dirty TEST source", { mode: 0o600 });
  fs.writeFileSync(local(jobRoot + "/state/registry/record"), "preserved TEST durable state", { mode: 0o600 });
  fs.writeFileSync(local(jobRoot + "/output/result.json"), '{"status":"failed","TEST":true}', { mode: 0o600 });
  fs.writeFileSync(local(workspace + "/.git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n", { mode: 0o600 });
  const launch = { command: process.execPath, args: [runtimeDirectory + "/dist/worker-codex/codex-goal-cli.js", "run"], cwd: workspace };
  const inventory = { schemaVersion: 2, hostId: "a".repeat(32), supervisorUnit: "TEST-supervisor.service",
    units: [{ name: "TEST-supervisor.service", controlGroup: "/system.slice/TEST-supervisor.service", fragmentSha256: "e".repeat(64) }],
    ordinaryCreators: [{ creatorId: "TEST-creator", jobId, jobRootDir: jobRoot, workspacePath: workspace, launch }], disabledCreators: [], runtimeLaunch: launch };
  put("readonly-inventory.json", inventory);
  const installation = { schemaVersion: 1, installationId, hostId: inventory.hostId, runtimeDirectory, runtimeSha: "c".repeat(40),
    runtimeManifestSha256: "d".repeat(64), inventorySha256: hash(encode(inventory)) };
  put("host-installation.json", installation);
  fs.writeFileSync(local(volatile + "/codex-readonly-stages/" + hash(runtimeDirectory) + ".json"),
    encode({ schemaVersion: 1, runtimeDirectory, runtimeSha: installation.runtimeSha, runtimeManifestSha256: installation.runtimeManifestSha256 }), { mode: 0o600 });
  const birth = { schemaVersion: 1, installationId, jobId, jobRootDir: jobRoot, workspacePath: workspace, origin: "ordinary" };
  put("ordinary-origins/" + hash(jobId) + ".json", birth);
  const catalog = { schemaVersion: 1, installationId, revision: 1, origins: [{ jobId, jobRootDir: jobRoot, workspacePath: workspace, birthSha256: hash(encode(birth)) }] };
  put("ordinary-origins.json", catalog);
  put("host-activation.json", { schemaVersion: 1, installationId, hostId: inventory.hostId, bootId, supervisorId: "123:456", generation: 1,
    phase: "ORDINARY", ordinaryOriginsSha256: hash(encode(catalog)), exclusiveEnrollmentSha256: null, ordinaryStarts: [] });
  fs.writeFileSync(local(volatile + "/codex-egress/" + hash(jobId) + ".json"),
    encode({ schemaVersion: 1, jobId, jobRootDir: jobRoot, workspacePath: workspace, profileId: "codex-test-npm-qualification" }), { mode: 0o600 });
  const b = binding(); put(hostedDependencyBindingName(jobId), b);
  const store = owners(); try { store.compareAndSwap(b.workspace, null, { version: 2, workspace: b.workspace, revision: 1, epoch: 1, owner: null }); } finally { store.close(); }
});
afterEach(() => { vi.restoreAllMocks(); if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true }); fixture.root = ""; });

describe.skipIf(process.platform !== "linux")("actual read-only protected TEST history report", () => {
  // Red if report uses migrating readHostedDependencyReceipt, or missing
  // history creates entries/locks instead of returning a diagnostic Unknown.
  it("does not initialize or migrate missing committed history", async () => {
    const before = snapshot();
    expect(await new HostedInstallationActivationStore().reportDependencyRetention(jobId)).toEqual({
      status: HostedRetentionFactsStatus.Unknown, reason: HostedRetentionDiagnosticReason.HistoryUnresolved });
    expect(snapshot()).toEqual(before);
  });
  // A malformed real protected leaf is a diagnostic, never a permission or
  // a reason to rewrite the file into a default policy.
  it("keeps malformed protected policy diagnostic and preserves its bytes", async () => {
    preparedReady(); put("dependency-retention-policy.json", { version: 2, managedReadyRequired: true,
      evictionEnabled: true, qualification: { nativeQualified: true } });
    const before = snapshot(), result = await new HostedInstallationActivationStore().reportDependencyRetention(jobId);
    expect(result).toMatchObject({ status: HostedRetentionFactsStatus.Reported, nomination: HostedRetentionNominationState.DiagnosticOnly,
      diagnostics: [{ policy: { reason: HostedRetentionPolicyReason.Invalid } }], volumes: [] });
    expect(snapshot()).toEqual(before);
  });
  // Red if a genuine legacy Ready without measurement becomes zero allocation,
  // refreshes its receipt, or can nominate from a missing/v1 policy.
  it.each([false, true])("reports unmeasured Ready without changing names or bytes (legacy policy %s)", async legacy => {
    const ready = preparedReady(); if (legacy) put("dependency-retention-policy.json", { version: 1, managedReadyRequired: true, evictionEnabled: true });
    const before = snapshot(), result = await new HostedInstallationActivationStore().reportDependencyRetention(jobId);
    expect(result).toMatchObject({ status: HostedRetentionFactsStatus.Reported, nomination: HostedRetentionNominationState.DiagnosticOnly,
      diagnostics: [{ jobId, reason: HostedRetentionDiagnosticReason.Unmeasured, estimatedAllocatedBytes: null,
        policy: { reason: legacy ? HostedRetentionPolicyReason.Legacy : HostedRetentionPolicyReason.Missing } }], volumes: [] });
    const store = receipts(); try { expect(store.read(binding().workspace)).toEqual(ready); } finally { store.close(); }
    expect(snapshot()).toEqual(before);
  });
  // A real protected claim/Running CAS, not a mutable PID/mtime, is the hold.
  it("retains actual Running ownership and never expires it using activity time", async () => {
    preparedReady(); const b = binding(), store = owners();
    try {
      const attempt = claimDependencyConsumer(store, b.workspace, consumerLaunch(b), randomUUID());
      markDependencyConsumerRunning(store, b.workspace, attempt, "1");
    } finally { store.close(); }
    const before = snapshot(), result = await new HostedInstallationActivationStore().reportDependencyRetention(jobId);
    expect(result).toMatchObject({ status: HostedRetentionFactsStatus.Reported, diagnostics: [{ state: DependencyRetentionFactState.Active,
      holds: [DependencyRetentionHold.Consumer], estimatedAllocatedBytes: null }], volumes: [] });
    expect(snapshot()).toEqual(before);
  });
  // Red if the second actual fence fails to reread owner after asynchronous
  // parent open. A real CAS increments revision; no permit/owner mock is used.
  it("discards a real ownership change across the first awaited parent read", async () => {
    preparedReady(true); const b = binding(), before = snapshot(), original = asyncFs.open; let changed = false;
    vi.spyOn(asyncFs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await original(path, flags, mode);
      if (path === workspace && !changed) {
        changed = true;
        withHostedActivationFence(() => {
          const store = owners(); try { claimDependencyConsumer(store, b.workspace, consumerLaunch(b), randomUUID()); } finally { store.close(); }
        });
      }
      return handle;
    });
    expect(await new HostedInstallationActivationStore().reportDependencyRetention(jobId)).toEqual({
      status: HostedRetentionFactsStatus.Unknown, reason: HostedRetentionDiagnosticReason.Changed });
    expect(changed).toBe(true);
    const after = snapshot(), ownerName = `/policy/dependency-owners/${b.workspace.dev}-${b.workspace.ino}.json`;
    expect(after[ownerName]).not.toBe(before[ownerName]); delete after[ownerName]; delete before[ownerName];
    expect(after).toEqual(before);
  });
  // Red if first physical tree pin is delayed until after observation, or
  // equal content substitutes for Ready's old root identity. Preserve both roots.
  it("refuses same-content tree replacement and preserves all adversarially retained bytes", async () => {
    preparedReady(true); const original = asyncFs.open; let afterAttack: Record<string, string> | undefined;
    vi.spyOn(asyncFs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await original(path, flags, mode);
      if (path === workspace && !afterAttack) {
        await asyncFs.rename(local(workspace + "/node_modules"), local(workspace + "/old-TEST-tree"));
        await asyncFs.mkdir(local(workspace + "/node_modules"), { mode: 0o700 });
        await asyncFs.writeFile(local(workspace + "/node_modules/authored-TEST-file"), "original authored TEST bytes", { mode: 0o600 });
        afterAttack = snapshot();
      }
      return handle;
    });
    expect(await new HostedInstallationActivationStore().reportDependencyRetention(jobId)).toEqual({
      status: HostedRetentionFactsStatus.Unknown, reason: HostedRetentionDiagnosticReason.Changed });
    expect(afterAttack).toBeDefined(); expect(snapshot()).toEqual(afterAttack);
    expect(fs.readFileSync(local(workspace + "/old-TEST-tree/authored-TEST-file"), "utf8")).toBe("original authored TEST bytes");
  });
});

describe("closed diagnostic configuration and ranking, never native qualification", () => {
  // Red if malformed present metadata or a v2 field is silently dropped while
  // parsing legacy policy, or arbitrary evidence identity/path gains a fallback.
  it("rejects malformed/downgraded policy and exact unbound evidence labels", () => {
    const q = { installationId, runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64), inventorySha256: "c".repeat(64),
      bootId, finiteProfileSha256: "d".repeat(64), evidenceSha256: "e".repeat(64), evidenceDev: "0", evidenceIno: "1" };
    const v = { version: 2, managedReadyRequired: true, evictionEnabled: true, qualification: q };
    expect(parseHostedDependencyRetentionPolicy(v)).toEqual(v);
    for (const bad of [{ ...v, version: 1 }, { ...v, qualification: null }, { ...v, qualification: undefined },
      { ...v, qualification: { ...q, evidenceIno: "01" } }, { ...v, qualification: { ...q, path: "/outside" } },
      { ...v, managedReadyRequired: false }, { ...v, qualification: { ...q, nativeQualified: true } },
      Object.defineProperty({ ...v }, "hidden", { value: true }), { ...v, [Symbol("hidden")]: true }])
      expect(() => parseHostedDependencyRetentionPolicy(bad)).toThrow();
    const evidence = { version: 1, scope: HostedRetentionNativeScope.OrdinaryTestNpmV2, installationId, runtimeSha: q.runtimeSha,
      runtimeManifestSha256: q.runtimeManifestSha256, inventorySha256: q.inventorySha256, bootId,
      finiteProfileSha256: q.finiteProfileSha256, evidenceKind: HostedRetentionNativeEvidenceKind.WholeLifeG1Accepted, proofSha256: "f".repeat(64) };
    expect(parseHostedRetentionNativeEvidence(evidence)).toEqual(evidence);
    for (const bad of [{ ...evidence, proofSha256: undefined }, { ...evidence, scope: "any" }, { ...evidence, path: "/external" }])
      expect(() => parseHostedRetentionNativeEvidence(bad)).toThrow();
  });
  // Red if timestamp absence/future/rollback becomes fabricated recency or
  // classification alone grants QualifiedIdle from a caller-valid idle owner.
  it("keeps unknown clocks nullable and classification non-authoritative", () => {
    const workspaceFact = { canonicalPath: "/TEST-only", dev: "1", ino: "2" };
    const owner = parseDependencyOwner({ version: 2, workspace: workspaceFact, revision: 3, epoch: 2, owner: null,
      activity: { lastEntry: { epoch: 2, atMs: "200" }, lastRelease: { epoch: 2, atMs: "100" } } });
    expect(hostedRetentionActivity(owner, "300")).toEqual({ lastConsumerEntryAtMs: null, lastConsumerReleaseAtMs: null });
    expect(hostedRetentionActivity({ ...owner, activity: { lastEntry: { epoch: 2, atMs: "400" }, lastRelease: null } }, "300"))
      .toEqual({ lastConsumerEntryAtMs: null, lastConsumerReleaseAtMs: null });
    expect(classifyHostedRetentionDependency(owner, null).state).toBe(DependencyRetentionFactState.Unknown);
    expect(classifyHostedRetentionDependency(null, null).reason).toBe(HostedRetentionDiagnosticReason.OwnerUnresolved);
  });
});
