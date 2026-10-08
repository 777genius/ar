import { host, local, request } from "./research-launch-fixture";
import { vi } from "vitest";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { admitResearchProcessFactory, bindResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";

/** Authenticated TEST runtime/reservation shared by service and diagnostics suites. */
export function prepareHelper(homeLeaf = "TEST-a") {
  const req = request(); grantResearchLaunch(req.jobId, req.jobRootDir, req.workspacePath);
  const start = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  host.group = `/system.slice/${start.unit}`; bindResearchRuntime(start.jobId, start.startId);
  const current = researchCurrentStart(start.jobId);
  const home = join(req.jobRootDir, "home", homeLeaf);
  fs.mkdirSync(local(home), { recursive: true, mode: 0o700 });
  const helper = admitResearchProcessFactory(req)({ command: req.codexBinaryPath, args: ["app-server"], cwd: req.workspacePath,
    env: { HOME: join(req.jobRootDir, "home"), CODEX_HOME: home } });
  const unit = fs.readdirSync(local(join(current.directory, "providers")))[0]!.slice(0, -5);
  // Substitute the runtime parent observation, while invoking the real helper
  // and retained-file protocol in this TEST process.
  host.units.get(start.unit)!.pid = process.ppid;
  researchPublish(join(current.directory, "binding.json"), { schemaVersion: 1, specSha256: researchHash(current.bytes),
    process: researchProcessIdentity(process.ppid), service: researchServiceIdentity(start.unit) });
  host.spawn.mockClear();
  const held = helper.stdin as PassThrough;
  const forward = vi.spyOn(process.stdin, "pipe").mockImplementation(destination => held.pipe(destination));
  return { ...current, ...start, provider: unit, helper, forward, home };
}
