import assert from "node:assert/strict";
import { test } from "node:test";
import { ownedOsScenarios, OwnedOsMode, OwnedOsScenario } from "./common.ts";

test("default qualification keeps both fresh roots; closure gate selects only readonly", () => {
  assert.deepEqual(ownedOsScenarios(OwnedOsMode.Qualification), [OwnedOsScenario.Dependency, OwnedOsScenario.Readonly]);
  assert.deepEqual(ownedOsScenarios(OwnedOsMode.ReadonlyLauncher), [OwnedOsScenario.Readonly]);
  assert.deepEqual(ownedOsScenarios(OwnedOsMode.BusDiagnostic), [OwnedOsMode.BusDiagnostic]);
  assert.throws(() => ownedOsScenarios("readonly" as OwnedOsMode), /unknown owned OS TEST mode/);
  const selected = ownedOsScenarios(OwnedOsMode.ReadonlyLauncher);
  assert(Object.isFrozen(selected));
  assert.throws(() => (selected as OwnedOsScenario[]).push(OwnedOsScenario.Dependency), TypeError);
});
