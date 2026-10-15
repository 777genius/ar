import { expect, it } from "vitest";
import type { CurrentHostedDependencyOrigin } from "../hosted-current-dependency-origin";
import type { DependencyAttempt } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedDependencyKeyInputs } from "../hosted-dependency-materialization-context";
import type { HostedDependencyColdReady } from "../hosted-dependency-cold-materialization-state";

// Old defining-module dispatch remained mutable until origin loaded, allowing
// this finite replacement to capture its lexical symbol. No root permit is
// invented: the actual runtime dispatch must refuse replacement first.
it("freezes the cold view before original issuer import and rejects unissued views before IO",async()=>{
  const {OriginalHostedDependencyColdHandoff:View}=await import("../hosted-dependency-cold-handoff-view");
  let calls=0;
  const replacement=()=>{calls++;throw new Error("TEST unexpected mutable dispatch");};
  expect(Reflect.set(View,"resolve",replacement)).toBe(false);
  expect(Object.isFrozen(View.prototype)).toBe(true);
  const origin=await import("../hosted-current-dependency-origin");
  let getters=0;
  const fakeOrigin=new Proxy({}, {get(){getters++;throw new Error("TEST caller getter executed");}}) as CurrentHostedDependencyOrigin;
  await expect(origin.materializeCurrentHostedDependencyColdTree(fakeOrigin)).rejects.toMatchObject({reason:"stale_attempt"});
  await expect(origin.installCurrentHostedDependencyColdTree(fakeOrigin,Symbol("TEST unissued access"))).rejects.toMatchObject({reason:"stale_attempt"});
  // Constructing a lookalike with an own symbol gives no original-map entry.
  const unissued=new View("TEST-start",fakeOrigin,Symbol("TEST own access"));
  const callbackObject=new Proxy({}, {get(){getters++;throw new Error("TEST DTO getter executed");}});
  expect(()=>origin.consumeCurrentHostedDependencyColdHandoff(unissued,
    callbackObject as HostedDependencyBinding,callbackObject as DependencyAttempt,
    callbackObject as HostedDependencyKeyInputs,callbackObject as HostedDependencyColdReady)).toThrowError("dependency_admission:stale_attempt");
  origin.closeCurrentHostedDependencyColdHandoff(unissued);
  expect(calls).toBe(0);expect(getters).toBe(0);
});
