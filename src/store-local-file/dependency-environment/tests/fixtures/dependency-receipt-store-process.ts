import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DependencyReceipt, DependencyWorkspaceIdentity } from "../../../../worker-core/dependency-environment/domain/dependency-receipt";

// Erasable TS, fresh TEST filesystem only. No runtime or installation launch.
const [modulePath, rootPath, workspaceJson, mode, nextJson] = process.argv.slice(2);
if (!modulePath || !rootPath?.includes("dependency-receipt-TEST-") || !workspaceJson || !mode) throw new Error("expected TEST receipt fixture");
const api = await import(pathToFileURL(modulePath).href) as typeof import("../../local-dependency-receipt-store");
const store = api.LocalDependencyReceiptStore.open({ rootPath, maxRecordBytes: 16384, maxHistorySteps: 16 });
try {
  if (mode === "root-churn") {
    process.stdout.write("READY\n");
    let request = "";
    for await (const chunk of process.stdin) {
      request += String(chunk);
      if (request.length > 32) throw new Error("TEST invalid churn request");
    }
    if (request !== "GO\n") throw new Error("TEST invalid churn request");
    const temporary = join(rootPath, "TEST-root-metadata-churn");
    for (let i = 0; i < 4000; i++) {
      writeFileSync(temporary, "TEST", { flag: "wx", mode: 0o600 });
      unlinkSync(temporary);
    }
    process.stdout.write(JSON.stringify({ status: "churned", mutations: 4000 }));
  } else {
    const workspace = JSON.parse(workspaceJson) as DependencyWorkspaceIdentity;
    const receipt = mode === "cas" && nextJson ? store.compareAndSwap(workspace, null, JSON.parse(nextJson) as DependencyReceipt) : store.read(workspace);
    process.stdout.write(JSON.stringify({ status: mode === "cas" ? "published" : receipt ? "present" : "absent",
      revision: receipt?.revision ?? null, state: receipt?.state ?? null }));
  }
} catch (error) {
  const reason = error && typeof error === "object" && "reason" in error && typeof error.reason === "string" ? error.reason : "unexpected_failure";
  process.stdout.write(JSON.stringify({ status: "rejected", reason }));
} finally { store.close(); }
