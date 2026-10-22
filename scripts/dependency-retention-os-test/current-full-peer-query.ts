import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { retainOriginalFullProjectControlPeerQueryEntry } from "../../dist/provider-codex/app-server/adapters/hosted-full-backing-stage.js";
import { assertHostedFdPreludeDescriptors } from "../../dist/provider-codex/app-server/adapters/hosted-process-descriptors.js";
import { originalFullPeerArguments, originalFullPeerEnvironment, originalFullPeerLoader,
  originalFullPeerNode, originalFullPeerProgram, originalFullPeerReady } from "../../dist/worker-codex/hosted-project-control-peer-recipe.js";

function check(value: unknown): asserts value { if (!value) throw new Error("TEST_original_peer_query_held"); }

/** The original source-selected query role is finite execution synchronization.
 * No message, successful exec or returned value creates SDK authority. */
async function main(): Promise<never> {
  check(process.platform === "linux" && process.execPath === originalFullPeerNode && process.argv.length === 3 &&
    process.argv[1] === originalFullPeerProgram && process.argv[2] === "query-peer" && process.execArgv.length === 0);
  const entry = retainOriginalFullProjectControlPeerQueryEntry();
  let active = true;
  try {
    entry.revalidate(); check(process.env.TEST_SOURCE_SHA === entry.sourceSha);
    const environment = originalFullPeerEnvironment();
    check(Object.keys(process.env).sort().join(",") === [...Object.keys(environment), "TEST_SOURCE_SHA"].sort().join(",") &&
      Object.entries(environment).every(([key, value]) => process.env[key] === value));
    const gateStat = fstatSync(3); check(gateStat.isSocket());
    const gate = new Socket({ fd: 3, readable: true, writable: false });
    const consumed = new Promise<void>((resolve, reject) => {
      let count = 0, ended = false, failed = false;
      const failure = () => { if (!failed) { failed = true; gate.destroy(); reject(new Error("TEST_original_peer_query_gate_held")); } };
      gate.on("data", (bytes: Buffer) => { if (bytes.length !== 1 || bytes[0] !== 1 || count !== 0) failure(); else count++; });
      gate.once("error", failure);
      gate.once("end", () => { ended = true; if (count !== 1) failure(); else gate.destroy(); });
      gate.once("close", () => { if (!failed && ended && count === 1) resolve(); else failure(); });
    });
    await new Promise<void>((resolve, reject) => process.stdout.write(originalFullPeerReady, error => error ? reject(error) : resolve()));
    await consumed;
    let closed = false;
    try { fstatSync(3); } catch (error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); closed = true; }
    check(closed); entry.revalidate(); entry.close(); active = false;
    // All genuine query-entry proc/source/metadata descriptors are closed before
    // the unchanged finite Node census and the only fixed execve boundary.
    assertHostedFdPreludeDescriptors();
    check(typeof process.execve === "function");
    process.execve(originalFullPeerLoader, [originalFullPeerLoader, ...originalFullPeerArguments], environment);
    throw new Error("TEST_original_peer_query_execve_returned");
  } finally { if (active) entry.close(); }
}
await main();
