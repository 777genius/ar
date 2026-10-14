import { pathToFileURL } from "node:url";
import type { DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/worker-core";

// Only erasable TypeScript: Node 22 can run this bounded child without a runner.
const [modulePath, rootPath, workspaceJson] = process.argv.slice(2);
if (!modulePath || !rootPath?.includes("dependency-owner-TEST-") || !workspaceJson) {
  throw new Error("expected parent-created TEST owner fixture");
}
const api = await import(pathToFileURL(modulePath).href) as typeof import("../../local-dependency-owner-store");
const store = api.LocalDependencyOwnerStore.open({ rootPath, maxRecordBytes: 4096 });
try {
  const record = store.read(JSON.parse(workspaceJson) as DependencyWorkspaceIdentity);
  process.stdout.write(JSON.stringify({ status: record ? "present" : "absent",
    revision: record?.revision ?? null, phase: record?.owner?.phase ?? null }));
} catch (error) {
  const reason = typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string"
    ? error.reason : "unexpected_failure";
  process.stdout.write(JSON.stringify({ status: "rejected", reason }));
} finally { store.close(); }
