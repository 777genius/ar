import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimDependencyConsumer, fenceDependencyConsumer, isDependencyConsumerOwner,
  DependencyAdmissionError, DependencyAdmissionFailure, DependencyOwnerPhase,
  type DependencyAttempt, type DependencyLaunchBinding, type DependencyReceipt,
} from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../../store-local-file/dependency-environment/local-dependency-receipt-store";
import type { HostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyAttempt, type HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { materializeHostedDependencyAbsence } from "../hosted-dependency-materialization";
import { HostedDependencyInstaller } from "../hosted-dependency-installer";
import { HostedDependencyInstallerRevision, type HostedDependencyInstallerProfile } from "../hosted-dependency-installer-recipe";
import { dependencyCoverageRevision, publishHostedDependencyReceipt } from "../hosted-dependency-receipts";

const fixture = vi.hoisted(() => ({
  fence: Object.freeze({ held: true as const }),
  ownerStore: undefined as LocalDependencyOwnerStore | undefined,
  receiptStore: undefined as LocalDependencyReceiptStore | undefined,
  origin: undefined as { start: Readonly<Record<string, unknown>>; reservation: { startId: string } } | undefined,
  absencePath: "", requestedAbsencePath: "",
  afterCapture: undefined as (() => void) | undefined,
  captureStatuses: [] as NpmInputCaptureStatus[],
}));

// Host authority is explicitly synthetic. The materializer, input capture,
// physical workspace and owner/receipt stores are actual production code.
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-process-activation")>(),
  withHostedActivationFence: <T>(action: (fence: HostedActivationFence) => T): T => action(fixture.fence),
  readHostedOrdinaryProcessOrigin: () => {
    if (!fixture.origin) throw new Error("TEST origin not configured");
    return fixture.origin;
  },
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-dependency-workspace")>(),
  readHostedDependencyAttempt: vi.fn((binding: HostedDependencyBinding, start: Readonly<Record<string, unknown>>,
    startId: string, phase: DependencyOwnerPhase) => {
    const record = fixture.ownerStore?.read(binding.workspace);
    if (!record || record.version !== 2 || !isDependencyConsumerOwner(record.owner) || record.owner.phase !== phase) {
      throw new Error("TEST current owner unavailable");
    }
    const attempt = record.owner.attempt;
    // Match the real reader contract: authenticate current launch/start, return
    // its attempt. Comparing that full attempt to the caller is the consumer's job.
    if (attempt.launch.startId !== startId || attempt.launch.unit !== start.unit || attempt.launch.bootId !== start.bootId ||
      attempt.launch.installationId !== binding.installationId || attempt.launch.runtimeSha !== binding.runtimeSha ||
      attempt.launch.grantDigest !== binding.grantDigest) throw new Error("TEST launch mismatch");
    return attempt;
  }),
}));
vi.mock("../../worker-local/dependency-environment/capture-npm-install-inputs", async original => {
  const real = await original<typeof import("../../worker-local/dependency-environment/capture-npm-install-inputs")>();
  return { ...real, captureNpmInstallInputs: async (input: Parameters<typeof real.captureNpmInstallInputs>[0]) => {
    const captured = await real.captureNpmInstallInputs(input);
    fixture.captureStatuses.push(captured.status);
    const replace = fixture.afterCapture; fixture.afterCapture = undefined;
    replace?.();
    return captured;
  } };
});
vi.mock("../hosted-dependency-installer-recipe", async original => ({
  ...await original<typeof import("../hosted-dependency-installer-recipe")>(),
  readHostedDependencyInstallerProfile: () => profile(),
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedPrivateBytes: (path: string, maxBytes: number) => {
    if (path !== fixture.requestedAbsencePath) throw new Error("TEST unexpected private record read");
    const bytes = readFileSync(fixture.absencePath);
    if (bytes.length > maxBytes) throw new Error("TEST absence exceeds bound");
    return bytes;
  },
}));
// Redirect only protected receipt transport into a fresh private TEST root;
// actual history parsing, CAS and publication effects remain real.
vi.mock("../hosted-dependency-receipts", async original => ({
  ...await original<typeof import("../hosted-dependency-receipts")>(),
  readHostedDependencyReceipt: (binding: HostedDependencyBinding) => {
    if (!fixture.receiptStore) throw new Error("TEST receipt store not configured");
    return fixture.receiptStore.read(binding.workspace);
  },
  publishHostedDependencyReceipt: vi.fn((binding: HostedDependencyBinding, expectedRevision: number | null, next: DependencyReceipt) => {
    if (!fixture.receiptStore) throw new Error("TEST receipt store not configured");
    return fixture.receiptStore.compareAndSwap(binding.workspace, expectedRevision, next);
  }),
}));

function profile(): HostedDependencyInstallerProfile {
  return { schemaVersion: 1, recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
    nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127",
    platform: "linux", arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    npmSha256: "b".repeat(64), npmVersion: "10.9.3", npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
    libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
    toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
    networkInputs: { hosts: "e".repeat(64), "resolv.conf": "f".repeat(64), "nsswitch.conf": "e".repeat(64) },
    privilegeDropper: { path: "/usr/bin/setpriv", sha256: "f".repeat(64), version: "2.39.3",
      libraries: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }] } };
}

describe.skipIf(process.platform !== "linux")("materialization attempt after async input capture", () => {
  it("rejects a replaced same-launch owner before Installing publication or installer launch", async () => {
    // Red on the old launch-only check: it discards returned B, publishes A's
    // Installing receipt and calls install(). The fixed caller requires full A.
    const testRoot = await realpath(await mkdtemp(join(tmpdir(), "materialization-attempt-TEST-")));
    const workspacePath = join(testRoot, "workspace"), ownerRoot = join(testRoot, "owners"), receiptRoot = join(testRoot, "receipts");
    for (const path of [workspacePath, ownerRoot, receiptRoot]) await mkdir(path, { mode: 0o700 });
    const pkg = { name: "attempt-replacement-TEST", version: "1.0.0" };
    const packageBytes = Buffer.from(JSON.stringify(pkg)), lockBytes = Buffer.from(JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }));
    const sentinelBytes = Buffer.from("TEST original source bytes");
    await writeFile(join(workspacePath, "package.json"), packageBytes, { mode: 0o600 });
    await writeFile(join(workspacePath, "package-lock.json"), lockBytes, { mode: 0o600 });
    await writeFile(join(workspacePath, "TEST-source-sentinel"), sentinelBytes, { mode: 0o600 });
    const stat = await lstat(workspacePath, { bigint: true });
    const startId = randomUUID();
    const actualLaunch: DependencyLaunchBinding = { installationId: randomUUID(), bootId: randomUUID(), startId,
      runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64), unit: `subscription-runtime-ordinary-${startId}.service` };
    const binding: HostedDependencyBinding = { version: 1, jobId: "TEST-attempt-replacement", jobRootDir: testRoot,
      workspace: { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) },
      installationId: actualLaunch.installationId, runtimeSha: actualLaunch.runtimeSha, grantDigest: actualLaunch.grantDigest };
    const owners = LocalDependencyOwnerStore.open({ rootPath: ownerRoot, maxRecordBytes: 4096 });
    const receipts = LocalDependencyReceiptStore.open({ rootPath: receiptRoot, maxRecordBytes: 16384, maxHistorySteps: 16 });
    fixture.ownerStore = owners; fixture.receiptStore = receipts; fixture.captureStatuses = [];
    fixture.origin = { start: { workspacePath, bootId: actualLaunch.bootId, unit: actualLaunch.unit }, reservation: { startId: actualLaunch.startId } };
    fixture.absencePath = join(testRoot, "fresh-absence.json");
    fixture.requestedAbsencePath = `/var/lib/subscription-runtime-host-policy/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`;
    const absenceBytes = Buffer.from(JSON.stringify({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) }) + "\n");
    await writeFile(fixture.absencePath, absenceBytes, { mode: 0o600 });
    vi.mocked(readHostedDependencyAttempt).mockClear(); vi.mocked(publishHostedDependencyReceipt).mockClear();
    const install = vi.spyOn(HostedDependencyInstaller.prototype, "install").mockRejectedValue(new Error("TEST unexpected installer launch"));
    let replacement: DependencyAttempt | undefined;
    try {
      const attempt = claimDependencyConsumer(owners, binding.workspace, actualLaunch, randomUUID());
      fixture.afterCapture = () => {
        // This fixture models an authorized old-owner discharge in protected
        // storage, without minting any real host drain/grant authority.
        fenceDependencyConsumer(owners, binding.workspace, attempt);
        const fenced = owners.read(binding.workspace);
        if (!fenced || fenced.owner?.phase !== DependencyOwnerPhase.Fenced) throw new Error("TEST owner not fenced");
        owners.compareAndSwap(binding.workspace, fenced.revision, { ...fenced, revision: fenced.revision + 1, owner: null });
        replacement = claimDependencyConsumer(owners, binding.workspace, actualLaunch, randomUUID());
      };
      const materialization = materializeHostedDependencyAbsence(binding, attempt);
      await expect(materialization).rejects.toBeInstanceOf(DependencyAdmissionError);
      await expect(materialization).rejects.toMatchObject({ reason: DependencyAdmissionFailure.StaleAttempt });
      expect(fixture.captureStatuses).toEqual([NpmInputCaptureStatus.Qualified]);
      expect(replacement).toBeDefined(); expect(replacement?.launch).toEqual(attempt.launch);
      expect(replacement?.attemptId).not.toBe(attempt.attemptId); expect(replacement?.epoch).toBe(attempt.epoch + 1);
      expect(readHostedDependencyAttempt).toHaveReturnedWith(attempt); expect(readHostedDependencyAttempt).toHaveReturnedWith(replacement);
      expect(publishHostedDependencyReceipt).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
      expect(receipts.read(binding.workspace)).toBeNull(); expect(await readdir(receiptRoot)).toEqual([]);
      expect(owners.read(binding.workspace)?.owner).toMatchObject({ phase: DependencyOwnerPhase.ExclusiveMutation, attempt: replacement });
      expect(await readFile(join(workspacePath, "package.json"))).toEqual(packageBytes);
      expect(await readFile(join(workspacePath, "package-lock.json"))).toEqual(lockBytes);
      expect(await readFile(join(workspacePath, "TEST-source-sentinel"))).toEqual(sentinelBytes);
      expect(await readFile(fixture.absencePath)).toEqual(absenceBytes);
      expect((await readdir(workspacePath)).sort()).toEqual(["TEST-source-sentinel", "package-lock.json", "package.json"]);
    } finally {
      fixture.afterCapture = undefined; fixture.ownerStore = undefined; fixture.receiptStore = undefined; fixture.origin = undefined;
      install.mockRestore(); receipts.close(); owners.close(); await rm(testRoot, { recursive: true, force: true });
    }
  });
});
