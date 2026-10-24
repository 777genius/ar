import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as coreContracts from "../../core/index";
import * as publicCore from "../../core-compatibility";
import * as recipes from "../app-server/adapters/system-bus-configuration";

it("preserves the public core exports while composing Host recipes outside core", () => {
  for (const [name, value] of Object.entries(coreContracts)) {
    expect(publicCore[name as keyof typeof publicCore], name).toBe(value);
  }
  expect(Object.keys(publicCore).filter(name => !(name in coreContracts)).sort())
    .toEqual(Object.keys(recipes).sort());
  for (const [name, value] of Object.entries(recipes)) {
    expect(publicCore[name as keyof typeof publicCore], name).toBe(value);
  }
});

it("retains the exact pinned installation bytes through the ownership move", () => {
  // Existing inventory pins bind these bytes. Relocating their owner must not
  // change XML whitespace, service fragments, or daemon argument ordering.
  const originalDigests = {
    SYSTEM_BUS_ARGUMENTS: "d55d44efcb99b2a1b1ec741574edf6714e9647b23ea183a3d7da26948b842ec3",
    SYSTEM_BUS_CONFIG: "e8937ef236fdfef29724c6af2bd3dcafaf5ff85d2d5f5c1a13a795c1320aa1a4",
    SYSTEM_BUS_SERVICE_FRAGMENT: "544ad032de62b23f16df1ccf7282852c507792ae166d41f06dd9b0a6ce954809",
    SYSTEM_BUS_SOCKET_FRAGMENT: "b8f3c5933b670e45d753c6383a1f15d92cf3dc2a0790846a2cc3601be968eabe",
  };
  for (const [name, expected] of Object.entries(originalDigests)) {
    const value = recipes[name as keyof typeof recipes];
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(expected);
  }
  expect(Object.isFrozen(recipes.SYSTEM_BUS_ARGUMENTS)).toBe(true);
});
