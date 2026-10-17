#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runProfileIssuerOperation } from "./hosted-fd-collector-profile-issuer";
import type { OrdinaryPriorCollectorProfile } from "./hosted-ordinary-installation-launcher";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { runStageCuratorOperation } from "./hosted-runtime-stage-curator";

/**
 * Root-only operator entry for the two Runtime Host issuers. Each call performs exactly one issuance (the issuers themselves assert the admitted
 * operator and refuse to overwrite); the CLI adds no policy:
 *   hosted-runtime-issuer-cli.js curate-stage <runtimeDirectory> <runtimeSha> <archiveSha256>
 *   hosted-runtime-issuer-cli.js issue-profile <operationId> <runtimeDirectory> <runtimeSha> <absent|PRIVATE_PRIOR_IDENTITY_JSON_PATH>
 */
export type IssuerCliCommand =
  | Readonly<{ command: "curate-stage"; runtimeDirectory: string; runtimeSha: string; archiveSha256: string }>
  | Readonly<{ command: "issue-profile"; operationId: string; runtimeDirectory: string; runtimeSha: string; prior: string }>;
const directory = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/, sha1 = /^[a-f0-9]{40}$/, digest = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function refused(): never { throw new Error("hosted_runtime_issuer_usage"); }

export function parseIssuerCliArgs(argv: readonly string[]): IssuerCliCommand {
  const [command, a, b, c, d, ...extra] = argv;
  if (extra.length) refused();
  if (command === "curate-stage" && a !== undefined && b !== undefined && c !== undefined && d === undefined && directory.test(a) && sha1.test(b) && digest.test(c)) {
    return { command, runtimeDirectory: a, runtimeSha: b, archiveSha256: c };
  }
  if (command === "issue-profile" && a !== undefined && b !== undefined && c !== undefined && d !== undefined && uuid.test(a) && directory.test(b) && sha1.test(c) && (d === "absent" || directory.test(d))) {
    return { command, operationId: a, runtimeDirectory: b, runtimeSha: c, prior: d };
  }
  return refused();
}

/** `absent`, or a private root-owned JSON file with exactly the identity of the already installed profile (kind present + sha256/dev/ino/ctimeMs/mtimeMs). */
export function readPriorProfile(prior: string): OrdinaryPriorCollectorProfile {
  if (prior === "absent") return { kind: "absent" };
  const bytes = readHostedPrivateBytes(prior, 4096);
  if (!bytes) return refused();
  const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "ctimeMs,dev,ino,kind,mtimeMs,sha256" || row["kind"] !== "present" || typeof row["sha256"] !== "string" || !digest.test(row["sha256"]) ||
      ![row["dev"], row["ino"], row["ctimeMs"], row["mtimeMs"]].every(value => typeof value === "number" && Number.isFinite(value))) refused();
  return { kind: "present", sha256: row["sha256"] as string, dev: row["dev"] as number, ino: row["ino"] as number, ctimeMs: row["ctimeMs"] as number, mtimeMs: row["mtimeMs"] as number };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseIssuerCliArgs(process.argv.slice(2));
    const outcome = parsed.command === "curate-stage" ? runStageCuratorOperation(parsed)
      : runProfileIssuerOperation(parsed, readPriorProfile(parsed.prior));
    process.stdout.write(JSON.stringify(outcome) + "\n");
  } catch {
    process.stderr.write("hosted_runtime_issuer_failed\n");
    process.exitCode = 1;
  }
}
