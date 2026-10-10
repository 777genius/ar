import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createResearchProviderBootstrapDiagnostics, observeResearchProviderBootstrapDiagnostics } from "../research-provider-bootstrap-diagnostics";

it("retains finite split markers and drops arbitrary stderr, secret fields and oversized lines", () => {
  const warnings: unknown[] = [];
  const decoder = createResearchProviderBootstrapDiagnostics(w => warnings.push(w));
  decoder.push("API_KEY=TEST-secret\nresearch_root_transition_failed phase=pi");
  decoder.push("vot code=70\r\n");
  decoder.push("research_root_transition_failed phase=secret code=70\n");
  decoder.push("research_root_transition_failed phase=pivot code=999\n");
  decoder.push("x".repeat(9000) + "research_root_transition_failed phase=pivot code=70\n");
  const assembly = { event: "research_provider_root_assembly_failed", legacyCode: "unclassified", cause: "TEST-secret", diagnostic: "TEST-secret", assemblyLine: 82, assemblyColumn: 4 };
  decoder.push(JSON.stringify({ ...assembly, secret: "TEST-secret" }) + "\n");
  decoder.push(JSON.stringify({ ...assembly, assemblyLine: -1 }) + "\n");
  decoder.push(JSON.stringify(assembly)); decoder.finish();
  expect(warnings).toEqual([
    "research_root_transition_failed phase=pivot code=70",
    "research_provider_root_assembly_failed legacyCode=unclassified assemblyLine=82 assemblyColumn=4",
  ]);
  expect(JSON.stringify(warnings)).not.toContain("TEST-secret");
});

it("publishes a split marker after process exit without depending on exit or client lifetime", () => {
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  const published: string[] = [];
  observeResearchProviderBootstrapDiagnostics(stderr, message => published.push(message));
  stderr.emit("data", "research_root_transition_failed phase=detach-");
  child.emit("exit", 70);
  expect(published).toEqual([]);
  stderr.emit("data", "old-root code=70");
  stderr.emit("end");
  expect(published).toEqual(["research_root_transition_failed phase=detach-old-root code=70"]);
});

it("bounds publication writes even when stderr floods valid finite markers", () => {
  const published: string[] = [];
  const stderr = new EventEmitter();
  observeResearchProviderBootstrapDiagnostics(stderr, message => published.push(message));
  for (let code = 1; code <= 100; code++) stderr.emit("data", `research_root_transition_failed phase=pivot code=${code}\n`);
  expect(published).toHaveLength(8);
});
