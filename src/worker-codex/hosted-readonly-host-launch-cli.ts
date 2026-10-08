import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertHostedProcessDescriptors } from "@vioxen/subscription-runtime/provider-codex";
import { runHostedOrdinaryBootstrap, runHostedRuntimeForeground, runHostedReadonlyCliForeground } from "./hosted-readonly-foreground";
import { readHostedInstallationActivation } from "./hosted-installation-activation";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { hostedForegroundExitCode } from "./hosted-foreground-result";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";

/** Existing host launchers enter here; no create-job, grant or mount options.
 * Legacy provider shims inside the already-contained outer namespace are not
 * new host admissions. Initial-host legacy execution is excluded in TEST mode. */
const [mode, separator, command, ...args] = process.argv.slice(2);
let writeFailure = mode !== "runtime";
try {
  if (mode === "ordinary-bootstrap") {
    if (separator !== undefined || command !== undefined || args.length) throw new Error();
    process.exitCode = await runHostedOrdinaryBootstrap();
  } else if (mode === "runtime") {
    // Failed/new profile selection must not write to an unverified inherited
    // sink. Valid legacy selection retains its existing diagnostic contract.
    writeFailure = readHostedFdProfile() === undefined;
    if (separator !== "--" || !command) throw new Error();
    if (readHostedInstallationActivation().activation.phase === HostedActivationPhase.Ordinary) {
      process.exitCode = hostedForegroundExitCode(await runHostedRuntimeForeground(command, args, process.cwd(), process.env));
    } else {
      const outcome = await runHostedReadonlyCliForeground(command, args, process.cwd(), process.env);
      process.exitCode = hostedForegroundExitCode(outcome.result);
      if (outcome.signal) process.kill(process.pid, outcome.signal);
    }
  } else {
  if (mode !== "legacy" || separator !== "--" || !command) throw new Error();
  const submit = () => spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  let failed = false;
  let child: ChildProcess;
    const map = (kind: string) => readFileSync(`/proc/self/${kind}_map`, "utf8").trim().replace(/\s+/g, " ");
    const status = readFileSync("/proc/self/status", "utf8");
    if (process.getuid?.() !== 65532 || process.getgid?.() !== 65532 || map("uid") !== "65532 0 1" ||
        map("gid") !== "65532 0 1" || !/^NoNewPrivs:\s+1$/m.test(status) ||
        ["Inh", "Prm", "Eff", "Bnd", "Amb"].some(set => !new RegExp(`^Cap${set}:\\s+0+$`, "m").test(status))) throw new Error();
    assertHostedProcessDescriptors();
    child = submit();
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = signals.map(signal => {
    const handler = () => { failed = true; process.exitCode = 70; child.kill(signal); };
    process.on(signal, handler);
    return handler;
  });
  const detach = () => signals.forEach((signal, index) => process.off(signal, handlers[index]!));
  child.once("error", () => {
    failed = true; detach();
    process.stderr.write("hosted_custody_launch_failed\n"); process.exitCode = 70;
  });
  child.once("exit", (code, signal) => {
    detach();
    if (signal) process.kill(process.pid, signal);
    else if (!failed && process.exitCode !== 70) process.exitCode = code ?? 70;
  });
  }
} catch {
  if (writeFailure) process.stderr.write("hosted_custody_launch_denied\n");
  process.exitCode = 70;
}
