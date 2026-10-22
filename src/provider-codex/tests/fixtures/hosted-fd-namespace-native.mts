import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readlinkSync } from "node:fs";
import { hostedFdNamespacePrefix, assertHostedFdNamespaceAncestry } from "../../../../dist/provider-codex/app-server/adapters/hosted-fd-namespace-stages.js";
// This exercises only the actual Linux process graph from the production recipe.
// It cannot supply custody, enrollment, a profile or a successful FDA release.
const argv = [...hostedFdNamespacePrefix, process.execPath, "-e", "process.stdout.write('TEST-ready\\n');process.stdin.resume()"];
const child = spawn(argv[0]!, argv.slice(1), { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: "pipe" });
const closed = once(child, "close");
let stderr = "", stdout = "", timedOut = false;
child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10000);
const ready = new Promise<boolean>(resolve => {
  child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout === "TEST-ready\n") resolve(true); });
  child.once("close", () => resolve(false));
});
try {
  if (!await ready) {
    const [code] = await closed;
    if (!timedOut && code === 1 && /^unshare: (?:unshare failed|write failed [^\n]*): Operation not permitted\n$/.test(stderr)) {
      process.stdout.write("TEST namespace capability unavailable\n"); process.exitCode = 77;
    } else throw Error("TEST exact recipe did not become ready");
  } else {
    const rows: { pid: number; parentPid: number; exe: string; argv: readonly string[] }[] = [];
    function collect(pid: number): void {
      assert.ok(rows.length < 16);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), at = stat.lastIndexOf(") ");
      assert.ok(stat.startsWith(`${pid} (`) && at > 0);
      const fields = stat.slice(at + 2).trim().split(/\s+/);
      const args = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0"); assert.equal(args.pop(), "");
      rows.push({ pid, parentPid: Number(fields[1]), exe: readlinkSync(`/proc/${pid}/exe`), argv: args });
      for (const id of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) collect(Number(id));
      const after = readFileSync(`/proc/${pid}/stat`, "utf8");
      assert.equal(after.slice(after.lastIndexOf(") ") + 2).trim().split(/\s+/)[19], fields[19]);
    }
    collect(child.pid!);
    assert.ok(rows.length >= 3);
    assertHostedFdNamespaceAncestry(argv, rows, child.pid!);
    assert.throws(() => assertHostedFdNamespaceAncestry(argv, rows, rows.find(row => row.pid !== child.pid)!.pid), /hosted_fd_namespace_stage_unresolved/);
    child.stdin.end();
    const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null);
    process.stdout.write("TEST exact namespace graph accepted\n");
  }
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
}
