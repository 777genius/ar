import { host, local, request } from "./research-launch-fixture";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { grantOwnedMimoWorkerLaunch, grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { parseResearchOperatorRequest, type ResearchOperatorRequest } from "../research-launch-contract";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { admitResearchProcessFactory, bindResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";

/** Authenticated TEST runtime/reservation shared by service and diagnostics suites. */
export function prepareHelper(homeLeaf = "TEST-a", selected?: ResearchOperatorRequest) {
  const req = parseResearchOperatorRequest(selected ?? request());
  (req.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan ? grantOwnedMimoWorkerLaunch : grantResearchLaunch)(req.jobId, req.jobRootDir, req.workspacePath);
  fs.writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(req), { mode: 0o600 });
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

export const providerStreams = new Set<PassThrough>();
export const readyFrame = "subscription-runtime-research-provider-ready-v1\n";
export const settledNamespaces = { user: "TEST-provider-user", mnt: "TEST-provider-mnt", pid: "TEST-host", net: "TEST-host" };
export function providerProxy(current: ReturnType<typeof prepareHelper>, accept = true, ready = true) {
  const proxy = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) });
  const forwarded: Buffer[] = [];
  for (const stream of [proxy.stdin, proxy.stdout, proxy.stderr]) providerStreams.add(stream);
  proxy.stdin.on("data", chunk => forwarded.push(Buffer.from(chunk)));
  const submit = () => {
    if (accept) {
      host.units.set(current.provider, { pid: 424242, description: `subscription-runtime-research-provider:${current.startId}:${current.provider}`,
        invocation: "d".repeat(32), active: true });
      host.processGroups.set(424242, `/system.slice/${current.provider}`);
      host.processNamespaces.set(424242, settledNamespaces);
      fs.writeFileSync(local(`/run/systemd/transient/${current.provider}`), "TEST provider fragment", { mode: 0o644 });
    }
    if (ready) queueMicrotask(() => proxy.stdout.write(readyFrame));
    return proxy;
  };
  return { proxy, forwarded, submit };
}
export const record = (current: ReturnType<typeof prepareHelper>, suffix: string) =>
  JSON.parse(researchRead(join(current.directory, "providers", current.provider + suffix + ".json")).toString());
/** Move the substituted Host monotonic clock without replaying every 25 ms permission poll. Tests still execute the real poll at the selected boundary. */
export function researchClock() {
  vi.useFakeTimers();
  const origin = Date.now(), monotonicOrigin = process.hrtime.bigint(); let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin + elapsed);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => monotonicOrigin + BigInt(Date.now() - origin + elapsed) * 1_000_000n);
  return Object.assign(() => performance.now(), { advance: (ms: number) => { elapsed += ms; } });
}
/** Model a three-second artifact traversal on slow Host I/O, still inside its finite thirty-second bound. All retained bytes/digests remain real; only the Host clock and directory-observation latency are substituted. */
export function slowBoundedMaterial() {
  const now = researchClock();
  const readDirectory = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
    if (path === "/TEST-artifact/dist") now.advance(3_000);
    return readDirectory(path, options);
  }) as typeof fs.readdirSync);
  return now;
}
