import { spawn } from "node:child_process";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { announceHostedFdPrelude, assertHostedFdFrameEnvironment } from "../provider-codex/app-server/adapters/hosted-fd-prelude";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";

// Fixed trusted outer service bootstrap. Only environment crosses the private
// pipe; command/cwd/argv come from independently installed root inventory. No
// environment is persisted in systemd properties, receipts or error messages.
let bytes = Buffer.alloc(0);
const profile = readHostedFdProfile(), began = process.hrtime.bigint();
const stopPrelude = profile ? announceHostedFdPrelude() : () => {};
process.stdin.on("data", (chunk: Buffer) => {
  if (bytes.length + chunk.length > 4 * 1024 * 1024) fail();
  bytes = Buffer.concat([bytes, chunk]);
});
process.stdin.once("end", async () => {
  try {
    stopPrelude();
    const frame: unknown = JSON.parse(bytes.toString("utf8"));
    bytes = Buffer.alloc(0);
    if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
        Object.keys(frame).sort().join(",") !== "env,schemaVersion") fail();
    const value = frame as { schemaVersion: unknown; env: unknown };
    if (value.schemaVersion !== 1 || !value.env || typeof value.env !== "object" || Array.isArray(value.env) ||
        !Object.entries(value.env).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
          typeof item === "string" && !item.includes("\0"))) fail();
    if (profile) assertHostedFdFrameEnvironment(value.env as Record<string, string>);
    const submit = () => {
    const host = new HostedReadonlySupervisorHost();
    host.verifyRuntimeOwner();
    host.verifyReadonlyMaterial(host.readEpoch().identity);
    host.verifyDescriptorBoundary();
    const launch = readHostedReadonlyHostInventory().runtimeLaunch;
    const child = spawn(launch.command, [...launch.args], { cwd: launch.cwd,
      env: value.env as Record<string, string>, stdio: ["pipe", "inherit", "inherit"] });
    return child;
    };
    // The parent may still hold its release fence when stdin ends. Only genuine
    // acquisition Busy is retried; every failed authority check is terminal.
    const child = profile ? await retryHostedFenceAcquisition(() => withHostedActivationFence(submit),
      profile.limits.setupTimeoutMs - Number((process.hrtime.bigint() - began) / 1_000_000n)) : submit();
    child.stdin.end();
    child.stdin.on("error", () => fail());
    child.once("error", () => fail());
    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 70;
    });
  } catch { fail(); }
});
process.stdin.once("error", () => fail());
function fail(): never {
  process.stderr.write("hosted_custody_runtime_bootstrap_denied\n");
  process.exit(70);
}
