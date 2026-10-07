import assert from "node:assert/strict";
import fs, { type BigIntStats } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DependencyReceipt, DependencyWorkspaceIdentity } from "../../../../worker-core/dependency-environment/domain/dependency-receipt";

// Actual production open/CAS over fresh TEST files. Only syscall scheduling is
// intercepted; every returned stat and every publication comes from real code.
const [modulePath, rootPath, workspaceJson, nextJson] = process.argv.slice(2);
if (process.platform !== "linux" || !modulePath || !rootPath?.includes("dependency-receipt-TEST-") ||
  !workspaceJson || !nextJson) throw new Error("expected Linux TEST root-open fixture");
const api = await import(pathToFileURL(modulePath).href) as typeof import("../../local-dependency-receipt-store");
const workspace = JSON.parse(workspaceJson) as DependencyWorkspaceIdentity;
const next = JSON.parse(nextJson) as DependencyReceipt;
const options = { rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 };
const publisher = api.LocalDependencyReceiptStore.open(options);
const original = fs.fstatSync;
const childEntry = join(rootPath, "TEST-legitimate-child-entry");
let captured: BigIntStats | undefined;
let childCreated = false;
let opened: ReturnType<typeof api.LocalDependencyReceiptStore.open> | undefined;
function restore(): void { fs.fstatSync = original; syncBuiltinESMExports(); }
try {
  const rootIdentity = fs.lstatSync(rootPath, { bigint: true });
  Object.defineProperty(fs, "fstatSync", { value: (...args: unknown[]) => {
    const observed = Reflect.apply(original, fs, args) as fs.Stats | BigIntStats;
    if (typeof observed.dev === "bigint" && observed.dev === rootIdentity.dev && observed.ino === rootIdentity.ino) {
      // Disable before CAS: nested production syscalls must run unmodified.
      restore(); captured = observed as BigIntStats;
      publisher.compareAndSwap(workspace, null, next);
      // A private child directory guarantees a mutable nlink delta even on a
      // filesystem with coarse timestamps. Root custody remains unchanged;
      // existing assertRoot already permits legitimate child-entry changes.
      fs.mkdirSync(childEntry, { mode: 0o700 }); childCreated = true;
    }
    return observed;
  } });
  syncBuiltinESMExports();
  opened = api.LocalDependencyReceiptStore.open(options);
  assert.ok(captured, "root observation must be intercepted");
  const after = fs.lstatSync(rootPath, { bigint: true });
  assert.ok(after.isDirectory());
  assert.equal(after.dev, captured.dev); assert.equal(after.ino, captured.ino);
  assert.equal(after.uid, captured.uid); assert.equal(after.uid, BigInt(process.geteuid!()));
  assert.equal(after.mode, captured.mode); assert.equal(after.mode & 0o7777n, 0o700n);
  assert.notEqual(after.nlink, captured.nlink, "actual directory metadata must change");
  assert.deepEqual(opened.read(workspace), next);
  process.stdout.write(JSON.stringify({ status: "root_open_valid", custodyUnchanged: true,
    directoryMetadataChanged: true, publishedRevision: next.revision }));
} finally {
  restore(); opened?.close(); publisher.close();
  if (childCreated) fs.rmdirSync(childEntry);
}
