import { host, local, request, setupResearchFixture } from "./research-launch-fixture";
import { vi } from "vitest";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { prepareResearchProviderRoot, researchProviderRootSeal } from "../research-provider-root";

const nativeFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
export const assemblyDescriptorIo = {
  fstatSync: nativeFs.fstatSync, readSync: nativeFs.readSync, closeSync: nativeFs.closeSync,
};
export const assemblyUnit = "subscription-runtime-research-provider-11111111-1111-1111-1111-111111111111.service";

/** Host ownership/mount/proc metadata is modeled by the existing TEST fixture.
 * FD IO, inode changes and file bytes are native. This is not physical mount or
 * namespace/ABA qualification, which requires the separate server proof. */
export function setupPrivateRootAssemblyFixture(): void {
  setupResearchFixture();
  const readlink = fs.readlinkSync;
  vi.spyOn(fs, "readlinkSync").mockImplementation(((path: fs.PathLike, options?: Parameters<typeof fs.readlinkSync>[1]) => {
    if (typeof path === "string" && /^\/proc\/self\/fd\/\d+$/.test(path)) {
      const fd = Number(path.slice(path.lastIndexOf("/") + 1)), admitted = host.fdPaths.get(fd);
      if (!admitted) throw new Error("Untracked TEST assembly descriptor");
      const held = nativeFs.fstatSync(fd), current = nativeFs.lstatSync(local(admitted));
      // Model the namespace-visible link only for an actual held inode still
      // reached by its admitted path. Never echo a caller-selected descriptor.
      return held.dev === current.dev && held.ino === current.ino ? admitted : admitted + " (deleted)";
    }
    return readlink(path, options);
  }) as typeof fs.readlinkSync);
}

/** Use the real grant/start, reservation, branded creator and seal. No test
 * fabricates plan JSON, its backing tuples, skeleton or expected seal. */
export function preparePrivateRootAssemblyFixture() {
  const req = { ...request(), workspacePath: "/TEST-project/disjoint-workspace" };
  const home = join(req.jobRootDir, "home/TEST-a");
  fs.mkdirSync(local(req.workspacePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(local(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync("/TEST-operator/request.json", JSON.stringify(req) + "\n", { mode: 0o600 });
  grantResearchLaunch(req.jobId, req.jobRootDir, req.workspacePath);
  const started = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  const current = researchCurrentStart(started.jobId), spec = current.spec;
  researchPublish(join(current.directory, "providers", assemblyUnit + ".json"), {
    schemaVersion: 1, unit: assemblyUnit, runtimeUnit: spec.unit,
    specSha256: researchHash(current.bytes),
    description: `subscription-runtime-research-provider:${spec.startId}:${assemblyUnit}`,
  }, true);
  const plan = prepareResearchProviderRoot(spec, assemblyUnit, home);
  const seal = researchProviderRootSeal(plan, spec, assemblyUnit, home);
  const publicSource = plan.bindings.find(bind => bind.target === "/etc/hosts")?.source;
  if (!publicSource || !fs.readFileSync(publicSource, "utf8")) throw new Error("Missing nonempty TEST hosts snapshot");
  host.spawn.mockClear();
  return { jobId: spec.request.jobId, home, plan, seal, publicSource };
}
