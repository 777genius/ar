import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { hostedDependencyProviderLauncherPackageScope, hostedDependencyProviderLauncherSupport } from "../app-server/adapters/hosted-dependency-provider-launch";

const emitted = fileURLToPath(new URL("../../../dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js", import.meta.url));
function coldRoot() {
  const root = mkdtempSync(join(tmpdir(), "TEST-provider-launcher-closure-"));
  // An explicit outer CommonJS scope prevents ambient ESM/syntax detection
  // from hiding a missing package boundary for the parent bootstrap module.
  writeFileSync(join(root, "package.json"), '{"type":"commonjs"}\n');
  const entry = join(root, "provider-codex/app-server/adapters/hosted-app-server-launcher.js");
  for (const relative of ["hosted-app-server-launcher.js", ...hostedDependencyProviderLauncherSupport]) {
    const target = resolve(dirname(entry), relative); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(dirname(emitted), relative), target);
  }
  const marker = join(dirname(entry), hostedDependencyProviderLauncherPackageScope, "package.json");
  writeFileSync(marker, '{"type":"module"}\n', { flag: "wx", mode: 0o644 });
  const run = () => spawnSync(process.execPath, [entry], { input: "", encoding: "utf8", timeout: 5000, maxBuffer: 16384,
    env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: "pipe" });
  return { root, entry, marker, run };
}

it("cold-loads only the actual finite launcher roster before refusing missing input", () => {
  const f = coldRoot();
  try {
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.includes("ERR_MODULE_NOT_FOUND") ? "cold ESM: ERR_MODULE_NOT_FOUND" : "cold ESM boundary").toBe(70);
    expect(result.stdout).toBe(""); expect(result.stderr).toBe("hosted_app_server_launch_frame_missing\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("covers every emitted static dependency without binding the runtime tree", () => {
  const available = new Set([emitted, ...hostedDependencyProviderLauncherSupport.map(name => resolve(dirname(emitted), name))]);
  expect(Object.isFrozen(hostedDependencyProviderLauncherSupport)).toBe(true);
  expect(available.size).toBe(8); expect(hostedDependencyProviderLauncherSupport).toHaveLength(7);
  const visited = new Set<string>(), pending = [emitted];
  while (pending.length) {
    const path = pending.pop()!; if (visited.has(path)) continue; visited.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier; if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (specifier.text.startsWith("node:")) continue;
      expect(specifier.text.startsWith(".")).toBe(true);
      const dependency = resolve(dirname(path), specifier.text);
      expect(available.has(dependency), "static dependency must be an exact selected leaf").toBe(true);
      pending.push(dependency);
    }
  }
  // The old encoder leaf is retained for compatibility; the guest decodes.
  expect(visited.size).toBe(7);
  expect([...available].filter(path => !visited.has(path))).toEqual([resolve(dirname(emitted), "hosted-app-server-launch-frame.js")]);
});

it.each(["hosted-blocking-output.js", "managed-provider-scratch-environment.js", "hosted-app-server-launch-frame-decoder.js", "../../hosted-mimo-coding-bootstrap.js"])(
  "refuses an incomplete cold root missing %s", missing => {
    const f = coldRoot();
    try {
      unlinkSync(resolve(dirname(f.entry), missing));
      const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout).toBe("");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  },
);

it("needs its explicit common ESM scope for the parent bootstrap", () => {
  const f = coldRoot();
  try {
    unlinkSync(f.marker);
    // Retain the old local scope: it cannot cover the parent bootstrap.
    writeFileSync(join(dirname(f.entry), "package.json"), '{"type":"module"}\n');
    const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).not.toBe("hosted_app_server_launch_frame_missing\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
