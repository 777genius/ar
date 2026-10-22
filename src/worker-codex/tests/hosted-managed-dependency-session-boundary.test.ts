import { CodexJsonAgentDriver } from "../../provider-codex/codex-json-agent-driver";
import type { SessionExecutionUse } from "@vioxen/subscription-runtime/core";
import { HostedFdLaunch } from "../../provider-codex/app-server/adapters/hosted-fd-launch";
import { writeCurrentHostedManagedDependencyProviderView } from "../hosted-current-dependency-origin";
import type { CodexAppServerChildProcess } from "../../provider-codex/app-server/application/app-server-process-port";
import { describe, expect, it } from "vitest";
import { parseHostedManagedProviderTerminalFacts, matchesManagedProviderProxyWait } from "../hosted-managed-provider-terminal-facts";
import { writeCurrentHostedDependencySessionAuth, snapshotCurrentHostedDependencySessionAuth, assertCurrentHostedDependencySessionLeaseDischarged,
  spawnCurrentHostedDependencySessionRefresh, readCurrentHostedDependencyHomePreparation, type CurrentHostedDependencySessionHome } from "../hosted-current-dependency-origin";
import { OriginalHostedDependencySessionHome } from "../hosted-managed-dependency-home-view";
import { OriginalHostedDependencyRootDescriptor } from "../hosted-dependency-root-resource-view";
import type { CurrentHostedDependencyOrigin } from "../hosted-current-dependency-origin";
import type { HostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import type { HostedDependencyRootDescriptorMaterial } from "../../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
const unit = "subscription-runtime-hosted-00000000-0000-0000-0000-000000000001.service", invocation = "a".repeat(32);
function manager(code:string,status:string,result:string) {
  return `Id=${unit}\nInvocationID=${invocation}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=${code}\nExecMainStatus=${status}\nResult=${result}\n`;
}
// Red if cancelled/signalled provider status is guessed as 128+signal, if a
// malformed/nonterminal manager record is accepted, or caller objects reach IO.
// Manager positives here are data only; no test constructs a host purpose grant.
describe("managed provider terminal facts", () => {
  it("uses v255 exception255 for a killed service and exact exit status otherwise", () => {
    const killed = parseHostedManagedProviderTerminalFacts(unit,manager("2","15","signal"));
    expect(matchesManagedProviderProxyWait(killed,invocation,255)).toBe(true);
    expect(matchesManagedProviderProxyWait(killed,invocation,143)).toBe(false);
    const exited = parseHostedManagedProviderTerminalFacts(unit,manager("1","143","exit-code"));
    expect(matchesManagedProviderProxyWait(exited,invocation,143)).toBe(true);
    expect(matchesManagedProviderProxyWait(exited,"b".repeat(32),143)).toBe(false);
    expect(matchesManagedProviderProxyWait(undefined,invocation,0)).toBe(true);
    expect(matchesManagedProviderProxyWait(undefined,invocation,1)).toBe(false);
  });
  it.each([
    manager("1","256","exit-code"),manager("3","15","signal"),manager("2","15","success"),
    manager("1","0","exit-code"),manager("1","1","success"),manager("1","1","timeout"),
    manager("1","1","exit-code").replace("MainPID=0","MainPID=41"),
    manager("1","1","exit-code").replace("Job=","Job=88"),
    manager("1","1","exit-code")+"InvocationID="+invocation+"\n",
    manager("1","1","exit-code").replace("ExecMainStatus=1\n","ExecMainStatus=1\r\n"),
  ])("refuses unknown, ambiguous or still-active manager data", text => {
    expect(() => parseHostedManagedProviderTerminalFacts(unit,text)).toThrow();
  });
  it("refuses a service name with a trailing newline", () => {
    expect(() => parseHostedManagedProviderTerminalFacts(unit+"\n",manager("1","1","exit-code"))).toThrow();
  });
});
describe("sole original home and resource identity", () => {
  it("rejects caller Symbols before reading material or invoking an auth/config writer", () => {
    let fields = 0;
    const origin = Object.defineProperty({},"state",{get() { fields++; throw new Error("caller state"); }}) as CurrentHostedDependencyOrigin;
    const fence = Object.defineProperty({},"held",{get() { fields++; throw new Error("caller fence"); }}) as HostedActivationFence;
    const home: CurrentHostedDependencySessionHome = new OriginalHostedDependencySessionHome(origin,Symbol("caller"));
    const material = Object.defineProperty({},"fd",{get() { fields++; throw new Error("caller fd"); }}) as HostedDependencyRootDescriptorMaterial;
    const resource = new OriginalHostedDependencyRootDescriptor(origin,material,Symbol("caller"));
    expect(() => readCurrentHostedDependencyHomePreparation(home,fence)).toThrow();
    expect(() => spawnCurrentHostedDependencySessionRefresh(home,fence,unit)).toThrow();
    expect(() => resource.fd).toThrow(); expect(() => resource.close()).toThrow();
    expect(() => writeCurrentHostedDependencySessionAuth(home,"caller auth")).toThrow();
    expect(() => snapshotCurrentHostedDependencySessionAuth(home)).toThrow();
    expect(() => assertCurrentHostedDependencySessionLeaseDischarged(home)).toThrow();
    expect(fields).toBe(0);
    expect(Object.isFrozen(OriginalHostedDependencySessionHome)).toBe(true);
    expect(Object.isFrozen(OriginalHostedDependencyRootDescriptor)).toBe(true);
  });
});

// Red if borrowed/fabricated physical receivers or unregistered views can touch
// streams. These are refusal checks, never a simulated positive host authority.
describe("fixed provider input receivers", () => {
  it("refuses fabricated FDA receivers before reading physical stream fields", () => {
    let fields = 0;
    const fake = Object.create(HostedFdLaunch.prototype) as HostedFdLaunch;
    for (const name of ["child","input","released"]) Object.defineProperty(fake,name,{get() { fields++; throw new Error("caller stream"); }});
    Object.defineProperty(fake,"assertProviderInputReceiver",{value:() => undefined});
    expect(() => HostedFdLaunch.prototype.writeReleasedProviderInput.call(fake,"bytes")).toThrow();
    expect(() => HostedFdLaunch.prototype.awaitReleasedProviderInput.call(fake)).toThrow();
    expect(() => HostedFdLaunch.prototype.providerInputByteLimit.call(fake)).toThrow();
    expect(fields).toBe(0);
    expect(Object.isFrozen(HostedFdLaunch)).toBe(true);
    expect(Object.isFrozen(HostedFdLaunch.prototype)).toBe(true);
  });
  it("refuses foreign SDK views before accessing their streams or accepting end", () => {
    let fields = 0;
    const view = Object.defineProperty({},"stdin",{get() { fields++; throw new Error("caller stdin"); }}) as CodexAppServerChildProcess;
    const origin = Object.freeze({}) as CurrentHostedDependencyOrigin;
    expect(() => writeCurrentHostedManagedDependencyProviderView(origin,view,"bytes")).toThrow();
    expect(() => writeCurrentHostedManagedDependencyProviderView(origin,view)).toThrow();
    expect(fields).toBe(0);
  });
});

// Red if caller-visible TS-private cache/status properties can supply retained-use or writeback facts.
it("refuses fabricated driver cache receivers before reading caller state", () => {
  let reads = 0; const fake = Object.create(CodexJsonAgentDriver.prototype) as CodexJsonAgentDriver;
  for (const name of ["managedRunSessions","sessionExecutionOutcome"]) Object.defineProperty(fake,name,{get() { reads++; throw new Error("caller cache"); }});
  const use = Object.freeze({}) as SessionExecutionUse;
  expect(() => CodexJsonAgentDriver.prototype.retainedSessionExecutionUse.call(fake,"run")).toThrow();
  expect(() => CodexJsonAgentDriver.prototype.retainsSessionExecutionUse.call(fake,use)).toThrow();
  expect(() => CodexJsonAgentDriver.prototype.sessionExecutionNeedsWriteback.call(fake,use)).toThrow();
  expect(reads).toBe(0); expect(Object.isFrozen(CodexJsonAgentDriver.prototype)).toBe(true);
});
