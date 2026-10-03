import { vi } from "vitest";

// Portable unmanaged TEST fixtures explicitly have no readonly policy, custody
// lease or revocation. Substitute private-record facts, retaining admission
// decisions. Installed authority and unsafe ancestry use independent fixtures.
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedReadonlyPolicy: () => null,
  readHostedPrivateBytes: () => null,
}));
