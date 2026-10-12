import { spawnSync } from "node:child_process";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { collectUnitNotFound } from "./hosted-readonly-linux-collector";
import { HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedManagedProviderTerminalFacts } from "./hosted-managed-provider-terminal-facts";
function invalid(): never { throw new Error("hosted_dependency_provider_terminal_unresolved"); }
/** Actual manager/queue/cgroup facts only, never caller status or a terminal grant. */
export function collectHostedManagedProviderDrain(unit: string) {
  const match = /^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit);
  if (!match || match[0] !== unit) invalid();
  let terminal: ReturnType<typeof parseHostedManagedProviderTerminalFacts> | undefined;
  if (!collectUnitNotFound(unit)) {
    const result = spawnSync("/usr/bin/systemctl",["show","--all","--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result","--",unit],
      {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:4096,
        env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
    if (result.error || result.status !== 0) invalid(); terminal = parseHostedManagedProviderTerminalFacts(unit,result.stdout);
  }
  const reservation = {unit,startId:match[1]!,creatorId:match[1]!,state:HostedCustodyReservationState.Reserved};
  const kernel = new HostedReadonlyHostKernel(); kernel.drainQueuedStart(reservation); kernel.confirmTerminalDescendants(reservation);
  return terminal;
}
