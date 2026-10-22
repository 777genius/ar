import { describe, expect, it } from "vitest";
import { readBoundedObservedSessionModelPage } from "../hosted-managed-dependency-model-probe";
// Red if the positive collector iterates oversized raw pages before applying limits,
// silently drops malformed rows, or treats a partially parsed response as a usable candidate catalog.
describe("bounded observed session model catalog", () => {
  it("keeps the exact external model identifier as an observed candidate", () => {
    expect(readBoundedObservedSessionModelPage({data:[{model:"gpt-6.1-sol"}],nextCursor:null},0).data.map(row => row.model)).toEqual(["gpt-6.1-sol"]);
  });
  it("denies oversized pages before reading an entry", () => {
    let touched = 0; const data = Array.from({length:101},() => Object.defineProperty({},"model",{get() { touched++; return "gpt-6.1-sol"; }}));
    expect(() => readBoundedObservedSessionModelPage({data},0)).toThrow(); expect(touched).toBe(0);
  });
  it.each([
    {data:[{model:"gpt-6.1-sol"},{}]},
    {data:[{model:"gpt-6.1-sol",supportedReasoningEfforts:Array.from({length:17},() => ({reasoningEffort:"high"}))}]},
  ])("refuses partial or oversized entry parsing", ({data}) => {
    expect(() => readBoundedObservedSessionModelPage({data},0)).toThrow();
  });
  it("applies total budget before parsing further entries and bounds the cursor", () => {
    expect(() => readBoundedObservedSessionModelPage({data:[{model:"gpt-6.1-sol"}]},500)).toThrow();
    expect(() => readBoundedObservedSessionModelPage({data:[{model:"gpt-6.1-sol"}],nextCursor:"x".repeat(513)},0)).toThrow();
  });
});
