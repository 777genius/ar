import { describe, expect, it } from "vitest";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "@vioxen/subscription-runtime/core";
import { readHostedDependencyQualifiedToolEntry, readHostedDependencyQualifiedToolAdmission, type HostedDependencyQualifiedToolEntry } from "../hosted-dependency-tool-profile";

describe("private dependency tool entry", () => {
  // A regression accepting a structurally valid start label as the retained
  // qualifier relation would reach host/proof IO instead of this closed denial.
  // Positive entry/phase/source continuity needs the actual native TEST fixture.
  it("refuses a copied start label before it can select a protected baseline", () => {
    const copied: HostedDependencyQualifiedToolEntry = Object.freeze({ startId: "00000000-0000-4000-8000-000000000001" });
    for(const read of [readHostedDependencyQualifiedToolEntry,readHostedDependencyQualifiedToolAdmission]) {
    let failure: unknown;
    try { read(copied); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DependencyAdmissionError);
    if (!(failure instanceof DependencyAdmissionError)) throw new Error("missing closed entry denial");
    expect(failure.reason).toBe(DependencyAdmissionFailure.StaleAttempt);
    }
  });
});
