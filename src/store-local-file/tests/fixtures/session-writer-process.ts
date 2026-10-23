import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise source adapters in independent Node processes without requiring a
// concurrent repository build or importing the test runner in each child.
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@vioxen/subscription-runtime/core") {
      return nextResolve(pathToFileURL(join(repo, "src/core/domain/generation-hash.ts")).href, context);
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      for (const candidate of [`${path}.ts`, join(path, "index.ts")]) {
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const [rootDir, mode, index] = process.argv.slice(2);
if (!rootDir || !mode || !index) throw new Error("writer_process_arguments_required");
const { createLocalFileBackendRuntimeAdapters } = await import(
  pathToFileURL(join(repo, "src/store-local-file/session-custody/application/local-file-backend-adapters.ts")).href
);
const { sessionStore } = createLocalFileBackendRuntimeAdapters({
  providerId: "fake", rootDir, encryptionKey: new Uint8Array(32).fill(9),
});
if (mode === "hold-lock") {
  const { LocalFileProviderLock } = await import(pathToFileURL(join(repo, "src/store-local-file/shared/local-file-provider-lock.ts")).href);
  await new LocalFileProviderLock({ rootDir, lockTtlMs: 1 }).run("transaction-session", async () => {
    process.send?.({ ready: true });
    await new Promise<void>(() => {});
  });
  throw new Error("holding_process_must_be_terminated");
}
const ready = new Promise<void>((resolve) => process.once("message", () => resolve()));
process.send?.({ ready: true });
await ready;
const receipt = await sessionStore.write({
  providerInstanceId: "multiprocess-session",
  expectedGeneration: 0,
  nextArtifact: { providerId: "fake", kind: "json-file", formatVersion: "fake-v1", contentType: "application/json",
    bytes: new TextEncoder().encode(mode === "replay" ? "same-fake-session" : `fake-session-${index}`) },
  idempotencyKey: mode === "replay" ? "same-intent" : `intent-${index}`,
  leaseId: mode === "replay" ? "bootstrap" : `bootstrap-${index}`,
});
process.send?.({ receipt });
process.disconnect();
