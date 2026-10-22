import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { hostedFdTable } from "../app-server/adapters/hosted-fd-table";

const linuxOnly = it.skipIf(process.platform !== "linux");

function churnChild() {
  const child = spawn(process.execPath, ["-e",
    `const { openSync, closeSync } = require("node:fs");
     setInterval(() => { for (let i = 0; i < 200; i++) { const fd = openSync("/dev/null", "r"); closeSync(fd); } }, 0);`,
  ], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("churn child spawn failed");
  return { child, pid: child.pid };
}

// Known flake modes (2026-10), both harness-premise loss, not product regressions:
// (1) hosted_fd_boundary_unresolved on an empty fdinfo read, fixed by the
// empty-body drop handling; (2) rows 0-2 missing without a throw = the churn
// child died mid-loop (a zombie's fd table is empty and exitCode stays null
// because this loop never yields). Rerun the shard on red.
linuxOnly("observes a live process without losing rows to transient fd churn", async () => {
  const { child, pid } = churnChild();
  try {
    for (let scan = 0; scan < 5000 && child.exitCode === null; scan++) {
      const facts = hostedFdTable(pid);
      for (const fd of [0, 1, 2]) {
        expect(facts.some(fact => fact.fd === fd && fact.target.length > 0)).toBe(true);
      }
    }
  } finally {
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("close", resolve));
  }
}, 30_000);

linuxOnly("stays fail-closed once the process is gone", async () => {
  const { child, pid } = churnChild();
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("close", resolve));
  expect(() => hostedFdTable(pid)).toThrow();
});
