import { describe, expect, it } from "vitest";
import { FileBackendClaudeWorker, resolveFileBackendClaudeWorkerOptions } from "../file-backend-claude-worker";

const worker = { providerInstanceId: "TEST-storage",
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", baseEnv: {} };

describe("standalone Claude storage composition", () => {
  it("retains config defaults under the selected state and preserves explicit config overrides", () => {
    const derived = resolveFileBackendClaudeWorkerOptions({ ...worker, storageRootDir: "/external/runtime" });
    expect(derived.stateRootDir).toBe("/external/runtime/state/claude-workers");
    const legacy = new FileBackendClaudeWorker({ ...worker, storageRootDir: "/external/runtime",
      stateRootDir: "/legacy/state" });
    expect(legacy.configDir.startsWith("/legacy/state/claude-configs/")).toBe(true);
    const explicit = new FileBackendClaudeWorker({ ...worker, storageRootDir: "/external/runtime",
      configDir: "/explicit/config" });
    expect(explicit.configDir).toBe("/explicit/config");
  });

  it("validates a selected root even with explicit state before adapter construction", () => {
    expect(() => new FileBackendClaudeWorker({ ...worker, storageRootDir: "/external\0/root",
      stateRootDir: "/legacy/state" })).toThrow("Invalid runtime storageRootDir");
  });
});
