import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { admitQualificationSourceFiles, qualificationRequiredArtifacts, qualificationSha } from "../hosted-ordinary-installation-qualification";
import { assertSourceScopeMatchesDerivation, deriveQualificationSourceScope, runtimeManifestSha256Of, sourceScopeMaxFiles } from "../hosted-ordinary-installation-source-scope";

const entry = "dist/worker-codex/hosted-ordinary-installation-qualification.js";
const pkg = JSON.stringify({ name: "@vioxen/subscription-runtime", exports: { "./core": { import: "./dist/core/index.js" }, "./broken": { types: "./x.d.ts" } } });
function tree(overrides: Record<string, string> = {}): Map<string, Buffer> {
  const files = new Map<string, Buffer>([["package.json", Buffer.from(pkg)]]);
  for (const path of qualificationRequiredArtifacts) files.set(path, Buffer.from(`export const id = ${JSON.stringify(path)};\n`));
  for (const [path, text] of Object.entries(overrides)) files.set(path, Buffer.from(text));
  return files;
}
const reader = (files: Map<string, Buffer>) => (path: string): Buffer => { const bytes = files.get(path); if (!bytes) throw new Error("missing"); return bytes; };
const derive = (files: Map<string, Buffer>) => deriveQualificationSourceScope(reader(files));
const refusal = (files: Map<string, Buffer>) => expect(() => derive(files));

describe("canonical closed manifest derivation", () => {
  // Regression: two derivations of the same release disagree (ordering, trailing newline), so the issuer, the TEST producer and the reader hash different bytes.
  it("is deterministic, sorted, newline-terminated and independent of read order", () => {
    const a = derive(tree({ [entry]: 'import "./extra.js";\n', "dist/worker-codex/extra.js": "export {};\n" }));
    const reversed = new Map([...tree({ [entry]: 'import "./extra.js";\n', "dist/worker-codex/extra.js": "export {};\n" })].reverse());
    const b = derive(reversed);
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect(a.bytes.at(-1)).toBe(0x0a);
    const parsed = JSON.parse(a.bytes.toString("utf8")) as { schemaVersion: number; files: { path: string; sha256: string }[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.files.map(file => file.path)).toEqual([...parsed.files.map(file => file.path)].sort());
    expect(parsed.files.map(file => file.path)).toContain("dist/worker-codex/extra.js");
    expect(a.sha256).toBe(qualificationSha(a.bytes));
  });
  // Regression: the manifest contract drifts from the product validator, so a derived manifest is refused (or an altered release is accepted).
  it("is accepted by the product validator and its digest is runtimeManifestSha256", () => {
    const files = tree({ [entry]: 'import "./extra.js";\n', "dist/worker-codex/extra.js": "export {};\n" });
    const scope = derive(files);
    expect(() => admitQualificationSourceFiles(JSON.parse(scope.bytes.toString("utf8")), reader(files))).not.toThrow();
    expect(runtimeManifestSha256Of(scope.bytes)).toBe(scope.sha256);
    files.set("dist/worker-codex/extra.js", Buffer.from("export const tampered = 1;\n"));
    expect(() => admitQualificationSourceFiles(JSON.parse(scope.bytes.toString("utf8")), reader(files))).toThrow("ordinary_launcher_qualification_held");
  });
  // Regression: the validator proves every LISTED file but never that a loaded module is missing from the list.
  it("rejects an admitted manifest that omits a loaded module, lists an extra one or differs in a byte", () => {
    const files = tree({ [entry]: 'import "./extra.js";\n', "dist/worker-codex/extra.js": "export {};\n" });
    const derived = derive(files);
    const manifest = JSON.parse(derived.bytes.toString("utf8")) as { schemaVersion: number; files: { path: string; sha256: string }[] };
    const without = Buffer.from(JSON.stringify({ ...manifest, files: manifest.files.filter(file => file.path !== "dist/worker-codex/extra.js") }) + "\n");
    expect(() => admitQualificationSourceFiles(JSON.parse(without.toString("utf8")), reader(files))).not.toThrow();   // the validator alone accepts the incomplete manifest
    expect(() => assertSourceScopeMatchesDerivation(without, derived)).toThrow("hosted_source_scope_held:manifest_on_disk_differs_from_derivation");
    expect(() => assertSourceScopeMatchesDerivation(Buffer.from(derived.bytes.toString("utf8").trimEnd()), derived)).toThrow();
    expect(() => assertSourceScopeMatchesDerivation(derived.bytes, derived)).not.toThrow();
  });
  // Regression: an unlisted third-party package or an invisible load makes the manifest look closed while it is not.
  it("refuses unmeasured packages and loads the scan cannot see; built-ins and the artifact's own package are fine", () => {
    refusal(tree({ [entry]: 'import leftPad from "left-pad";\n' })).toThrow("unmeasured_external_packages:left-pad");
    refusal(tree({ [entry]: 'const m = await import(name);\n' })).toThrow("non_literal_dynamic_load");
    refusal(tree({ [entry]: 'const r = require(path);\n' })).toThrow("non_literal_dynamic_load");
    refusal(tree({ [entry]: '"use strict";\n\nconst m = await import(name);\n' })).toThrow(`non_literal_dynamic_load:${entry}:import@line3`);   // exact unsupported edge: file, kind, line
    refusal(tree({ [entry]: 'import { createRequire } from "node:module";\n' })).toThrow("non_literal_dynamic_load");
    refusal(tree({ [entry]: 'import "@vioxen/subscription-runtime/broken";\n' })).toThrow("self_package_specifier_unresolved");
    const ok = derive(tree({ [entry]: 'import fs from "node:fs"; import path from "path"; import core from "@vioxen/subscription-runtime/core";\n', "dist/core/index.js": "export {};\n" }));
    expect(ok.selfPackageSpecifiers).toEqual(["@vioxen/subscription-runtime/core"]);
    expect(ok.files.map(file => file.path)).toContain("dist/core/index.js");
  });
  // tree() supplies a synthetic package export and facade, rather than reading
  // package.json or src/core-compatibility.ts. The real ./core export target is
  // asserted in host-integration/managed-launcher/dependency-full-native-TEST.node-test.ts.
  it("derives source scope through a synthetic package export and facade", () => {
    const files = tree({
      "package.json": JSON.stringify({ name: "@vioxen/subscription-runtime", exports: {
        "./core": { import: "./dist/core-compatibility.js" },
      } }),
      [entry]: 'import "@vioxen/subscription-runtime/core";\n',
      "dist/core-compatibility.js": 'export * from "./core/index.js";\nexport * from "./provider-codex/app-server/adapters/system-bus-configuration.js";\n',
      "dist/core/index.js": "export const contract = 1;\n",
    });
    const scope = derive(files), manifest = JSON.parse(scope.bytes.toString("utf8"));
    expect(scope.files.map(file => file.path)).toEqual(expect.arrayContaining([
      "dist/core-compatibility.js", "dist/core/index.js",
      "dist/provider-codex/app-server/adapters/system-bus-configuration.js",
    ]));
    expect(() => admitQualificationSourceFiles(manifest, reader(files))).not.toThrow();
    files.set("dist/provider-codex/app-server/adapters/system-bus-configuration.js", Buffer.from("changed recipe"));
    expect(() => admitQualificationSourceFiles(manifest, reader(files))).toThrow("ordinary_launcher_qualification_held");
  });
  // Regression (F4): the issuers and the mechanisms they depend on are not part of the required set, so an admitted source packet could omit the very code that issues authority and still be accepted.
  const issuerModules = ["dist/worker-codex/hosted-ordinary-installation-source-scope.js", "dist/worker-codex/hosted-runtime-stage-curator.js", "dist/worker-codex/hosted-fd-collector-profile-issuer.js",
    "dist/worker-codex/hosted-runtime-issuer-cli.js", "dist/provider-codex/app-server/adapters/elf-closure.js"];
  it("requires the issuer mechanism modules and refuses an admitted manifest that omits any of them", () => {
    expect(qualificationRequiredArtifacts).toEqual(expect.arrayContaining(issuerModules));
    const files = tree(), manifest = JSON.parse(derive(files).bytes.toString("utf8")) as { schemaVersion: number; files: { path: string; sha256: string }[] };
    for (const omitted of issuerModules) {
      const without = { ...manifest, files: manifest.files.filter(file => file.path !== omitted) };
      expect(() => admitQualificationSourceFiles(without, reader(files))).toThrow("ordinary_launcher_qualification_held");
    }
  });
  // The derivation module is itself a required artifact and is scanned like any other: its own text must not contain the word it scans for, or it would refuse its own release.
  it("keeps the derivation module free of the pattern it refuses (self-scan)", () => {
    const own = readFileSync(fileURLToPath(new URL("../hosted-ordinary-installation-source-scope.ts", import.meta.url)), "utf8");
    expect(own).not.toMatch(/\bcreateRequire\b/);
  });
  // Regression: a relative import climbs out of the measured trees or the closure is unbounded.
  it("refuses imports that leave dist/host-integration and closures beyond the manifest bound", () => {
    refusal(tree({ [entry]: 'import "../../node_modules/evil/index.js";\n' })).toThrow("import_leaves_closure");
    const chain: Record<string, string> = { [entry]: 'import "./c0.js";\n' };
    for (let index = 0; index <= sourceScopeMaxFiles; index++) chain[`dist/worker-codex/c${index}.js`] = `import "./c${index + 1}.js";\n`;
    chain[`dist/worker-codex/c${sourceScopeMaxFiles + 1}.js`] = "export {};\n";
    refusal(tree(chain)).toThrow("closure_exceeds_manifest_bound");
  });
});
