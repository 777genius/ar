import { describe, expect, it } from "vitest";
import { hostedReadonlyOperatorDiagnostic, HostedReadonlyOperatorReason, HostedReadonlyOperatorSource } from "../hosted-readonly-operator-diagnostic";

describe("readonly operator failure diagnostics", () => {
  it("retains a known failure and source coordinates while excluding arbitrary messages and paths", () => {
    const error = new Error(HostedReadonlyOperatorReason.CustodyEnrollmentMismatch);
    error.stack = "Error: private header\n    at invalid (/private/secret/hosted-readonly-epoch-store.js:24:6)\n    at secret (/private/auth-secret.js:1:9)";
    expect(hostedReadonlyOperatorDiagnostic(error)).toEqual({
      reason: HostedReadonlyOperatorReason.CustodyEnrollmentMismatch,
      locations: [{ file: HostedReadonlyOperatorSource.EpochStore, line: 24, column: 6 }],
    });
    const arbitrary = new Error("Bearer TEST-secret auth.json /private/secret");
    arbitrary.stack = "Error: Bearer TEST-secret\n    at secret (/private/auth-secret.js:1:9)";
    expect(hostedReadonlyOperatorDiagnostic(arbitrary)).toEqual({ reason: HostedReadonlyOperatorReason.Unknown, locations: [] });
  });

  it("bounds coordinates, stack rows and published locations", () => {
    const error = new Error(HostedReadonlyOperatorReason.ActivationEvidenceInvalid);
    error.stack = "Error\n    at invalid (/private/hosted-readonly-host-kernel.js:0:3)\n    at invalid (/private/hosted-readonly-host-kernel.js:1234567:3)\n" +
      Array.from({ length: 50 }, () => "    at invalid (/private/hosted-readonly-host-kernel.js:42:7)").join("\n");
    const diagnostic = hostedReadonlyOperatorDiagnostic(error);
    expect(diagnostic.locations).toHaveLength(8);
    expect(diagnostic.locations.every(location => location.file === HostedReadonlyOperatorSource.HostKernel && location.line === 42 && location.column === 7)).toBe(true);
    expect(hostedReadonlyOperatorDiagnostic({ message: "TEST-secret", stack: "TEST-secret" })).toEqual({ reason: HostedReadonlyOperatorReason.Unknown, locations: [] });
  });
});
