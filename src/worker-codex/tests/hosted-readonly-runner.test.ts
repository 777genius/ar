import "./unmanaged-goal-host-fixture";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { codexAuthJsonForAccount, StaticRunner } from "./file-backend-codex-worker-test-support";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { HostedCustodyPhase, HostedCustodyRequirement, parseHostedCustodyEpoch, type HostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { completionPath } from "../hosted-readonly-host-kernel";
import { parseHostedReadonlyPolicy } from "../hosted-readonly-inputs";

const runtimeDirectory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const inventoryBytes = () => Buffer.from(JSON.stringify({ schemaVersion: 2, hostId: facts.epoch!.hostId, ordinaryCreators: [] }));

// Synthetic authority at filesystem/custody boundaries. Admission, runner,
// safe executor, account factories, egress wrapper and node adapter are real.
// No systemd/provider process, enrolled authority or credential read occurs.
const facts = vi.hoisted(() => ({
  policy: vi.fn(), bytes: vi.fn(), grant: vi.fn(), grantFile: vi.fn(), review: vi.fn(),
  epoch: null as HostedCustodyEpoch | null, activationPhase: "EXCLUSIVE", records: new Map<string, Buffer>(),
  snapshot: vi.fn(), reserve: vi.fn(), spawn: vi.fn(), stop: vi.fn(),
}));
vi.mock("@vioxen/subscription-runtime/provider-codex", async original => ({
  ...await original<typeof import("@vioxen/subscription-runtime/provider-codex")>(),
  readHostedActivationBytes: (name: string) => {
    const epoch = facts.epoch!;
    const birth = Buffer.from(JSON.stringify({ ...epoch, generation: 1, phase: "closed", revoked: false, reservations: [], outerRuntime: null }));
    if (name === "readonly-enrollment.json") return birth;
    if (name === "readonly-epoch.json") return Buffer.from(JSON.stringify(epoch));
    if (name === "host-installation.json") return Buffer.from(JSON.stringify({ schemaVersion: 1, installationId: "install",
      hostId: epoch.hostId, runtimeDirectory, runtimeSha: epoch.identity.runtimeSha,
      runtimeManifestSha256: epoch.identity.runtimeManifestSha256, inventorySha256: hash(inventoryBytes()) }));
    if (name === "host-activation.json") return facts.activationPhase === "missing" ? null : Buffer.from(JSON.stringify({ schemaVersion: 1, installationId: "install", hostId: epoch.hostId,
      bootId: epoch.bootId, supervisorId: epoch.supervisorId, generation: 1, phase: facts.activationPhase,
      ordinaryOriginsSha256: "a".repeat(64), ordinaryStarts: [], exclusiveEnrollmentSha256: createHash("sha256").update(birth).digest("hex") }));
    if (["host-activation.next", "ordinary-origins.next", "readonly-epoch.next"].includes(name)) return null;
    throw new Error("unexpected private activation record");
  },
}));
vi.mock("../hosted-test-egress-files", () => ({
  hostedTestEgressGrantRoot: "/run/user/0/subscription-runtime-host-policy/codex-egress",
  readHostedTestEgressGrantFile: facts.grantFile, assertHostedTestEgressOperator: vi.fn(),
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedReadonlyPolicy: facts.policy, readHostedPrivateBytes: facts.bytes,
}));
vi.mock("../hosted-readonly-authority", async original => ({
  ...await original<typeof import("../hosted-readonly-authority")>(),
  assertReadonlyHostOperator: vi.fn(), readReadonlyManagedGrant: facts.grant,
  readReadonlyReview: facts.review,
}));
vi.mock("../hosted-readonly-custody", async original => ({
  ...await original<typeof import("../hosted-readonly-custody")>(),
  readonlyCustodySnapshot: facts.snapshot, createReadonlyPrivateRecord: facts.reserve,
  withReadonlyCustodyLock: <T>(_job: string, action: () => T) => action(),
}));
// Real host composition and domain transitions; only storage and live OS
// inventory/session facts are synthetic. No runtime authority can be injected.
vi.mock("../hosted-readonly-epoch-store", () => ({
  HostedReadonlyEpochStore: class {
    serialized<T>(action: () => T): T { return action(); }
    readEpoch() { return parseHostedCustodyEpoch(facts.epoch); }
    publishEpoch(epoch: HostedCustodyEpoch) { facts.epoch = parseHostedCustodyEpoch(epoch); }
  },
}));
vi.mock("../hosted-readonly-host-kernel", async original => ({
  ...await original<typeof import("../hosted-readonly-host-kernel")>(),
  readHostedReadonlyHostInventory: () => JSON.parse(inventoryBytes().toString()),
  HostedReadonlyHostKernel: class {
    session() { return { hostId: "synthetic-host", bootId: "synthetic-boot", supervisorId: "synthetic-supervisor" }; }
    verifyRuntimeOwner() {} // Explicit synthetic outer ownership.
    verifyExclusiveInventory() {}
    verifyDescriptorBoundary() {}
    fenceCreator(reservation: { startId: string; unit: string; creatorId: string }) {
      if (!facts.records.has(completionPath(reservation))) throw new Error("creator_not_fenced");
    }
    drainQueuedStart() {}
    confirmTerminalDescendants() {}
  },
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: facts.spawn, spawnSync: facts.stop,
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it.each(["none", "revoked", "CLOSED", "ORDINARY", "missing"])("rechecks real admission and activation on account rotation: %s", async fault => {
  const revoke = fault !== "none";
  facts.activationPhase = "EXCLUSIVE";
  vi.spyOn(process, "getuid").mockReturnValue(0);
  const root = await mkdtemp(join(tmpdir(), "readonly-runner-"));
  const config = { jobId: "readonly-rotation", taskId: "readonly-rotation", jobRootDir: join(root, "job"),
    workspacePath: join(root, "workspace"), promptPath: join(root, "prompt"),
    authRootDir: join(root, "unused-synthetic-auth"), accounts: codexGoalAccountSlots(["fake-a", "fake-b"]),
    maxAccountCycles: 1, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
  };
  const policy = parseHostedReadonlyPolicy({ schemaVersion: 1, jobId: config.jobId,
    jobRootDir: config.jobRootDir, workspacePath: config.workspacePath,
    runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64), issuerDeploymentDigest: "c".repeat(64),
    readonlyPaths: [config.workspacePath + "/input"],
  });
  const bytes = Buffer.from(JSON.stringify(policy) + "\n");
  const reviewBytes = Buffer.from("synthetic reviewed projection"), stageBytes = Buffer.from("synthetic stage");
  const lease = Buffer.from(JSON.stringify({ schemaVersion: 1, jobId: config.jobId,
    policySha256: hash(bytes), reviewSha256: hash(reviewBytes), stageSha256: hash(stageBytes), snapshot: "synthetic-inodes" }));
  const grant = { schemaVersion: 1, jobId: config.jobId, jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath, profileId: CodexProviderEgressProfileId.TestManagedQualification };
  facts.records.clear();
  facts.epoch = parseHostedCustodyEpoch({ schemaVersion: 1,
    hostId: "synthetic-host", bootId: "synthetic-boot", supervisorId: "synthetic-supervisor",
    outerRuntime: null, generation: 1, requirement: HostedCustodyRequirement.TestManagedQualification,
    phase: HostedCustodyPhase.Ready, revoked: false, reservations: [],
    identity: { jobId: policy.jobId, jobRootDir: policy.jobRootDir, workspacePath: policy.workspacePath,
      runtimeSha: policy.runtimeSha, runtimeManifestSha256: policy.runtimeManifestSha256,
      issuerDeploymentDigest: policy.issuerDeploymentDigest, policySha256: hash(bytes),
      reviewSha256: hash(reviewBytes), stageSha256: hash(stageBytes), grantSha256: hash(Buffer.from(JSON.stringify(grant))) },
  });
  facts.reserve.mockImplementation((path: string, bytes: Buffer) => facts.records.set(path, bytes));
  const serviceRecords = () => facts.reserve.mock.calls.filter(([path]) => path.includes("codex-readonly-services/"));
  let revoked = false;
  facts.policy.mockReturnValue({ policy, bytes });
  facts.bytes.mockImplementation((path: string) => {
    if (path === "/var/lib/subscription-runtime-host-policy/readonly-inventory.json") return inventoryBytes();
    if (path === "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + hash(Buffer.from(runtimeDirectory)) + ".json") {
      return Buffer.from(JSON.stringify({ schemaVersion: 1, runtimeDirectory,
        runtimeSha: policy.runtimeSha, runtimeManifestSha256: policy.runtimeManifestSha256 }));
    }
    return path.includes("codex-readonly-custody/") ? lease :
      path.includes("codex-readonly-revoked/") && revoked ? Buffer.from("revoked") : null;
  });
  facts.grantFile.mockResolvedValue(grant);
  facts.grant.mockReturnValue(Buffer.from(JSON.stringify(grant)));
  facts.review.mockReturnValue({ reviewBytes, stageBytes });
  facts.snapshot.mockReturnValue("synthetic-inodes");
  const fakes = [new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "You've hit your usage limit",
    onRequest: request => {
      if (request.method === "turn/start") {
        if (fault === "revoked") revoked = true;
        else if (fault !== "none") facts.activationPhase = fault;
      }
    } }), new FakeAppServerFactory()];
  const frames: { env: Record<string, string>; args: string[] }[] = [];
  const units: string[] = [];
  facts.spawn.mockImplementation((command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    expect(command).toBe(process.execPath);
    expect(serviceRecords()).toHaveLength(frames.length + 1);
    expect(args.slice(0, 2)).toEqual(["/opt/subscription-runtime/managed-launcher/launch.mjs", "provider"]);
    const request = JSON.parse(args[2]!);
    expect(request).toMatchObject({ operation: "provider", jobId: config.jobId, readonlyPaths: policy.readonlyPaths });
    expect(request).not.toHaveProperty("cwd");
    expect(request).not.toHaveProperty("mounts");
    units.push(request.unit);
    const child = fakes[frames.length]!.create({ ...options, args });
    // This fixture models the systemd-run proxy, not a directly killed provider.
    // A service cleanly stopped by the synthetic manager acknowledges --wait
    // with code 0; a genuinely signaled proxy must retain its reservation.
    const emit = child.emit.bind(child);
    child.emit = (event: string | symbol, ...values: unknown[]) => event === "exit"
      ? emit(event, 0, null) : emit(event, ...values);
    const write = child.stdin.write;
    let bootstrap = true;
    child.stdin.write = chunk => {
      if (bootstrap) { frames.push(JSON.parse(String(chunk))); bootstrap = false; return true; }
      return write(chunk);
    };
    return child;
  });
  facts.stop.mockImplementation(() => {
    for (const fake of fakes) for (const child of fake.processes) child.kill();
    return { status: 0 };
  });
  const clock = { now: () => new Date("2026-05-31T00:05:00.000Z"), monotonicMs: () => performance.now() };
  try {
    await mkdir(config.jobRootDir); await mkdir(config.workspacePath); await writeFile(config.promptPath, "Offline rotation");
    const result = await runCodexGoal(config, { createExecutor: options => {
      expect(options.accounts[0]!.worker.appServerProcessFactory).toBe(options.accounts[1]!.worker.appServerProcessFactory);
      expect(options.accounts[0]!.worker.appServerProcessFactory).toBeTypeOf("function");
      return new FileBackendCodexSafeExecutor({ ...options, requireGitWorkspace: false, prewarmOnStart: false, clock,
        accounts: options.accounts.map((account, index) => ({
          codexAuthJson: codexAuthJsonForAccount(`synthetic-refresh-${index}`, `synthetic-account-${index}`),
          worker: { ...account.worker, clock, warmupPrompt: false,
            runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }) },
        })),
      });
    } });
    expect(result.attempts[0]?.failureReason).toBe("quota_limited");
    expect(facts.spawn).toHaveBeenCalledTimes(revoke ? 1 : 2);
    expect(serviceRecords()).toHaveLength(revoke ? 1 : 2);
    expect(facts.policy.mock.calls.length).toBeGreaterThanOrEqual(3); // admission and both attempted spawns
    if (revoke) expect(result.status).not.toBe("completed");
    else {
      expect(result.status).toBe("completed");
      expect(new Set(frames.map(frame => frame.env.CODEX_HOME)).size).toBe(2);
      expect(new Set(units).size).toBe(2);
      expect(facts.grant.mock.calls.length).toBeGreaterThanOrEqual(3);
    }
    for (const frame of frames) {
      expect(frame.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE).toBe(grant.profileId);
      expect(frame.args.join(" ")).toContain("registry.npmjs.org");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
