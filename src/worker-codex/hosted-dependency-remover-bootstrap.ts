import { announceHostedFdPrelude } from "../provider-codex/app-server/adapters/hosted-fd-prelude.js";

// Fixed inert three-channel bootstrap. No claim, source, manifest or effect is
// opened before the ORIGINAL FDA one-shot EOF release. UUID selects protected
// history only and never carries actor, owner, unit or permission authority.
if (process.argv.length !== 3 || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(process.argv[2]!)?.[0] !== process.argv[2]) process.exit(70);
const finishPrelude = announceHostedFdPrelude();
try {
  await new Promise<void>((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    process.stdin.on("data", (chunk: Buffer) => {
      if (bytes.length + chunk.length > 128) { reject(new Error("dependency_remover_release_denied")); process.stdin.pause(); return; }
      bytes = Buffer.concat([bytes, chunk]);
    });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => bytes.equals(Buffer.from("subscription-runtime-remover-fd-release-v1\n")) ? resolve() : reject(new Error("dependency_remover_release_denied")));
  });
  finishPrelude();
  const { runCurrentHostedDependencyRemoverActor } = await import("./hosted-current-dependency-origin.js");
  await runCurrentHostedDependencyRemoverActor(process.argv[2]!);
} catch { finishPrelude(); process.exitCode = 70; }
