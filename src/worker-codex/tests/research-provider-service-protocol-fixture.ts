import { host, local } from "./research-launch-fixture";
import { vi } from "vitest";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { researchRead } from "../research-launch-files";
import type { prepareHelper } from "./research-provider-service-fixture";

export const streams = new Set<PassThrough>();
export const readyFrame = "subscription-runtime-research-provider-ready-v1\n";
export const settledNamespaces = { user: "TEST-provider-user", mnt: "TEST-provider-mnt", pid: "TEST-host", net: "TEST-host" };
export function providerProxy(current: ReturnType<typeof prepareHelper>, accept = true, ready = true) {
  const proxy = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) });
  const forwarded: Buffer[] = [];
  for (const stream of [proxy.stdin, proxy.stdout, proxy.stderr]) streams.add(stream);
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
