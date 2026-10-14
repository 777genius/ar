import { writeFileSync, unlinkSync, utimesSync } from "node:fs";
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
    let pending = "", received = 0, rounds = 0, stopped = false;
    const temporary = join(rootPath, "TEST-root-metadata-churn");
    for await (const chunk of process.stdin) {
      const bytes = String(chunk); received += Buffer.byteLength(bytes);
      if (received > 1024) throw new Error("TEST invalid churn request");
      pending += bytes;
      if (pending.length > 32) throw new Error("TEST invalid churn frame");
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), command = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (stopped) throw new Error("TEST unexpected churn command");
        if (command === "MUTATE" && rounds < 100) {
          for (let i = 0; i < 40; i++) {
            writeFileSync(temporary, "TEST", { flag: "wx", mode: 0o600 });
            unlinkSync(temporary);
          }
          // Real bounded metadata actuation: coarse automatic timestamps may repeat.
          utimesSync(rootPath, 946684800, 946684800 + (rounds + 1) * 2);
          rounds++; process.stdout.write("CHANGED\n");
        } else if (command === "STOP" && rounds === 100) stopped = true;
        else throw new Error("TEST unexpected churn command");
      }
    }
    if (!stopped || pending) throw new Error("TEST incomplete churn request");
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
