import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertHostedProcessDescriptors } from "@vioxen/subscription-runtime/provider-codex";
import { runHostedOrdinaryBootstrap, runHostedRuntimeForeground } from "./hosted-readonly-foreground";
import { readHostedInstallationActivation } from "./hosted-installation-activation";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";

/** Existing host launchers enter here; no create-job, grant or mount options.
 * Legacy provider shims inside the already-contained outer namespace are not
 * new host admissions. Initial-host legacy execution is excluded in TEST mode. */
const [mode, separator, command, ...args] = process.argv.slice(2);
try {
  if (mode === "ordinary-bootstrap") {
    if (separator !== undefined || command !== undefined || args.length) throw new Error();
    process.exitCode = await runHostedOrdinaryBootstrap();
  } else if (mode === "runtime" && readHostedInstallationActivation().activation.phase === HostedActivationPhase.Ordinary) {
    if (separator !== "--" || !command) throw new Error();
    process.exitCode = await runHostedRuntimeForeground(command, args, process.cwd(), process.env);
  } else {
  if ((mode !== "runtime" && mode !== "legacy") || separator !== "--" || !command) throw new Error();
  const submit = () => spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  let failed = false;
  let child: ChildProcess;
  let host: HostedReadonlySupervisorHost | undefined;
  if (mode === "runtime") {
    host = new HostedReadonlySupervisorHost();
    const frame = Buffer.from(JSON.stringify({ schemaVersion: 1, env: process.env }));
    if (frame.length > 4 * 1024 * 1024) throw new Error();
    child = host.runRuntimeLaunch(command, args, process.cwd(), launch => {
      const processChild = spawn(launch.command, [...launch.args], { cwd: process.cwd(), env: process.env,
        stdio: ["pipe", "inherit", "inherit"] });
      processChild.stdin.on("error", () => {
        failed = true; process.exitCode = 70; closeAdmission(); processChild.kill("SIGTERM");
      });
      processChild.stdin.end(frame);
      return processChild;
    });
  } else {
    const map = (kind: string) => readFileSync(`/proc/self/${kind}_map`, "utf8").trim().replace(/\s+/g, " ");
    const status = readFileSync("/proc/self/status", "utf8");
    if (process.getuid?.() !== 65532 || process.getgid?.() !== 65532 || map("uid") !== "65532 0 1" ||
        map("gid") !== "65532 0 1" || !/^NoNewPrivs:\s+1$/m.test(status) ||
        ["Inh", "Prm", "Eff", "Bnd", "Amb"].some(set => !new RegExp(`^Cap${set}:\\s+0+$`, "m").test(status))) throw new Error();
    assertHostedProcessDescriptors();
    child = submit();
  }
  const closeAdmission = () => {
    try { host?.closeRuntimeLaunch(); }
    catch { failed = true; process.stderr.write("hosted_custody_runtime_reconciliation_required\n"); process.exitCode = 70; }
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = signals.map(signal => {
    const handler = () => { failed = true; process.exitCode = 70; closeAdmission(); child.kill(signal); };
    process.on(signal, handler);
    return handler;
  });
  const detach = () => signals.forEach((signal, index) => process.off(signal, handlers[index]!));
  child.once("error", () => {
    failed = true; closeAdmission(); detach();
    process.stderr.write("hosted_custody_launch_failed\n"); process.exitCode = 70;
  });
  child.once("exit", (code, signal) => {
    if (host && !failed && code === 0 && signal === null) {
      try { host.recordRuntimeWaitCompletion(); }
      catch { failed = true; process.stderr.write("hosted_custody_runtime_reconciliation_required\n"); process.exitCode = 70; }
    }
    closeAdmission(); detach();
    if (signal) process.kill(process.pid, signal);
    else if (process.exitCode !== 70) process.exitCode = code ?? 70;
  });
  }
} catch {
  process.stderr.write("hosted_custody_launch_denied\n");
  process.exitCode = 70;
}
