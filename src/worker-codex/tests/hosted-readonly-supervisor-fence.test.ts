import { expect, it, vi } from "vitest";
import { HostedReadonlySupervisorHost } from "../hosted-readonly-supervisor-host";
import { HostedReadonlyHostKernel } from "../hosted-readonly-host-kernel";

// This is a fail-closed composition regression, not a positive Root fixture.
// Keep the kernel implementation intact; an unheld store fence must reject
// before any inventory/process inspection can run.
it("inventory verification requires the actual store-held fence before kernel inspection", () => {
  const kernel = vi.spyOn(HostedReadonlyHostKernel.prototype, "verifyExclusiveInventory");
  try {
    const host = new HostedReadonlySupervisorHost();
    expect(() => host.verifyExclusiveInventory()).toThrow("hosted_custody_common_fence_required");
    expect(kernel).not.toHaveBeenCalled();
  } finally { kernel.mockRestore(); }
});
