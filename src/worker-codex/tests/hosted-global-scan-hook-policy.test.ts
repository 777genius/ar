import { describe, expect, it } from "vitest";
import { hostedGlobalScanPreToolUseResult } from "../hosted-global-scan-hook-policy";

const hookInput = (command: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});
const codeModeHookInput = (source: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "exec",
  tool_input: { code: source },
});

describe("hosted global-scan PreToolUse policy", () => {
  it.each([
    ["rg --files /", "tool=rg root=/"],
    ["/usr/bin/rg --files /", "tool=rg root=/"],
    ["cd . && grep -R needle /tmp", "tool=grep root=/tmp"],
    ["env FOO=bar find /var/data -type f", "tool=find root=/var/data"],
    ["find -- / -type f", "tool=find root=/"],
    ['"$SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL" --files /', "tool=rg root=/"],
    ['exec "${SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL:?}" --files /', "tool=rg root=/"],
    ["bash -lc 'rg --files /'", "tool=rg root=/"],
    ["find /var/data/../data -type f", "tool=find root=/var/data/../data"],
  ])("blocks %s", (command, evidence) => {
    const result = hostedGlobalScanPreToolUseResult(hookInput(command));
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain(evidence);
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain(
      "subscription_runtime_global_scan_blocked",
    );
  });

  it.each([
    'TOOL=/usr/bin/rg; exec "$TOOL" --files /',
    'exec "${TOOL}" --files /',
    'rg --files "$ROOT"',
    'find "${SEARCH_ROOT:?}" -type f',
  ])("fails closed for unverifiable host command expansion in %s", (command) => {
    const result = hostedGlobalScanPreToolUseResult(hookInput(command));
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^subscription_runtime_global_scan_unverifiable .*exit_code=64$/,
    );
  });

  it("allows bounded use of a statically known guard-owned executable", () => {
    expect(hostedGlobalScanPreToolUseResult(hookInput(
      'exec "${SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL:?missing}" --files ./src',
    ))).toBeNull();
  });

  it.each([
    "git status --short",
    "rg needle .",
    "find . -type f",
    "grep -R needle ./src",
    "rg --files /var/data/worker-jobs/test-job",
  ])("allows bounded command %s", (command) => {
    expect(hostedGlobalScanPreToolUseResult(hookInput(command))).toBeNull();
  });

  it.each([
    'const r = await tools.exec_command({"cmd":"rg --files /","workdir":"/tmp/job"});',
    'const r = await tools.exec_command({cmd:"/usr/bin/rg --files /"});',
    "const r = await tools.exec_command({cmd:'find /var/data -type f'});",
  ])("blocks nested code-mode command", (source) => {
    expect(
      hostedGlobalScanPreToolUseResult(codeModeHookInput(source))
        ?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  it("allows bounded nested code-mode commands", () => {
    expect(hostedGlobalScanPreToolUseResult(codeModeHookInput(
      'const r = await tools.exec_command({"cmd":"rg needle ."});',
    ))).toBeNull();
  });

  it.each([
    'await (tools.exec_command)({cmd: "rg needle ."});',
    'await (tools["exec_command"])({"cmd": "find . -type f"});',
    'await ((tools[\'exec_command\']))({["cmd"]: `grep needle ./file`});',
  ])("allows static commands through parenthesized member calls", (source) => {
    expect(hostedGlobalScanPreToolUseResult(codeModeHookInput(source))).toBeNull();
  });

  it.each([
    'const scan = "/usr/bin/rg --files /"; await tools.exec_command({cmd: scan});',
    'await tools.exec_command({cmd: `rg --files ${root}`});',
    'await tools["exec_command"]({cmd: "rg needle " + root});',
    'const scan = "/usr/bin/rg --files /"; await (tools.exec_command)({cmd: scan});',
    'await (tools["exec_command"])({cmd: getCommand()});',
    'await (0, tools.exec_command)({cmd: scan});',
    'await (tools).exec_command({cmd: scan});',
    'await tools?.["exec_command"]({cmd: scan});',
    'await tools.exec_command?.({cmd: scan});',
  ])("fails closed for computed nested commands", (source) => {
    const result = hostedGlobalScanPreToolUseResult(codeModeHookInput(source));
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain(
      "subscription_runtime_dynamic_command_blocked",
    );
  });

  it.each([
    String.raw`await tools.exec_command({cmd: '/usr/bin/rg --files \x2f'});`,
    String.raw`await tools.exec_command({cmd: '\x2fusr/bin/rg --files /'});`,
    "await tools.exec_command({cmd: `/usr/bin/rg --files \\u002f`});",
    String.raw`await tools.exec_command({cmd: "find \u{2f} -type f"});`,
    String.raw`await tools.exec_command({cmd: '/usr/bin/rg --files \57'});`,
  ])("decodes JavaScript escapes before validating a static command", (source) => {
    const result = hostedGlobalScanPreToolUseResult(codeModeHookInput(source));
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain(
      "subscription_runtime_global_scan_blocked",
    );
  });

  it.each([
    'await tools.exec_command({cmd: "rg cmd: ."});',
    'const example = {cmd: scan}; await tools.exec_command({cmd: "rg needle ."});',
    'const text = "tools.exec_command({cmd: scan})";',
    'const matcher = /tools\\.exec_command\\(\\{cmd: scan\\}\\)/;',
    '// tools.exec_command({cmd: scan})\nawait tools.exec_command({cmd: "rg needle ."});',
  ])("does not treat unrelated cmd text as a dynamic command", (source) => {
    expect(hostedGlobalScanPreToolUseResult(codeModeHookInput(source))).toBeNull();
  });

  it("ignores non-Bash and malformed events", () => {
    expect(hostedGlobalScanPreToolUseResult(null)).toBeNull();
    expect(hostedGlobalScanPreToolUseResult({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { command: "rg --files /" },
    })).toBeNull();
  });
});
