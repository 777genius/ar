import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HostedManagedProviderResult, HostedManagedProviderWaitKind, parseHostedManagedProviderTerminalFacts, parseHostedOrdinaryReaderTerminalFacts } from "../hosted-managed-provider-terminal-facts";

const invocation = "1234567890abcdef1234567890abcdef";
const id = "12345678-1234-1234-1234-123456789abc";
const sites = [
  { file: "hosted-ordinary-reader-parent-completion.ts", selection: "receipt.unit", unit: `subscription-runtime-ordinary-${id}.service`, parse: parseHostedOrdinaryReaderTerminalFacts },
  { file: "hosted-ordinary-reader-parent-completion.ts", selection: "observed.unit", unit: `subscription-runtime-ordinary-${id}.service`, parse: parseHostedOrdinaryReaderTerminalFacts },
  { file: "hosted-ordinary-provider-failure-recovery.ts", selection: "row.unit", unit: `subscription-runtime-hosted-${id}.service`, parse: parseHostedManagedProviderTerminalFacts },
] as const;

function originalManagerArguments(file: string, selection: string, unit: string): readonly string[] {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const calls = [...source.matchAll(/spawnSync\("\/usr\/bin\/systemctl",(\[[^\]]+\])/g)]
    .map(match => match[1]!).filter(args => args.endsWith(`${selection}]`));
  if (calls.length !== 1) throw new Error("original_manager_call_not_unique");
  return JSON.parse(calls[0]!.replace(selection, JSON.stringify(unit))) as readonly string[];
}

// Model only systemctl show's documented omission of empty values. The unit
// state is an independently fixed fixture; this is no Linux/Native receipt.
function managerOutput(args: readonly string[], unit: string): string {
  const fields: Readonly<Record<string, string>> = {
    Id: unit, InvocationID: invocation, ActiveState: "inactive", SubState: "dead",
    MainPID: "0", ControlPID: "0", Job: "", ExecMainCode: "1", ExecMainStatus: "0", Result: "success",
  };
  const requested = args.find(arg => arg.startsWith("--property="))?.slice("--property=".length).split(",");
  if (!requested) throw new Error("original_manager_properties_missing");
  return requested.filter(key => args.includes("--all") || fields[key] !== "")
    .map(key => `${key}=${fields[key]}\n`).join("");
}

describe("original ordinary completion manager-output contract", () => {
  for (const site of sites) {
    it(`preserves present empty Job at ${site.file}:${site.selection}`, () => {
      const args = originalManagerArguments(site.file, site.selection, site.unit);
      expect(site.parse(site.unit, managerOutput(args, site.unit))).toEqual({
        unit: site.unit, invocationId: invocation, kind: HostedManagedProviderWaitKind.Exited, status: 0, result: HostedManagedProviderResult.Success,
      });
    });
    it(`keeps missing/queued/duplicate Job refused at ${site.file}:${site.selection}`, () => {
      const text = managerOutput(["--all", "--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result"], site.unit);
      expect(() => site.parse(site.unit, text.replace("Job=\n", ""))).toThrow();
      expect(() => site.parse(site.unit, text.replace("Job=\n", "Job=1\n"))).toThrow();
      expect(() => site.parse(site.unit, text + "Job=\n")).toThrow();
    });
  }
});
