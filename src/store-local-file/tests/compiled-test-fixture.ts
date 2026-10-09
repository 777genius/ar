import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DiagnosticCategory, ModuleKind, ScriptTarget, transpileModule } from "typescript";

/** Trusted repository TEST fixture only. Project typecheck covers its TS source;
 * transpilation is just the Node >=20 child transport, without native TS flags.
 * The caller supplies its fresh owned scratch/TMPDIR root, never a home fallback.
 * Generated JS stays exclusive/private and is removed after the child settles. */
export async function withCompiledTestFixture<T>(sourcePath: string, ownedScratchRoot: string,
  effect: (compiledPath: string) => Promise<T>): Promise<T> {
  const source = await readFile(sourcePath, "utf8");
  const result = transpileModule(source, { fileName: sourcePath, reportDiagnostics: true,
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, verbatimModuleSyntax: true } });
  if (result.diagnostics?.some(item => item.category === DiagnosticCategory.Error)) {
    throw new Error("TEST_fixture_transpile_failed");
  }
  const directory = await mkdtemp(join(await realpath(ownedScratchRoot), "NEWTEST-compiled-fixture-"));
  try {
    const compiledPath = join(directory, "generated.mjs");
    await writeFile(compiledPath, result.outputText, { flag: "wx", mode: 0o600 });
    return await effect(compiledPath);
  } finally { await rm(directory, { recursive: true }); }
}
