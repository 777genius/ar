import { access, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.SR_SYNTHETIC_WRITEBACK_ROOT;
const id = process.env.SR_SYNTHETIC_WRITER;
if (!root || !basename(root).startsWith("codex-process-writeback-cas-") ||
    (id !== "first" && id !== "second")) throw new Error("invalid_synthetic_writer");

// Standard npm test and every CI unit shard build first. Run that actual
// compiled custody in plain Node, without another Vitest pool/test graph.
const modulePath = fileURLToPath(new URL("../../../dist/worker-codex/file-backend-codex-seed-writeback.js", import.meta.url));
await access(modulePath).catch(() => { throw new Error("synthetic_writer_build_required"); });
const { FileBackendCodexSeedWriteback } = await import(pathToFileURL(modulePath).href) as
  typeof import("../file-backend-codex-seed-writeback.js");
const input: unknown = JSON.parse(await readFile(join(root, "writer-input.json"), "utf8"));
if (typeof input !== "object" || input === null ||
    !("seed" in input) || typeof input.seed !== "string" ||
    !("refreshed" in input) || typeof input.refreshed !== "string" ||
    !("relogin" in input) || typeof input.relogin !== "string") {
  throw new Error("invalid_synthetic_writer_input");
}
await writeFile(join(root, `ready-${id}`), "synthetic ready");
const deadline = Date.now() + 20_000;
while (true) {
  try { await readFile(join(root, "go")); break; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    if (Date.now() >= deadline) throw new Error("synthetic_writer_barrier_timeout");
    await setTimeout(10);
  }
}
const custody = new FileBackendCodexSeedWriteback(join(root, "auth.json"));
const accepted = await custody.publish({ source: input.seed, expected: input.seed,
  next: id === "first" ? input.refreshed : input.relogin });
await writeFile(join(root, `result-${id}`), String(accepted));
