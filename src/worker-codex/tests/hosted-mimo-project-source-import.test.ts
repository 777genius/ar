import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { it } from "vitest";
import { managedDependencyGitEnvironment, managedDependencyGitFlags } from "../managed-dependency-git-hygiene";

const worker = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// This reduced ESM graph retains the actual source/Git/adoption modules. Pure
// substitutes compress the existing root-purpose -> adoption back-edge; they
// never initialize provider, account, network or Host authority. It demonstrates
// the module-link regression, not a captured error from a deployed service.
function importFixture(entry: string) {
  const root = mkdtempSync(join(tmpdir(), "mimo-source-import-"));
  try {
    const actual = new Map([
      ["./hosted-mimo-project-source", "hosted-mimo-project-source.ts"],
      ["./managed-dependency-git", "managed-dependency-git.ts"],
      ["./managed-dependency-git-hygiene", "managed-dependency-git-hygiene.ts"],
      ["./adoption", "application/project-control/codex-goal-project-adoption-target.ts"],
    ]);
    const stubs = new Map<string, Set<string>>();
    let stubIndex = 0;
    for (const [name, relative] of actual) {
      const path = join(worker, relative);
      if (!existsSync(path)) continue; // The pre-fix source has no hygiene leaf.
      const source = readFileSync(path, "utf8");
      const result = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        transformers: { before: [context => file => {
          const visit: ts.Visitor = node => {
            if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
              const target = "./" + node.moduleSpecifier.text.split("/").at(-1);
              if (actual.has(target)) return context.factory.updateExportDeclaration(node, node.modifiers,
                node.isTypeOnly, node.exportClause, context.factory.createStringLiteral(target + ".mjs"), node.attributes);
            }
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
              const specifier = node.moduleSpecifier.text;
              if (specifier.startsWith("node:")) return node;
              const leaf = "./" + specifier.split("/").at(-1);
              let target = actual.has(leaf) ? leaf : undefined;
              if (!target) {
                target = "./stub-" + stubIndex++;
                const names = new Set<string>();
                const bindings = node.importClause?.namedBindings;
                if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
                  if (!binding.isTypeOnly) names.add(binding.propertyName?.text ?? binding.name.text);
                if (specifier === "./hosted-dependency-root-purpose") names.add("__adoption_cycle");
                stubs.set(target, names);
              }
              return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause,
                context.factory.createStringLiteral(target + ".mjs"), node.attributes);
            }
            return ts.visitEachChild(node, visit, context);
          };
          return ts.visitNode(file, visit) as ts.SourceFile;
        }] },
      });
      writeFileSync(join(root, name.slice(2) + ".mjs"), result.outputText);
    }
    for (const [name, names] of stubs) {
      const lines: string[] = names.has("__adoption_cycle") ? ['import "./adoption.mjs";'] : [];
      for (const exported of names) if (exported !== "__adoption_cycle") lines.push(
        exported === "ExecFileProjectControlGitAdapter" ? "export class ExecFileProjectControlGitAdapter {}" :
          `export function ${exported}(){ throw new Error("fixture boundary invoked"); }`);
      writeFileSync(join(root, name.slice(2) + ".mjs"), lines.join("\n"));
    }
    return spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(root, entry + ".mjs"))});`], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: dirname(process.execPath), HOME: root, TMPDIR: root, LANG: "C", LC_ALL: "C" },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it("loads the actual source entry without initializing the managed Git/adoption cycle", () => {
  const result = importFixture("hosted-mimo-project-source");
  assert.equal(result.status, 0, result.stderr);
});

it("keeps the managed Git entry linkable when adoption reads its hygiene recipe", () => {
  const result = importFixture("managed-dependency-git");
  assert.equal(result.status, 0, result.stderr);
});

it("retains fixed Git execution restrictions and a fresh environment without inherited overrides", () => {
  assert.deepEqual(managedDependencyGitFlags,
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external="]);
  assert.equal(Object.isFrozen(managedDependencyGitFlags), true);
  const first = managedDependencyGitEnvironment();
  assert.deepEqual(first, { PATH: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/", TMPDIR: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" });
  first.GIT_CONFIG_COUNT = "7";
  assert.equal(managedDependencyGitEnvironment().GIT_CONFIG_COUNT, "0");
});
