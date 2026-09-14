import { vi } from "vitest";

// Temporary-workspace runner cases model an unmanaged Linux host, independently
// of the installed launcher and inherited environment. Keep real admission;
// supply host discovery through its existing dependency port only in tests.
vi.mock("../managed-goal-admission", async original => {
  const actual = await original<typeof import("../managed-goal-admission")>();
  return { ...actual, admitManagedGoal: (input: Parameters<typeof actual.admitManagedGoal>[0]) =>
    actual.admitManagedGoal({ ...input, config: { ...input.config, sourceEnv: input.config.sourceEnv ?? {} } },
      { platform: "linux", isManagedHost: async () => false }) };
});
