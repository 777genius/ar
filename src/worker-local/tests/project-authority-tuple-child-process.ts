import { once } from "node:events";
import {
  LocalProjectAuthorityCrashPoint,
  LocalProjectAuthorityTupleStore,
} from "../project-authority-tuple-local-adapter";
import {
  acquireAuthorityLock, certifyLocalAuthorityFilesystem, closeAuthorityBoundary, openAuthorityBoundary,
} from "../project-authority-linux-file-primitives";

const [mode, rootDir, projectId, barrier, variant = "same"] = process.argv.slice(2);
if (!mode || !rootDir || !projectId) throw new Error("child_args_required");
if (mode === "hold") {
  const boundary = await openAuthorityBoundary(rootDir, projectId);
  await acquireAuthorityLock(boundary, certifyLocalAuthorityFilesystem);
  process.stdout.write("locked\n");
  await new Promise<void>((resolve) => { setInterval(resolve, 60_000); });
  await closeAuthorityBoundary(boundary);
} else {
  if (barrier) {
    const go = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("child_go_timeout")); }, 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
      };
      const onData = () => { cleanup(); resolve(); };
      const onEnd = () => { cleanup(); reject(new Error("child_go_cancelled")); };
      process.stdin.once("data", onData);
      process.stdin.once("end", onEnd);
    });
    process.stderr.write("ready\n");
    await go;
  }
  const expected = { packetRevision: "hosted-web-core-v1-r1",
    baseSha: "a".repeat(40), phaseStartSha: null,
    inputPatchHash: "b".repeat(64) } as const;
  const desired = { ...expected, phaseStartSha: mode === "crash" || variant === "same" ? "c".repeat(40) : variant.repeat(40),
    reviewReceiptSha256: mode === "crash" || variant === "same" ? "d".repeat(64) : variant.repeat(64) };
  const crashPoint = mode === "crash" ? variant as LocalProjectAuthorityCrashPoint : undefined;
  const store = new LocalProjectAuthorityTupleStore({ rootDir, projectId,
    ...(crashPoint ? { crashHook(point: LocalProjectAuthorityCrashPoint) {
      if (point === crashPoint) process.kill(process.pid, "SIGKILL");
    } } : {}) });
  try {
    const status = mode === "initialize" ? await store.initialize(expected) :
      await store.compareAndSet({ expected, desired });
    process.stdout.write(JSON.stringify({ status }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
}
