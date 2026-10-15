import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOrdinaryInstallationSupervisor, type OrdinaryInstallationPacket } from "../hosted-ordinary-installation-bootstrap";
import { DependencyToolTransformCache } from "../../core/dependency-environment/dependency-tool-profile";

// Source choreography regression only. Kernel/census/store boundaries below are
// substituted; this does not certify a real installation, grant or provider.
const f = vi.hoisted(() => ({ bytes: Buffer.alloc(0), calls: [] as string[], phase: "", grant: vi.fn(),
  packet: undefined as OrdinaryInstallationPacket | undefined }));
const id = "9fd9ed9e-bea6-4c42-bf27-dc1cd91ee5e6", boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const pinBytes = Buffer.from("Public Source fixture."), digest = createHash("sha256").update(pinBytes).digest("hex");
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: (p: string) => { if (p === "/etc/machine-id") return "a".repeat(32); throw new Error("unexpected_read"); },
  readlinkSync: () => "socket:[123]" }));
vi.mock("@vioxen/subscription-runtime/provider-codex", async original => ({
  ...await original<typeof import("@vioxen/subscription-runtime/provider-codex")>(),
  assertHostedActivationOperator: vi.fn(), verifySystemBusInfrastructure: vi.fn() }));
vi.mock("@vioxen/subscription-runtime/core", async original => ({
  ...await original<typeof import("@vioxen/subscription-runtime/core")>(),
  readSystemBusInfrastructureField: () => ({}), readFdCollectorProfileField: () => ({}) }));
vi.mock("../../core/host-infrastructure/host-inventory", async original => ({
  ...await original<typeof import("../../core/host-infrastructure/host-inventory")>(), parseHostedInventoryV5: (v: unknown) => v }));
vi.mock("../hosted-readonly-host-kernel", async original => ({ ...await original<typeof import("../hosted-readonly-host-kernel")>(), readTrustedFragment: () => Buffer.from("Public Source fixture.") }));
vi.mock("../stored-start-planning", async original => ({ ...await original<typeof import("../stored-start-planning")>(), resolveStoredProjectStartPlan: () => ({
  jobId: f.packet!.creator.jobId, jobRoot: f.packet!.creator.jobRootDir, workspace: f.packet!.creator.workspacePath }) }));
vi.mock("../hosted-readonly-inputs", async original => ({ ...await original<typeof import("../hosted-readonly-inputs")>(), readHostedPrivateBytes: (p: string) => {
  if (p.includes("codex-readonly-stages/")) return Buffer.from(JSON.stringify({ schemaVersion: 1,
    runtimeDirectory: f.packet!.runtimeDirectory, runtimeSha: f.packet!.runtimeSha, runtimeManifestSha256: f.packet!.runtimeManifestSha256 }));
  if (p.endsWith("launcher-consumed.json")) return Buffer.from(createHash("sha256").update(f.bytes).digest("hex") + "\n");
  if (p.endsWith("fd-collector-profile.v1.json")) return Buffer.from("Public Source fixture.");
  return f.bytes;
} }));
vi.mock("../hosted-readonly-linux-collector", async original => ({
  ...await original<typeof import("../hosted-readonly-linux-collector")>(),
  collectBootId: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", collectProcessBirth: () => "100:200",
  collectUnitShow: () => ({ MainPID: String(process.pid), Id: `subscription-runtime-installation-${f.packet!.operationId}.service`,
    ControlGroup: `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-installation-${f.packet!.operationId}.service` }),
  collectSelfCgroup: () => `0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-installation-${f.packet!.operationId}.service`,
  collectUnitInvocation: () => "a".repeat(32), withScopedCollectionBudget: (_: number, action: () => unknown) => action() }));
vi.mock("../../provider-codex/app-server/adapters/hosted-fd-observation", async original => ({ ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-fd-observation")>(),
  verifyPinnedFdCollectorProfile: () => ({ bootstraps: [f.packet!.copiedLauncher, f.packet!.copiedCodec,
    { path: "/opt/subscription-runtime/managed-launcher/hosted-host-policy.mjs", sha256: f.packet!.node.sha256 }] }),
  observeHostedFdProcess: () => ({ exe: process.execPath, argv: [process.execPath, f.packet!.bootstrap.path, "--operation", f.packet!.operationId] }) }));
vi.mock("../hosted-readonly-custody", async original => ({ ...await original<typeof import("../hosted-readonly-custody")>(), readonlySupervisorRoot: "/var/lib/subscription-runtime-host-policy",
  createReadonlyPrivateRecord: vi.fn(), publishReadonlyInventory: vi.fn() }));
vi.mock("../hosted-ordinary-installation-census", async original => ({ ...await original<typeof import("../hosted-ordinary-installation-census")>(),
  ordinaryInstallationCollectorFailure: () => undefined, collectOrdinaryInstallationDraft: () => ({ schemaVersion: 5 }) }));
vi.mock("../hosted-ordinary-installation-owned", async original => ({
  ...await original<typeof import("../hosted-ordinary-installation-owned")>(), assertOrdinaryInstallationOriginalClose: vi.fn() }));
vi.mock("../hosted-installation-activation", async original => ({
  ...await original<typeof import("../hosted-installation-activation")>(), HostedInstallationActivationStore: class {
    install() { f.calls.push("install"); f.phase = "CLOSED"; }
    enrollOrdinary() { f.calls.push("enroll"); f.phase = "ENROLLED"; }
    resumeOrdinary() { f.calls.push("resume"); }
    finishClosed() { f.calls.push("finish"); return { phase: "CLOSED", generation: 1 }; }
    closeOrdinaryRuntimeLaunch() { f.calls.push("close"); }
  } }));
vi.mock("../hosted-test-egress-files", async original => ({ ...await original<typeof import("../hosted-test-egress-files")>(), writeHostedTestEgressGrant: f.grant }));
vi.mock("../hosted-readonly-foreground", async original => ({ ...await original<typeof import("../hosted-readonly-foreground")>(), runHostedRuntimeForeground: async () => { f.calls.push("foreground"); return 0; } }));

const tools = { testFiles: ["sdk.test.ts"], optimizerDependencies: ["local-dependency"], transformCache: DependencyToolTransformCache.Persisted };
beforeEach(() => {
  f.calls = []; f.phase = ""; f.grant.mockReset();
  const now = Date.now(), runtime = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
  const jr = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-sdk-order";
  f.packet = { schemaVersion: 1, operationId: id, hostId: "a".repeat(32), bootId: boot, issuedEpochMs: now,
    issuedMonotonicNs: process.hrtime.bigint().toString(), workEndEpochMs: now + 150000, cleanupEndEpochMs: now + 175000,
    runtimeDirectory: runtime, runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
    node: { path: process.execPath, sha256: digest }, bootstrap: { path: fileURLToPath(new URL("../hosted-ordinary-installation-bootstrap.js", import.meta.url)), sha256: digest },
    creator: { creatorId: "TEST-sdk-order", jobId: "TEST-sdk-order", jobRootDir: jr, workspacePath: jr + "/workspace",
      launch: { command: process.execPath, args: [runtime + "/dist/worker-codex/codex-goal-cli.js", "tool", "codex_goal_project_start", "--args-json", "{}", "--json"], cwd: jr + "/workspace" } },
    testTools: tools, collectorProfile: { path: "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json", sha256: digest }, systemBusInfrastructure: {},
    copiedLauncher: { path: "/opt/subscription-runtime/managed-launcher/launch.mjs", sha256: digest },
    copiedCodec: { path: "/opt/subscription-runtime/managed-launcher/host-inventory-codec.cjs", sha256: digest } };
  f.bytes = Buffer.from(JSON.stringify({ ...f.packet, schemaVersion: 2, qualificationRequestSha256: "a".repeat(64),
    candidate: {}, preparedFixture: {}, copiedCohort: {}, preparedCollectorProfile: f.packet!.collectorProfile, priorCollectorProfile: {} }));
});
describe("original supervisor TEST tools ordering", () => {
  it("awaits the original grant while CLOSED before enrollment and preserves its launch tuple", async () => {
    f.grant.mockImplementation(async () => { expect(f.phase).toBe("CLOSED"); f.calls.push("grant");
      await Promise.resolve(); expect(f.calls).toEqual(["install", "grant"]); });
    await expect(runOrdinaryInstallationSupervisor(id)).resolves.toBe(0);
    expect(f.calls).toEqual(["install", "grant", "enroll", "resume", "foreground", "finish"]);
    expect(f.grant).toHaveBeenCalledWith({ schemaVersion: 1, jobId: f.packet!.creator.jobId,
      jobRootDir: f.packet!.creator.jobRootDir, workspacePath: f.packet!.creator.workspacePath, profileId: "codex-test-npm-qualification" }, tools);
  });
  it("keeps a rejected grant held and never enrolls or starts the creator", async () => {
    f.grant.mockRejectedValue(new Error("original_grant_rejected"));
    await expect(runOrdinaryInstallationSupervisor(id)).rejects.toThrow("original_grant_rejected");
    expect(f.calls).toEqual(["install", "close"]);
  });
});
