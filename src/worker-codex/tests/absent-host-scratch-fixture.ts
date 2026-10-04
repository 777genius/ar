import { vi } from "vitest";

// These portable TEST fixtures have no installed scratch policy. Substitute
// only policy absence; never inspect or activate the machine's real mounts.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, lstatSync: ((path, ...args) => {
    if (path === "/etc/subscription-runtime/scratch-temp.json") {
      throw Object.assign(new Error("TEST scratch policy absent"), { code: "ENOENT" });
    }
    return Reflect.apply(real.lstatSync, real, [path, ...args]);
  }) as typeof real.lstatSync };
});
