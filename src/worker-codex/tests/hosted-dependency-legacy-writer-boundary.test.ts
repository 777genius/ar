import { describe, it, expect } from "vitest";
import { runDependencyBootstrap } from "../dependency-bootstrap";
import { inspectNodeDependencyEnvironment, sanitizeNodeDependencyEnvironment } from "../dependency-environment-safety";
import { withDependencyBootstrapWorkspaceTransaction } from "../dependency-bootstrap-workspace-transaction";

// Regression: an accessor/proxy must not run while selecting a legacy writer,
// including before its first project read, arbitrary runner or action callback.
// These refusal cases issue no hosted purpose and simulate no positive origin.
describe("legacy dependency writer input boundary",()=>{
  for(const invoke of [
    (input:{workspacePath:string})=>runDependencyBootstrap(input),
    inspectNodeDependencyEnvironment,
    sanitizeNodeDependencyEnvironment,
  ]) {
    it("rejects accessors without evaluating caller workspace or iterator",async()=>{
      let reads=0;
      const input={get workspacePath(){reads++;throw new Error("unexpected_getter");}};
      await expect(invoke(input)).rejects.toThrow();expect(reads).toBe(0);
      const proxy=new Proxy({workspacePath:"/unused"},{get(){reads++;throw new Error("unexpected_proxy");},getOwnPropertyDescriptor(){reads++;throw new Error("unexpected_descriptor");}});
      await expect(invoke(proxy)).rejects.toThrow();expect(reads).toBe(0);
    });
  }
  it("transaction refuses before workspace getter and action",async()=>{
    let reads=0,actions=0;
    const input={get workspacePath(){reads++;throw new Error("unexpected_getter");},action:async()=>{actions++;return 1;}};
    await expect(withDependencyBootstrapWorkspaceTransaction(input)).rejects.toThrow();
    expect(reads).toBe(0);expect(actions).toBe(0);
  });
});
