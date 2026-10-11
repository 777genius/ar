import { beforeEach, describe, expect, it, vi } from "vitest";
import { sdkRecipe } from "../../provider-codex/tests/hosted-dependency-sdk-recipe.fixture";
import { assertHostedOrdinaryDependencyToolParentFrame } from "../hosted-managed-dependency-tool-plan";
import type { HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import type { HostedInventoryLaunch } from "../../core/host-infrastructure/host-inventory";
const f = vi.hoisted(() => ({ snapshots: new Map<string, Buffer>(), alias: "", selected:
  undefined as { binding: HostedDependencyBinding; launch: HostedInventoryLaunch } | undefined, read: vi.fn() }));
vi.mock("../hosted-readonly-inputs", async original => ({ ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedPrivateBytes: (path: string) => f.snapshots.get(path) }));
vi.mock("../hosted-ordinary-dependency-reader", () => ({
  readHostedOrdinaryDependencyParentFrame: f.read }));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-dependency-workspace")>(),
  assertHostedDependencyPhysicalWorkspace: vi.fn() }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const directory = actual.lstatSync(process.cwd(), { bigint: true }), file = actual.lstatSync(process.execPath, { bigint: true });
  const metadata = <T extends object>(s:T, values:object):T => Object.assign(Object.create(Object.getPrototypeOf(s)),s,values);
  return { ...actual,
    lstatSync: (path: string, options?: {bigint?: boolean}) => {
      const jr = f.selected?.binding.jobRootDir;
      if (path === jr || path === jr + "/auth") return metadata(directory,{uid:0n,gid:0n,dev:1n,mode:0o40700n});
      if (jr && path.startsWith(jr + "/")) {
        if (path === f.alias) return metadata(file,{uid:0n,gid:0n,dev:1n,mode:0o100600n,nlink:2n});
        throw Object.assign(new Error("fixture_absent"),{code:"ENOENT"});
      }
      return actual.lstatSync(path,options as {bigint:true});
    },
    realpathSync: (path:string) => f.selected && path.startsWith(f.selected.binding.jobRootDir) ? path : actual.realpathSync(path),
  };
});
const job = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-parent";
const fence = {} as HostedActivationFence;
beforeEach(() => {
  f.snapshots.clear(); f.alias=""; f.read.mockReset();
  const launch = sdkRecipe(f.snapshots,job);
  f.selected = { binding: { jobRootDir:job,workspace:{canonicalPath:job+"/workspace"} } as HostedDependencyBinding,launch };
  f.read.mockImplementation(()=>f.selected);
});
// Reserved-origin and physical workspace adapters are substituted. The actual
// protected SDK resolver and original pre-payload writer metadata guard run.
describe("ordinary SDK parent frame writer facts",()=>{
  it("accepts its original stored tuple while preserving selected raw provenance",()=>{
    const before=JSON.stringify(f.selected!.launch);
    expect(()=>assertHostedOrdinaryDependencyToolParentFrame(fence,"fixture",Buffer.from("fixture"))).not.toThrow();
    expect(JSON.stringify(f.selected!.launch)).toBe(before); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it.each(["events.jsonl","log","progress.json"])("rejects the actual resolved task %s leaf alias before a foreground frame",suffix=>{
    f.alias=job+"/TEST-parent."+suffix;
    expect(()=>assertHostedOrdinaryDependencyToolParentFrame(fence,"fixture",Buffer.from("fixture"))).toThrow();
    expect(f.read).toHaveBeenCalledTimes(1);
  });
});
