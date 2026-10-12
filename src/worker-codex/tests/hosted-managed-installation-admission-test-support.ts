import * as egressFiles from "../hosted-test-egress-files";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { parseHostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { HostedReadonlySupervisorHost } from "../hosted-readonly-supervisor-host";
import { readHostedReadonlyHostInventory } from "../hosted-readonly-host-kernel";

/** Registration retains the installation suite's real private-record adapters,
 * ownership checks and TEST kernel facts, without sharing a production hook. */
export function registerManagedInstallationAdmissionTests({ fixture, stageName, seedManaged, read, put }: {
  readonly fixture: { root: string; runtimeUnit: string; group: string; spawn: ReturnType<typeof vi.fn> };
  readonly stageName: string;
  readonly seedManaged: () => void;
  readonly read: (name: string) => unknown;
  readonly put: (name: string, value: unknown) => void;
}): void {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const record = (name: string): Record<string, unknown> => {
    const value = read(name);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid TEST record");
    return value as Record<string, unknown>;
  };
// C1-R1: the genuine migrated installation binds both submission boundaries.
describe("managed inspected installation admission", () => {
  function migrated() {
    seedManaged(); put("readonly-epoch.json", { ...record("readonly-epoch.json"), phase: "closed" });
    const store = new HostedInstallationActivationStore(); store.installManaged(); store.enterExclusive();
    store.withExclusivePreparation(fence => new HostedReadonlySupervisorHost().recoverWithHeldFence(fence, parseHostedCustodyEpoch(read("readonly-epoch.json")).identity));
    store.finishExclusive();
  }
  function drift(fault: string) {
    if (fault === "inventory") {
      const inventory = readHostedReadonlyHostInventory(); put("readonly-inventory.json", { ...inventory, runtimeLaunch: { ...inventory.runtimeLaunch,
        args: [...inventory.runtimeLaunch.args, "--UNREVIEWED-TEST-ARG"] } });
    }
    if (fault === "directory") put("host-installation.json", { ...record("host-installation.json"), runtimeDirectory: "/TEST/foreign" });
    if (fault === "digest") put("host-installation.json", { ...record("host-installation.json"), inventorySha256: "f".repeat(64) });
    if (fault === "stage") put(stageName, { ...record(stageName), runtimeSha: "f".repeat(40) });
  }
  it.each(["exact", "inventory", "directory", "digest", "stage"])("outer submission binds %s before callback", fault => {
    migrated(); drift(fault);
    const command = readHostedReadonlyHostInventory().runtimeLaunch!, submit = vi.fn(() => 17);
    const run = () => new HostedReadonlySupervisorHost().runRuntimeLaunch(command.command, command.args, command.cwd, submit);
    if (fault === "exact") { expect(run()).toBe(17); expect(submit).toHaveBeenCalledOnce(); }
    else { expect(run).toThrow(); expect(submit).not.toHaveBeenCalled(); }
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it.each(["exact", "inventory", "directory", "digest", "stage"])("retained provider factory binds %s before spawn", fault => {
    migrated(); const command = readHostedReadonlyHostInventory().runtimeLaunch!;
    new HostedReadonlySupervisorHost().runRuntimeLaunch(command.command, command.args, command.cwd, () => 17);
    const epoch = parseHostedCustodyEpoch(read("readonly-epoch.json")); fixture.runtimeUnit = epoch.outerRuntime!.unit;
    fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${fixture.runtimeUnit}`;
    mkdirSync(join(fixture.root, "codex-readonly-services"), { mode: 0o700 });
    mkdirSync(join(fixture.root, "codex-readonly-services", hash("managed-job") + ".json"), { mode: 0o700 });
    const factory = admitHostedReadonlyInputs({ ...epoch.identity, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
      providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification) })!;
    drift(fault);
    const launch = () => factory({ command: "/TEST/codex", args: ["app-server"], cwd: "/managed/W", env: {
      SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "codex-test-managed-qualification" } });
    if (fault === "exact") {
      launch(); expect(fixture.spawn).toHaveBeenCalledOnce();
      const request = JSON.parse(fixture.spawn.mock.calls[0]![1][2]);
      expect(request.readonlyPaths).toContain("/managed/W/input");
      expect(parseHostedCustodyEpoch(read("readonly-epoch.json")).reservations).toHaveLength(1);
    } else { expect(launch).toThrow(); expect(fixture.spawn).not.toHaveBeenCalled(); }
  });
});
}

/** Keeps the original retained-history migration cases in their installation context. */
export function registerManagedInstallationMigrationTests({ fixture, stageName, seedManaged, read, put, hash }: {
  readonly fixture: { root: string; group: string; spawn: ReturnType<typeof vi.fn>; stops: string[] };
  readonly stageName: string;
  readonly seedManaged: () => void;
  readonly read: (name: string) => ReturnType<typeof JSON.parse>;
  readonly put: (name: string, value: unknown) => void;
  readonly hash: (value: Buffer | string) => string;
}): void {
describe("explicit retained managed installation migration", () => {
  function retained() {
    seedManaged(); put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "closed" });
    return new HostedInstallationActivationStore();
  }
  it.each([false, true])("retains exact managed history and revocation while publishing only CLOSED: revoked=%s", revoked => {
    const store = retained();
    put("readonly-epoch.json", { ...read("readonly-epoch.json"), revoked });
    const before = readFileSync(join(fixture.root, "readonly-epoch.json"));
    const birth = readFileSync(join(fixture.root, "readonly-enrollment.json"));
    expect(() => store.install()).toThrow();
    const activation = store.installManaged();
    expect(activation.phase).toBe("CLOSED");
    expect(activation.exclusiveEnrollmentSha256).toBe(hash(birth));
    expect(read("ordinary-origins.json").origins).toEqual([]);
    expect(store.installManaged()).toEqual(activation);
    expect(readFileSync(join(fixture.root, "readonly-epoch.json"))).toEqual(before);
    expect(readFileSync(join(fixture.root, "readonly-enrollment.json"))).toEqual(birth);
    expect(fixture.spawn).not.toHaveBeenCalled(); expect(fixture.stops).toEqual([]);
  });
  it.each(["missing-birth", "missing-epoch", "ready", "stage", "foreign-host", "pending-epoch", "ordinary-history", "foreign-operator", "missing-terminal-proof"])(
    "rejects %s without creating installation authority", fault => {
      const store = retained();
      if (fault === "missing-birth") rmSync(join(fixture.root, "readonly-enrollment.json"));
      if (fault === "missing-epoch") rmSync(join(fixture.root, "readonly-epoch.json"));
      if (fault === "ready") put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "ready" });
      if (fault === "stage") put(stageName, { ...read(stageName), runtimeSha: "f".repeat(40) });
      if (fault === "foreign-host") put("readonly-epoch.json", { ...read("readonly-epoch.json"), hostId: "foreign-host" });
      if (fault === "pending-epoch") put("readonly-epoch.next", read("readonly-epoch.json"));
      if (fault === "ordinary-history") put("ordinary-starts/orphan.json", { incomplete: true });
      if (fault === "foreign-operator") fixture.group = "/system.slice/foreign.service";
      if (fault === "missing-terminal-proof") put("readonly-epoch.json", { ...read("readonly-epoch.json"), reservations: [{
        startId: "33333333-3333-4333-8333-333333333333", creatorId: "33333333-3333-4333-8333-333333333333",
        unit: "subscription-runtime-hosted-33333333-3333-4333-8333-333333333333.service", state: "terminal" }] });
      expect(() => store.installManaged()).toThrow();
      expect(() => read("host-installation.json")).toThrow();
      expect(fixture.spawn).not.toHaveBeenCalled(); expect(fixture.stops).toEqual([]);
    });
  it("missing activation after publication is not reconstructed on migration replay", () => {
    const store = retained(); store.installManaged(); rmSync(join(fixture.root, "host-activation.json"));
    expect(() => store.installManaged()).toThrow();
    expect(() => read("host-activation.json")).toThrow();
  });
  it("official managed migration command derives retained identity without caller-authored records", async () => {
    retained();
    // Directory provisioning is an explicit substituted host fact. All records,
    // installation validation and CLI dispatch below use the real composition.
    vi.spyOn(egressFiles, "assertHostedTestEgressDirectory").mockResolvedValue(true);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const argv = process.argv, exitCode = process.exitCode;
    try {
      process.argv = [process.execPath, "operator", "install-managed-host"];
      await import("../hosted-readonly-inputs-cli");
    } finally { process.argv = argv; process.exitCode = exitCode; vi.resetModules(); }
    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"operation":"install-managed-host"'));
    expect(read("host-activation.json").phase).toBe("CLOSED");
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});
}
