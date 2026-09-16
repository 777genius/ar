import { vi } from "vitest";

// Existing runner fixtures have no host authorization and must never inspect host grants.
vi.mock("../hosted-test-egress-admission", async () => {
  const { codexProviderApiEgressPolicy } = await import("@vioxen/subscription-runtime/provider-codex");
  const actual = await vi.importActual<typeof import("../hosted-test-egress-admission")>("../hosted-test-egress-admission");
  return { ...actual, admitHostedTestEgress: async () => codexProviderApiEgressPolicy() };
});
