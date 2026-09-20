import { fileURLToPath } from "node:url";

export enum TrustedCustodyLaunchRole { Outer = "outer", Ordinary = "ordinary" }

/** Custody services retain their independent authority/cgroup contract. This
 * adapter accepts no executable, payload, environment or systemd properties. */
export function trustedCustodySystemdLaunch(role: TrustedCustodyLaunchRole, startId: string, cwd: string):
  { command: string; args: readonly string[] } {
  if (!/^[a-f0-9-]{36}$/.test(startId) || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(cwd)) {
    throw new Error("hosted_custody_kernel_evidence_invalid");
  }
  let bootstrap: readonly string[];
  switch (role) {
    case TrustedCustodyLaunchRole.Outer:
      bootstrap = [fileURLToPath(new URL("./hosted-readonly-runtime-bootstrap.js", import.meta.url))];
      break;
    case TrustedCustodyLaunchRole.Ordinary:
      bootstrap = [fileURLToPath(new URL("./hosted-readonly-host-launch-cli.js", import.meta.url)), "ordinary-bootstrap"];
      break;
    default: throw new Error("hosted_custody_kernel_evidence_invalid");
  }
  return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", "--collect",
    `--unit=subscription-runtime-${role}-${startId}.service`, "--service-type=exec",
    "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes", "--property=Delegate=no", `--working-directory=${cwd}`,
    "--", process.execPath, ...bootstrap] };
}
