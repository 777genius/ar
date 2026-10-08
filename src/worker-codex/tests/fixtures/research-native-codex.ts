import { local, request } from "../research-launch-fixture";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { grantResearchLaunch, startResearchLaunch } from "../../research-launch-owner";
import { researchCurrentStart } from "../../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../../research-launch-files";
import { prepareResearchProviderRoot } from "../../research-provider-root";
import type { ResearchStartSpec } from "../../research-launch-contract";

export const nativeCodex = "/opt/TEST-codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
export const nativeCompanion = join(dirname(nativeCodex), "codex-code-mode-host");
export const nativeUnrelated = join(dirname(nativeCodex), "TEST-unrelated");
export const nativeUnit = "subscription-runtime-research-provider-11111111-1111-1111-1111-111111111111.service";

export function captureNativeCodex(binary = nativeCodex) {
  fs.mkdirSync(local(dirname(binary)), { recursive: true, mode: 0o755 });
  fs.writeFileSync(binary, '#!/bin/sh\nself="${0%/*}"\n[ ! -e "$self/TEST-unrelated" ] || exit 42\nexec "$self/codex-code-mode-host"\n', { mode: 0o755 });
  fs.writeFileSync(join(dirname(binary), "codex-code-mode-host"), "#!/bin/sh\nprintf 'TEST_NATIVE_COMPANION_READY\\n'\n", { mode: 0o755 });
  fs.writeFileSync(join(dirname(binary), "TEST-unrelated"), "TEST sibling never admitted", { mode: 0o755 });
  const job = request().jobRootDir;
  const req = { ...request(), codexBinaryPath: binary, workspacePath: "/TEST-project/disjoint-workspace" };
  const home = join(job, "home/TEST-a");
  fs.mkdirSync(local(req.workspacePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(local(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync("/TEST-operator/request.json", JSON.stringify(req) + "\n", { mode: 0o600 });
  grantResearchLaunch(req.jobId, job, req.workspacePath);
  const start = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  const current = researchCurrentStart(start.jobId);
  const spec: ResearchStartSpec = { ...current.spec, runtimeDirectory: "/TEST-artifact" };
  researchPublish(join(current.directory, "spec.json"), spec);
  const specSha256 = researchHash(researchRead(join(current.directory, "spec.json")));
  researchPublish(join(current.directory, "providers", nativeUnit + ".json"), {
    schemaVersion: 1, unit: nativeUnit, runtimeUnit: spec.unit, specSha256,
    description: `subscription-runtime-research-provider:${spec.startId}:${nativeUnit}`,
  }, true);
  return { spec, home, directory: current.directory,
    prepare: () => prepareResearchProviderRoot(spec, nativeUnit, home) };
}
