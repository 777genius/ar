import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const source = process.env.GUEST_COPY_SOURCE_ROOT, emitted = process.env.GUEST_COPY_EMITTED_ROOT;
assert.ok(source && emitted, "actual source and complete strict emission required");
const old = process.env.GUEST_COPY_OLD_INVENTORY === "1";
const common = await import(pathToFileURL(join(emitted, "scripts/dependency-retention-os-test/common.js")).href);
const oldSource = process.env.GUEST_COPY_OLD_SOURCE_ROOT;
if (old) assert.ok(oldSource, "actual unchanged base source required for RED control");
const oldLiteral = old ? /export const currentBackingRuntimeModules = \[([\s\S]*?)\] as const;/.exec(readFileSync(join(oldSource!, "scripts/dependency-retention-os-test/common.ts"), "utf8")) : null;
if (old) assert.ok(oldLiteral, "actual base inventory literal");
const selected: readonly string[] = old ? [...oldLiteral![1]!.matchAll(/"([^"]+)"/g)].map(row => row[1]!) : common.currentBackingRuntimeModules;
function copyGuest(): string {
  const root = mkdtempSync(join(tmpdir(), "TEST-full-guest-copy-"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  // The production assembler already copies the complete dist and script trees.
  for (const tree of ["dist", "scripts"]) cpSync(join(emitted!, tree), join(root, tree), { recursive: true });
  for (const path of selected) {
    const actual = join(path.endsWith(".js") || path.endsWith("/hosted-host-policy.mjs") ? emitted! : source!, path);
    assert.ok(existsSync(actual), "original selected leaf absent: " + path);
    mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(actual, join(root, path));
  }
  return root;
}
function graph(root: string, entry: string): Set<string> {
  const seen = new Set<string>();
  function visit(path: string): void {
    assert.ok(path.startsWith(root + "/"), "guest import escaped copied root: " + path);
    assert.ok(existsSync(path), "missing guest dependency: " + relative(root, path));
    if (seen.has(path)) return; seen.add(path);
    for (const row of readFileSync(path, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      const specifier = row[1]!; if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), "external guest import: " + specifier);
      visit(resolve(dirname(path), specifier));
    }
  }
  visit(join(root, entry)); return seen;
}
test("actual guest copy loads complete original native constructor graph", () => {
  const root = copyGuest(); try {
    const closure = graph(root, "host-integration/managed-launcher/dependency-full-native-TEST.js");
    assert.ok(closure.has(join(root, "host-integration/managed-launcher/dependency-full-h1-constructor-closure-TEST.js")));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "const m=await import(" + JSON.stringify(pathToFileURL(join(root,"host-integration/managed-launcher/dependency-full-native-TEST.js")).href) + "); if(typeof m.retainCurrentFullParent!=='function')throw Error('entry missing');"], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
    // Compatibility proc source is no longer a collector import; its canonical
    // dist closure is available in the existing complete dist tree.
    const collector = readFileSync(join(root, "scripts/dependency-retention-os-test/current-full-backing-collector.js"), "utf8");
    const procImport = /import \{ fullRetainedFilesystemType \} from "([^"]+)"/.exec(collector); assert.ok(procImport, "actual collector proc import");
    graph(root, relative(root, resolve(root, "scripts/dependency-retention-os-test", procImport[1]!)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("each copied HOST leaf is required by native or the original dynamic copy route", () => {
  assert.ok(Object.isFrozen(common.currentBackingRuntimeModules));
  for (const path of selected.filter(path => path.startsWith("host-integration/"))) {
    const root = copyGuest(); try { rmSync(join(root, path)); assert.throws(() => {
      graph(root, "host-integration/managed-launcher/dependency-full-native-TEST.js");
      // Existing original installation code dynamically loads this fixed module.
      graph(root, "host-integration/managed-launcher/dependency-full-positive-copy-TEST.js");
    }, /missing guest dependency/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});
