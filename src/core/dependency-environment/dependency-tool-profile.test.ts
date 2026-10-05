import { describe, expect, it } from "vitest";
import { parseDependencyToolRegistration, dependencyToolQualificationRecordName, DependencyToolTransformCache } from "./dependency-tool-profile";

describe("closed dependency tool registration", () => {
  it("registers exact workload selectors without admitting config or command arguments", () => {
    const input = { testFiles: ["checks/value.test.ts"], optimizerDependencies: ["picocolors", "@scope/library"],
      transformCache: DependencyToolTransformCache.Temporary };
    const registered = parseDependencyToolRegistration(input);
    input.testFiles.push("later.test.ts");
    expect(registered.testFiles).toEqual(["checks/value.test.ts"]);
    expect(Object.isFrozen(registered)).toBe(true);
    for (const changed of [
      { ...input, config: "vite.config.ts" },
      { ...input, testFiles: ["../outside.test.ts"] },
      { ...input, testFiles: ["**/*.test.ts"] },
      { ...input, optimizerDependencies: ["file:../outside"] },
      { ...input, optimizerDependencies: ["library/internal"] },
      { ...input, optimizerDependencies: ["picocolors", "picocolors"] },
      { ...input, transformCache: "custom" },
    ]) expect(() => parseDependencyToolRegistration(changed)).toThrow("dependency_tool_profile_invalid");
  });
  it("cannot select any protected record name other than the fixed actual-start format", () => {
    expect(dependencyToolQualificationRecordName("01234567-89ab-cdef-0123-456789abcdef"))
      .toBe("ordinary-invocations/n3-tools-01234567-89ab-cdef-0123-456789abcdef.json");
    for (const value of ["../host-installation", "job-id", "01234567-89ab-cdef-0123-456789abcdef/other", "01234567-89ab-cdef-0123-456789ABCDEF"]) {
      expect(() => dependencyToolQualificationRecordName(value)).toThrow();
    }
  });
});
