import { fstatSync, readFileSync } from "node:fs";

// Native protocol writers use blocking write_all on these exact inherited FDs.
// Initialize Node's lazy streams before clearing their shared nonblocking flag.
function prepareBlockingOutput(descriptor: 1 | 2): void {
  const before = fstatSync(descriptor);
  const stream = descriptor === 1 ? process.stdout : process.stderr;
  const handle = (stream as unknown as {
    readonly _handle?: { readonly fd?: number; setBlocking?: (blocking: boolean) => number };
  })._handle;
  if (handle?.fd !== descriptor || typeof handle.setBlocking !== "function" ||
      handle.setBlocking(true) !== 0) {
    throw new Error("hosted_app_server_blocking_output_unavailable");
  }
  const after = fstatSync(descriptor);
  const flags = /^flags:\s+([0-7]{1,12})$/m.exec(readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8"));
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
      before.rdev !== after.rdev || !flags || (Number.parseInt(flags[1]!, 8) & 0o4000) !== 0) {
    throw new Error("hosted_app_server_blocking_output_invalid");
  }
}

export function setInheritedStdioBlocking(): void {
  prepareBlockingOutput(1);
  prepareBlockingOutput(2);
}
