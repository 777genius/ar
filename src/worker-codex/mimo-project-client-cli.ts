import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configureMimoProjectClientRouteFromFile } from "./mimo-project-client-route-publication";

export function runMimoProjectClientCli(argv: readonly string[], write: (bytes: string) => void = bytes => { process.stdout.write(bytes); }): number {
  try {
    if (argv.length !== 2 || argv[0] !== "--configure-route") throw new Error("mimo_project_client_command_invalid");
    write(JSON.stringify(configureMimoProjectClientRouteFromFile(argv[1]!)) + "\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error && /^mimo_project_client_[a-z_]+$/.test(error.message)
      ? error.message : "mimo_project_client_publication_failed";
    write(JSON.stringify({ ok: false, error: message }) + "\n");
    return 1;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  process.exitCode = runMimoProjectClientCli(process.argv.slice(2));
