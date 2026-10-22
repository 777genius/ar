import { fileURLToPath } from "node:url";
import { runRetentionOperationSupervisor } from "./retention-operation-host";

/**
 * Closed entry of the pinned TEST container ONLY. The real retention role has no bootstrap of its own: it is a discriminator
 * of the admitted installation supervisor (`hosted-ordinary-installation-bootstrap.js`, funded packet schemaVersion 3), which
 * is the one process the existing kernel admission accepts. An external process cannot enter the role through this file:
 * the only shape is `--retention-operation <id>`, it requires a packet with `launch.kind: docker_test`, and it is refused
 * when the packet, funded record, container identity or pinned executable do not match. Nothing is read from the environment.
 */
const bootstrapPath = fileURLToPath(new URL("./retention-operation-bootstrap.js", import.meta.url));
const operationId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function held(): never { throw new Error("hosted_retention_operation_held:bootstrap_arguments"); }
/** The held reason goes to stderr (retained container log) and the exit code; never swallowed silently. */
function report(error: unknown): void {
  process.stderr.write(`retention_operation_failed:${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 70;
}

if (process.argv[1] === bootstrapPath) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--retention-operation" && operationId.test(args[1] ?? "")) {
    void runRetentionOperationSupervisor(args[1]!).then(result => { process.exitCode = result.ok ? 0 : 1; }, report);
  } else held();
}
