import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodexAppServerChildProcess } from "../provider-codex/app-server/application/app-server-process-port";
import { writeCurrentHostedManagedDependencyProviderView, signalCurrentHostedManagedDependencyProviderView, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
function invalid(): never { throw new Error("hosted_dependency_provider_view_denied"); }
/** Event forwarding only; construction cannot register a child or grant a lease. */
/** Numeric-only public SDK view. The actual Node child, emitter and handles
 * stay in the original entry. Observers receive primitive/copied arguments and
 * every chainable method returns this frozen view, never the native receiver. */
export function createHostedManagedDependencySdkView(context: CurrentHostedDependencyOrigin, child: ChildProcessWithoutNullStreams): CodexAppServerChildProcess {
  if (!child.stdin || !child.stdout || !child.stderr) invalid();
  const input = child.stdin, output = child.stdout, errors = child.stderr;
  const safeError = (error: Error): Error => {
    const safe = new Error(error.message.slice(0,1024)); safe.name = error.name.slice(0,64); return safe;
  };
  const bytes = (chunk: unknown): string | Uint8Array => {
    if (typeof chunk === "string") return chunk;
    if (chunk instanceof Uint8Array) return Uint8Array.from(chunk);
    invalid();
  };
  const stdin = Object.freeze({
    write(chunk:string|Uint8Array): boolean { return writeCurrentHostedManagedDependencyProviderView(context,facade,chunk); },
    end(): void { writeCurrentHostedManagedDependencyProviderView(context,facade); },
    on(event:"error", listener:(error:Error)=>void) {
      if (event !== "error") invalid(); input.on("error",error => listener(safeError(error))); return stdin;
    },
  });
  const stdout = Object.freeze({
    on(event:"data", listener:(chunk:unknown)=>void) {
      if (event !== "data") invalid(); output.on("data",chunk => listener(bytes(chunk))); return stdout;
    },
    setEncoding(encoding:BufferEncoding) { output.setEncoding(encoding); return stdout; },
  });
  const stderr = Object.freeze({
    on(event:"data", listener:(chunk:unknown)=>void) {
      if (event !== "data") invalid(); errors.on("data",chunk => listener(bytes(chunk))); return stderr;
    },
    setEncoding(encoding:BufferEncoding) { errors.setEncoding(encoding); return stderr; },
  });
  const facade: CodexAppServerChildProcess = Object.freeze({stdin,stdout,stderr,
    on(...request: readonly ["exit",(code:number|null,signal:string|null)=>void] | readonly ["error",(error:Error)=>void]) {
      if (request[0] === "exit") { const listener = request[1]; child.on("exit",(code,signal) => listener(code,signal)); }
      else if (request[0] === "error") { const listener = request[1]; child.on("error",error => listener(safeError(error))); }
      else invalid(); return facade;
    },
    kill(signal:NodeJS.Signals = "SIGTERM"): boolean {
      // This is only an owned stop request. It is never cache-slot/terminal proof.
      signalCurrentHostedManagedDependencyProviderView(context,facade,signal); return true;
    },
  });
  return facade;
}
