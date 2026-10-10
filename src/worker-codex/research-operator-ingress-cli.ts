import { enrollResearchOperatorRequest } from "./research-operator-binding";
import { executeResearchOperator, submitResearchOperator } from "./research-operator-ingress-owner";
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--enroll-owned" && args.length === 6) return enrollResearchOperatorRequest(args[1]!, args[2]!, args[3]!, args[4]!, Number(args[5]));
  if (args[0] === "--execute-owned" && args.length === 3) return executeResearchOperator(args[1]!, args[2]!);
  if (args.length) throw new Error("research_operator_request_invalid");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 65536) throw new Error("research_operator_request_invalid");
    chunks.push(bytes);
  }
  return submitResearchOperator(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
}
main().then(result => process.stdout.write(JSON.stringify({ ok: true, result }) + "\n"), error => {
  // Trusted authority errors can contain filesystem paths; preserve finite codes only.
  const message = error instanceof Error && /^research_operator_[a-z_]+$/.test(error.message) ? error.message : "research_operator_outcome_unknown";
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n"); process.exitCode = 1;
});
