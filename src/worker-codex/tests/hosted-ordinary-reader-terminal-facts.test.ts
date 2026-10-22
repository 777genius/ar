import { describe, expect, it } from "vitest";
import { parseHostedOrdinaryReaderTerminalFacts, parseHostedManagedProviderTerminalFacts,
  matchesManagedProviderProxyWait, HostedManagedProviderWaitKind } from "../hosted-managed-provider-terminal-facts";

const unit="subscription-runtime-ordinary-12345678-1234-1234-1234-123456789abc.service";
const invocation="1234567890abcdef1234567890abcdef";
const observed=(code:number,status:number,result:string)=>`Id=${unit}\nInvocationID=${invocation}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=${code}\nExecMainStatus=${status}\nResult=${result}\n`;

describe("fixed Ordinary-reader manager outcome facts",()=>{
  // A parser that treats every nonzero outcome as permanently held, broadens
  // the old managed unit grammar, or invents 128+signal will fail these cases.
  it("preserves truthful nonzero exit without accepting ordinary units in the old provider parser",()=>{
    const facts=parseHostedOrdinaryReaderTerminalFacts(unit,observed(1,143,"exit-code"));
    expect(facts.kind).toBe(HostedManagedProviderWaitKind.Exited);
    expect(matchesManagedProviderProxyWait(facts,invocation,143)).toBe(true);
    expect(matchesManagedProviderProxyWait(facts,"0".repeat(32),143)).toBe(false);
    expect(()=>parseHostedManagedProviderTerminalFacts(unit,observed(1,143,"exit-code"))).toThrow();
  });
  it("joins actual systemd255 signal proxy mapping rather than generic 128+signal",()=>{
    const facts=parseHostedOrdinaryReaderTerminalFacts(unit,observed(2,15,"signal"));
    expect(matchesManagedProviderProxyWait(facts,invocation,255)).toBe(true);
    expect(matchesManagedProviderProxyWait(facts,invocation,143)).toBe(false);
  });
  it("refuses live, queued, wrong-unit and incoherent outcome facts",()=>{
    const bytes=observed(1,1,"exit-code");
    expect(()=>parseHostedOrdinaryReaderTerminalFacts(unit,bytes.replace("MainPID=0","MainPID=1"))).toThrow();
    expect(()=>parseHostedOrdinaryReaderTerminalFacts(unit,bytes.replace("Job=","Job=1"))).toThrow();
    expect(()=>parseHostedOrdinaryReaderTerminalFacts(unit,bytes.replace(`Id=${unit}`,"Id=foreign.service"))).toThrow();
    expect(()=>parseHostedOrdinaryReaderTerminalFacts(unit,observed(1,1,"success"))).toThrow();
    expect(()=>parseHostedOrdinaryReaderTerminalFacts(unit+"\n",bytes)).toThrow();
  });
});
