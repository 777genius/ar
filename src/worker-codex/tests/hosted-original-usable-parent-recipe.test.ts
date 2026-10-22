import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planStoredProjectStart } from "../stored-start-planning";
import { buildCodexGoalForegroundArgv } from "../application/codex-goal-foreground-command";
import { readHostedDependencyParentRecipe } from "../hosted-dependency-parent-recipe";
import { sdkRecipe } from "./hosted-dependency-sdk-recipe.fixture";
import { buildOriginalUsableRecipe, originalUsablePaths } from "./hosted-original-usable-recipe.fixture";
import { assertHostedOrdinaryDependencyToolParentFrame } from "../hosted-managed-dependency-tool-plan";
import type { HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import type { HostedInventoryLaunch } from "../../core/host-infrastructure/host-inventory";
import * as activationFiles from "../../provider-codex/app-server/adapters/hosted-process-activation";
import * as workspaceFiles from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedOriginalUsableInstallationRecipe } from "../hosted-original-usable-parent-recipe";
import { parseHostedInstallation } from "../../worker-core/hosted-custody/domain/hosted-installation-activation";

// Substitute protected file reads and kernel collection only. The real stored
// manifests, scope parser, launch planner, binding and recipe resolver run.
const f = vi.hoisted(() => ({
  privateBytes: new Map<string, Buffer>(), activationBytes: new Map<string, Buffer>(),
  qualificationBytes: new Map<string, Buffer>(), procBytes: new Map<string, string | Buffer>(),
  procLinks: new Map<string, string>(), namespaces: new Map<string, { dev: number; ino: number }>(),
  birth: "", group: "", unit: "", invocation: "", reads: [] as string[],
  metadata: new Map<string, { kind: "directory" | "file"; nlink: bigint }>(),
  selected: undefined as { binding: HostedDependencyBinding; launch: HostedInventoryLaunch } | undefined,
  parentRead: vi.fn(),
}));
// Vitest executes source modules; the real deployed planner executes this file
// in dist. Reproduce that module location without replacing planning/binding.
vi.mock("node:url", async original => {
  const actual = await original<typeof import("node:url")>();
  return { ...actual, fileURLToPath: (url: string | URL) => actual.fileURLToPath(url)
    .replace(/\/src\/worker-codex\/application\/codex-goal-launch-input\.ts$/, "/dist/worker-codex/application/codex-goal-launch-input.js") };
});
vi.mock("../hosted-ordinary-dependency-reader", () => ({
  readHostedOrdinaryDependencyParentFrame: f.parentRead,
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedPrivateBytes: (path: string) => { f.reads.push(path); return f.privateBytes.get(path) ?? null; },
}));
vi.mock("../hosted-ordinary-installation-qualification", async original => ({
  ...await original<typeof import("../hosted-ordinary-installation-qualification")>(),
  qualificationRead: (path: string) => {
    f.reads.push(path); const bytes = f.qualificationBytes.get(path);
    if (!bytes) throw new Error("fixture_protected_leaf_absent"); return bytes;
  },
}));
vi.mock("../hosted-readonly-linux-collector", async original => ({
  ...await original<typeof import("../hosted-readonly-linux-collector")>(),
  collectUnitShow: (unit: string) => {
    if (unit !== f.unit) throw new Error("fixture_foreign_unit");
    return { MainPID: String(process.pid), ControlGroup: f.group, InvocationID: f.invocation,
      LoadState: "loaded", ActiveState: "active", Delegate: "no", Job: "" };
  },
  collectProcessBirth: (pid: string) => {
    if (pid !== String(process.pid)) throw new Error("fixture_foreign_pid"); return f.birth;
  },
  collectProcessCgroup: (pid: string) => {
    if (pid !== String(process.pid)) throw new Error("fixture_foreign_pid"); return "0::" + f.group;
  },
  collectUnitInvocation: (unit: string) => {
    if (unit !== f.unit) throw new Error("fixture_foreign_unit"); return f.invocation;
  },
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const directory = actual.lstatSync(process.cwd(), { bigint: true }), file = actual.lstatSync(process.execPath, { bigint: true });
  return { ...actual,
    readFileSync: (path: string, options?: unknown) => {
      f.reads.push(path);
      const value = f.procBytes.get(path);
      if (value !== undefined) return options === "utf8" ? value.toString() : Buffer.from(value);
      return actual.readFileSync(path, options as BufferEncoding);
    },
    readlinkSync: (path: string) => f.procLinks.get(path) ?? actual.readlinkSync(path),
    statSync: (path: string, options?: unknown) => f.namespaces.get(path) ?? actual.statSync(path, options as { bigint: false }),
    lstatSync: (path: string, options?: unknown) => {
      const value = f.metadata.get(path);
      if (value) {
        const base = value.kind === "directory" ? directory : file;
        return Object.assign(Object.create(Object.getPrototypeOf(base)), base,
          { uid: 0n, gid: 0n, dev: 1n, mode: value.kind === "directory" ? 0o40700n : 0o100600n, nlink: value.nlink });
      }
      if (f.selected && (path.startsWith(f.selected.binding.jobRootDir + "/") || path.startsWith("/var/lib/subscription-runtime-host-policy/ordinary-qualification/")))
        throw Object.assign(new Error("fixture_absent"), { code: "ENOENT" });
      return actual.lstatSync(path, options as { bigint: true });
    },
    realpathSync: (path: string) => f.metadata.has(path) ? path : actual.realpathSync(path),
    readdirSync: (path: string) => f.metadata.has(path) ? [...f.metadata.keys()].filter(child => child !== path && dirname(child) === path).map(child => child.slice(path.length + 1)) : actual.readdirSync(path),
  };
});

const { policy, qualification, jobId, job, workspace, registry, auth } = originalUsablePaths;
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function replaceJson(map: Map<string, Buffer>, key: string, patch: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(map.get(key)!.toString()) as Record<string, unknown>;
  patch(value); map.set(key, json(value));
}

function originalUsableRecipe(workerPatch: Record<string, unknown> = {}) {
  const recipe = buildOriginalUsableRecipe({ workerPatch });
  for (const [path, bytes] of recipe.privateBytes) f.privateBytes.set(path, bytes);
  for (const [name, bytes] of recipe.activationBytes) f.activationBytes.set(name, bytes);
  for (const [path, bytes] of recipe.qualificationBytes) f.qualificationBytes.set(path, bytes);
  for (const [path, bytes] of recipe.procBytes) f.procBytes.set(path, bytes);
  for (const [path, link] of recipe.procLinks) f.procLinks.set(path, link);
  for (const [path, identity] of recipe.namespaces) f.namespaces.set(path, identity);
  f.birth = recipe.birth; f.unit = recipe.unit; f.group = recipe.group; f.invocation = recipe.invocation;
  return recipe;
}

beforeEach(() => {
  for (const map of [f.privateBytes, f.activationBytes, f.qualificationBytes, f.procBytes, f.procLinks, f.namespaces]) map.clear();
  f.metadata.clear(); f.selected = undefined; f.parentRead.mockReset();
  f.reads.length = 0; f.birth = ""; f.group = ""; f.unit = ""; f.invocation = "";
  vi.spyOn(workspaceFiles, "assertHostedDependencyPhysicalWorkspace").mockImplementation(() => undefined);
  vi.spyOn(activationFiles, "readHostedActivationBytes").mockImplementation(name => {
    f.reads.push(name); return f.activationBytes.get(name) ?? null;
  });
});

describe("authenticated original Usable stored SDK parent recipe", () => {
  it("resolves original broker/registry/state facts while preserving the installed raw tuple and digest", () => {
    const { launch, plan, inventoryBytes } = originalUsableRecipe(), before = JSON.stringify(launch), digest = sha(before);
    expect(plan.launch.config.authRootDir).toBe(auth);
    expect(plan.launch.config.accounts.map(account => account.name)).toEqual(["account-test"]);
    const resolved = readHostedDependencyParentRecipe(launch, job, workspace);
    expect(resolved.args).toEqual(buildCodexGoalForegroundArgv(plan.launch).slice(1));
    expect(resolved.args).toContain("app-server"); expect(resolved.args).toContain(job + "/state/progress.json");
    expect(resolved.args).toContain(registry + "/durable-handoffs"); expect(resolved.args).toContain(auth);
    expect(JSON.stringify(launch)).toBe(before); expect(sha(JSON.stringify(launch))).toBe(digest);
    expect(f.activationBytes.get("readonly-inventory.json")).toEqual(inventoryBytes);
    expect(f.reads.some(path => path.endsWith("/auth.json"))).toBe(false);
  });

  it("refuses missing protected context, a foreign current worker, and changed ready or funded joins", () => {
    for (const tamper of [
      () => f.activationBytes.delete("host-installation.json"),
      () => f.qualificationBytes.delete(qualification + "/usable-input.json"),
      () => { f.birth = process.pid + ":101"; },
      () => replaceJson(f.qualificationBytes, qualification + "/usable-ready.json", ready => { ready.guestInputSha256 = "9".repeat(64); }),
      () => replaceJson(f.qualificationBytes, qualification + "/funded-operation.json", funded => { funded.issuedMonotonicNs = "1"; }),
      () => { f.namespaces.set("/proc/self/ns/mnt", { dev: 1, ino: 999 }); },
    ]) {
      const { launch } = originalUsableRecipe(); tamper();
      expect(() => readHostedDependencyParentRecipe(launch, job, workspace)).toThrow();
    }
  });

  it("refuses altered raw creator provenance and unrelated writer roots even with a genuine rebound stored plan", () => {
    const original = originalUsableRecipe();
    // Same valid SDK request and binding, different raw producer tuple.
    original.launch.args[4] = " " + original.launch.args[4]!;
    expect(() => readHostedDependencyParentRecipe(original.launch, job, workspace)).toThrow();
    for (const patch of [{ authRootDir: job + "/auth" }, { progressPath: workspace + "/node_modules/progress.json" },
      { durableHandoffRootDir: job + "/durable-handoffs" }]) {
      const { launch } = originalUsableRecipe(patch);
      expect(() => readHostedDependencyParentRecipe(launch, job, workspace)).toThrow();
    }
  });

  it("keeps generic SDK broker redirects forbidden and requires the original protected manifest bytes", () => {
    const genericJob = policy + "/dependency-test-jobs/jobs/TEST-parent", generic = sdkRecipe(f.privateBytes, genericJob);
    expect(() => readHostedDependencyParentRecipe(generic, genericJob, genericJob + "/workspace")).not.toThrow();
    const genericRegistry = genericJob + "/state/registry", genericManifest = genericRegistry + "/TEST-parent/job.json";
    replaceJson(f.privateBytes, genericManifest, manifest => { manifest.authRootDir = auth; });
    const genericRequest = JSON.parse(generic.args[4]!);
    const rebound = planStoredProjectStart(JSON.stringify(genericRequest), generic.cwd, {
      controller: f.privateBytes.get(genericRegistry + "/TEST-control/job.json")!, worker: f.privateBytes.get(genericManifest)!,
      prompt: f.privateBytes.get(genericJob + "/prompt")!, preStart: null });
    generic.args[4] = JSON.stringify({ ...genericRequest, storedStartBinding: rebound.binding });
    expect(() => readHostedDependencyParentRecipe(generic, genericJob, generic.cwd)).toThrow();
    const { launch } = originalUsableRecipe(), workerManifest = registry + "/" + jobId + "/job.json";
    f.privateBytes.set(workerManifest, Buffer.concat([f.privateBytes.get(workerManifest)!, Buffer.from("\n")]));
    expect(() => readHostedDependencyParentRecipe(launch, job, workspace)).toThrow();
  });

  it("authenticates the Store's fresh installation draft while keeping unpublished parent writer facts unavailable", () => {
    const { launch } = originalUsableRecipe();
    const publishedBytes = f.activationBytes.get("host-installation.json")!;
    const draft = parseHostedInstallation(JSON.parse(publishedBytes.toString()));
    f.activationBytes.delete("host-installation.json");
    expect(() => readHostedDependencyParentRecipe(launch, job, workspace)).toThrow();
    const fence = {} as HostedActivationFence;
    const fenceCheck = vi.spyOn(activationFiles, "assertHostedActivationFence").mockImplementation(() => undefined);
    try {
      expect(readHostedOriginalUsableInstallationRecipe(fence, draft, launch)).toBe(true);
      expect(fenceCheck).toHaveBeenCalledTimes(2);
      for (const patch of [{ runtimeSha: "9".repeat(40) }, { inventorySha256: "9".repeat(64) }])
        expect(() => readHostedOriginalUsableInstallationRecipe(fence, { ...draft, ...patch }, launch)).toThrow();
      f.activationBytes.set("host-installation.json", json({ ...draft, installationId: "foreign-installation" }));
      expect(() => readHostedOriginalUsableInstallationRecipe(fence, draft, launch)).toThrow();
      expect(f.reads.some(path => path.endsWith("/auth.json"))).toBe(false);
    } finally { fenceCheck.mockRestore(); }
  });

  it("checks the original state and broker-capacity hardlinks before returning an ordinary parent frame", () => {
    const { launch } = originalUsableRecipe(), rawBefore = JSON.stringify(launch);
    f.selected = { launch, binding: { jobRootDir: job, workspace: { canonicalPath: workspace } } as HostedDependencyBinding };
    f.parentRead.mockImplementation(() => f.selected);
    const capacity = qualification + "/.subscription-runtime-account-capacity";
    for (const path of [job, auth, qualification, job + "/state", registry, capacity])
      f.metadata.set(path, { kind: "directory", nlink: 1n });
    const fence = {} as HostedActivationFence, frame = Buffer.from("selected ordinary frame fixture");
    expect(() => assertHostedOrdinaryDependencyToolParentFrame(fence, "fixture-start", frame)).not.toThrow();
    expect(f.parentRead).toHaveBeenCalledTimes(2);
    for (const path of [job + "/state/run.log", job + "/state/progress.json", capacity + "/capacity.json"]) {
      f.parentRead.mockClear(); f.metadata.set(path, { kind: "file", nlink: 2n });
      expect(() => assertHostedOrdinaryDependencyToolParentFrame(fence, "fixture-start", frame)).toThrow();
      expect(f.parentRead).toHaveBeenCalledTimes(1); f.metadata.delete(path);
    }
    expect(JSON.stringify(launch)).toBe(rawBefore);
    expect(f.reads.some(path => path.endsWith("/auth.json"))).toBe(false);
  });
});
