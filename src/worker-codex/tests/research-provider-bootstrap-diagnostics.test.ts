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


it("retains only finite material role, cause and errno with bounded admission source coordinates", () => {
  const published: string[] = [];
  const decoder = createResearchProviderBootstrapDiagnostics(message => published.push(message));
  const marker = { event: "research_provider_root_assembly_failed", legacyCode: "unclassified",
    cause: "file-deadline", diagnostic: "ENOENT", materialRole: "runtime-artifact", materialLine: 75, materialColumn: 58 };
  decoder.push(JSON.stringify(marker) + "\n");
  expect(published).toEqual(["research_provider_root_assembly_failed legacyCode=unclassified materialLine=75 materialColumn=58 materialRole=runtime-artifact cause=file-deadline diagnostic=ENOENT"]);
  for (const changed of [{ materialRole: "TEST-secret" }, { materialLine: 1000000 }, { materialColumn: undefined }, { materialLine: "75" }]) {
    decoder.push(JSON.stringify({ ...marker, ...changed }) + "\n");
  }
  expect(published).toHaveLength(1);
  decoder.push(JSON.stringify({ ...marker, cause: "TEST-secret", diagnostic: "TEST-secret", materialRole: "unknown" }) + "\n");
  expect(published[1]).toBe("research_provider_root_assembly_failed legacyCode=unclassified materialLine=75 materialColumn=58");
  expect(JSON.stringify(published)).not.toContain("TEST-secret");
});


it("retains a fragmented coding launcher failure when protected stderr closes without a newline", () => {
  const stderr = new EventEmitter();
  const published: string[] = [];
  observeResearchProviderBootstrapDiagnostics(stderr, message => published.push(message));
  stderr.emit("data", "hosted_app_server_coding_con");
  stderr.emit("data", "fig_invalid");
  stderr.emit("close");
  expect(published).toEqual([
    "hosted_app_server_bootstrap_failed code=hosted_app_server_coding_config_invalid",
  ]);
});

it("accepts exact launcher failures while refusing unclassified or decorated provider text", () => {
  const published: string[] = [];
  const decoder = createResearchProviderBootstrapDiagnostics(message => published.push(message));
  decoder.push("hosted_app_server_launch_frame_invalid\n");
  for (const line of [
    "hosted_app_server_TEST-secret",
    "hosted_app_server_launch_frame_invalid TEST-secret",
    "TEST-secret hosted_app_server_launch_frame_invalid",
    "qualification_preflight_invalid",
    JSON.stringify({ event: "hosted_app_server_launch_frame_invalid", secret: "TEST-secret" }),
    "x".repeat(4096) + "hosted_app_server_launch_frame_invalid",
  ]) decoder.push(line + "\n");
  decoder.push("hosted_app_server_child_spawn_failed"); decoder.finish();
  expect(published).toEqual([
    "hosted_app_server_bootstrap_failed code=hosted_app_server_launch_frame_invalid",
    "hosted_app_server_bootstrap_failed code=hosted_app_server_child_spawn_failed",
  ]);
  expect(JSON.stringify(published)).not.toContain("TEST-secret");
});
