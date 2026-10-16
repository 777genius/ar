import { onboardHostedMimoProject } from "./hosted-mimo-project-bridge-onboard";
import { submitHostedMimoProjectBridge, executeHostedMimoProjectBridgeOperation, operationErrorCode } from "./hosted-mimo-project-bridge-operation";
const chunks: Buffer[] = [];
let size = 0;
try {
  if (process.argv[2] === "--prepare-project" && process.argv.length === 4) {
    const { prepareHostedMimoProject } = await import("./hosted-mimo-project-bridge-prepare");
    process.stdout.write(JSON.stringify(await prepareHostedMimoProject(process.argv[3]!)) + "\n");
  } else if (process.argv[2] === "--render-attachment" && process.argv.length === 4) {
    // Pure and unprivileged: reads the card, prints files for review, touches nothing else.
    const { renderMimoAttachmentFromFile } = await import("./hosted-mimo-project-attachment-file");
    const rendered = renderMimoAttachmentFromFile(process.argv[3]!);
    process.stdout.write(JSON.stringify(rendered) + "\n");
    if (!rendered.ok) process.exitCode = 1;
  } else if (process.argv[2] === "--advance-source" && (process.argv.length === 4 && process.argv[3] !== "--dry-run" || process.argv.length === 5 && process.argv[3] === "--dry-run")) {
    const { advanceHostedMimoProjectSource } = await import("./hosted-mimo-project-bridge-advance");
    process.stdout.write(JSON.stringify(await advanceHostedMimoProjectSource(process.argv[process.argv.length - 1]!, { dryRun: process.argv.length === 5 })) + "\n");
  } else if (process.argv[2] === "--resume-project-preparation" && process.argv.length === 4) {
    // No generic transport can prove that the original producer is closed.
    throw new Error("mimo_project_bridge_prepare_resume_refused");
  } else if (process.argv[2] === "--reconcile-interrupted-create" && process.argv.length === 4) {
    const { reconcileHostedMimoInterruptedCreate } = await import("./hosted-mimo-interrupted-create-reconciliation");
    process.stdout.write(JSON.stringify(await reconcileHostedMimoInterruptedCreate(process.argv[3]!)) + "\n");
  } else if (process.argv[2] === "--recover-controller" && process.argv.length === 4) {
    const { recoverHostedMimoController } = await import("./hosted-mimo-project-controller-recovery");
    process.stdout.write(JSON.stringify(await recoverHostedMimoController(process.argv[3]!)) + "\n");
  } else if (process.argv[2] === "--onboard" && process.argv.length === 4) {
    process.stdout.write(JSON.stringify(await onboardHostedMimoProject(process.argv[3]!)) + "\n");
  } else if (process.argv[2] === "--execute-owned" && process.argv.length === 4) {
    if (!await executeHostedMimoProjectBridgeOperation(process.argv[3]!)) process.exitCode = 1;
  } else {
  if (process.argv.length !== 2) throw new Error("mimo_project_bridge_request_invalid");
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 65536) throw new Error("mimo_project_bridge_request_invalid");
    chunks.push(bytes);
  }
  const result = await submitHostedMimoProjectBridge(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  }
} catch (error) {
  const message = operationErrorCode(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exitCode = 1;
}
