import { expect, it } from "vitest";
import { runInThisContext } from "node:vm";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "../hosted-current-dependency-origin";
import { codexGoalOriginDiagnostic, decodeCodexGoalOriginDiagnostic, CodexGoalOriginReason as Reason,
  CodexGoalOriginModule as Module, CodexGoalOriginFormat as Format } from "../codex-goal-origin-diagnostic";

const location = { module: Module.Current, format: Format.Emitted, line: 160, column: 9 };
const error = (reason = Reason.Current, stack = "Error\n at invalid (/PRIVATE_CANARY/hosted-current-dependency-origin.js:160:9)") => {
  const value = new Error(reason); Object.defineProperty(value, "stack", { value: stack }); return value;
};
it("captures actual native Error stacks from the source guard and an emitted JavaScript frame", () => {
  let actual: unknown;
  try { assertOriginalHostedDependencyPhysicalRecordAccess(Symbol("TEST wrong access")); }
  catch (caught) { actual = caught; }
  const source = codexGoalOriginDiagnostic(actual);
  expect(source?.reason).toBe(Reason.Current);
  expect(source?.locations).toContainEqual({ module: Module.Current, format: Format.Source,
    line: expect.any(Number), column: expect.any(Number) });
  // Same-realm native Error creation, with no replacement of its stack descriptor.
  const emitted: unknown = runInThisContext(`new Error(${JSON.stringify(Reason.Current)})`,
    { filename: "/TEST/hosted-current-dependency-origin.js" });
  expect(codexGoalOriginDiagnostic(emitted)).toEqual({ reason: Reason.Current,
    locations: [{ module: Module.Current, format: Format.Emitted, line: 1, column: 1 }] });
});
it("emits only the two closed reasons and static source/emitted coordinates", () => {
  for (const reason of Object.values(Reason)) {
    const diagnostic = codexGoalOriginDiagnostic(error(reason,
      "Error PRIVATE_CANARY\n at secret (/PRIVATE_CANARY/hosted-current-dependency-origin.js:160:9)\n at private (/auth-secret.js:1:2)\n at source (/PRIVATE_CANARY/hosted-dependency-current-facts.ts:55:7)"));
    expect(diagnostic).toEqual({ reason, locations: [location, { module: Module.CurrentFacts, format: Format.Source, line: 55, column: 7 }] });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_CANARY");
    expect(decodeCodexGoalOriginDiagnostic(JSON.stringify(diagnostic))).toEqual(diagnostic);
  }
  expect(codexGoalOriginDiagnostic(new Error("Bearer PRIVATE_CANARY"))).toBeUndefined();
  expect(codexGoalOriginDiagnostic(new Error(Reason.Current + ":PRIVATE_CANARY"))).toBeUndefined();
  expect(codexGoalOriginDiagnostic({ message: Reason.Current, stack: "PRIVATE_CANARY" })).toBeUndefined();
});
it("bounds stack rows, bytes, coordinates and exported locations without invoking foreign accessors", () => {
  const row = " at invalid (/private/hosted-current-dependency-origin.js:999999:1)";
  expect(codexGoalOriginDiagnostic(error(Reason.Current, "Error\n" + Array(40).fill(row).join("\n")))?.locations).toHaveLength(8);
  expect(codexGoalOriginDiagnostic(error(Reason.Current, "Error\n" + Array(16).fill(" unknown").join("\n") + "\n" + row))?.locations).toEqual([]);
  expect(codexGoalOriginDiagnostic(error(Reason.Current, "Error\n" + "x".repeat(8192) + "\n" + row))?.locations).toEqual([]);
  expect(codexGoalOriginDiagnostic(error(Reason.Current, "Error\n" + "é".repeat(4095) + "\n" + row))?.locations).toEqual([]);
  for (const coordinate of ["0:2", "1:0", "1234567:1", "1:1234567", "-1:2", "01:2"]) {
    expect(codexGoalOriginDiagnostic(error(Reason.Current, "Error\n at x (/private/hosted-current-dependency-origin.js:" + coordinate + ")"))?.locations).toEqual([]);
  }
  let calls = 0; const foreign = new Error(Reason.Current);
  Object.defineProperty(foreign, "stack", { get() { calls++; throw new Error("PRIVATE_CANARY"); } });
  expect(codexGoalOriginDiagnostic(foreign)).toEqual({ reason: Reason.Current, locations: [] });
  Object.defineProperty(foreign, "message", { get() { calls++; throw new Error("PRIVATE_CANARY"); } });
  expect(codexGoalOriginDiagnostic(foreign)).toBeUndefined();
  expect(codexGoalOriginDiagnostic(new Proxy(foreign, { get() { calls++; throw new Error("PRIVATE_CANARY"); } }))).toBeUndefined();
  expect(calls).toBe(0);
});
it("rejects noncanonical, expanded, unknown and unbounded diagnostic wire data", () => {
  const valid = { reason: Reason.Current, locations: [location] };
  for (const value of [{ ...valid, private: "PRIVATE_CANARY" }, { ...valid, reason: "PRIVATE_CANARY" },
    { ...valid, locations: Array(9).fill(location) }, { ...valid, locations: [{ ...location, module: "/PRIVATE_CANARY" }] },
    { ...valid, locations: [{ ...location, format: "PRIVATE_CANARY" }] }, { ...valid, locations: [{ ...location, line: 0 }] },
    { ...valid, locations: [{ ...location, column: 1000000 }] }, { ...valid, locations: [{ ...location, line: "160" }] },
    { ...valid, locations: [{ ...location, private: "PRIVATE_CANARY" }] }]) {
    expect(decodeCodexGoalOriginDiagnostic(JSON.stringify(value))).toBeUndefined();
  }
  const text = JSON.stringify(valid);
  for (const changed of [" " + text, text.replace('"reason":', '"reason":"PRIVATE_CANARY","reason":'), "x".repeat(4097)])
    expect(decodeCodexGoalOriginDiagnostic(changed)).toBeUndefined();
});
