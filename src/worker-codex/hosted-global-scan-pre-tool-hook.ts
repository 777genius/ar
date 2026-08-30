import { stdin, stdout } from "node:process";
import { hostedGlobalScanPreToolUseResult } from "./hosted-global-scan-hook-policy";

const maxInputBytes = 1024 * 1024;
const chunks: Buffer[] = [];
let inputBytes = 0;

for await (const chunk of stdin) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  inputBytes += buffer.byteLength;
  if (inputBytes > maxInputBytes) process.exit(64);
  chunks.push(buffer);
}

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  const result = hostedGlobalScanPreToolUseResult(input);
  if (result !== null) stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.exitCode = 64;
}
