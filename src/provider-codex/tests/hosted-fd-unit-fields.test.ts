import { expect, it } from "vitest";
import { decodeHostedFdUnitFields, decodeHostedFdUnitLifecycle } from "../app-server/adapters/hosted-fd-observation";
import { SystemdArrayProperty as Property, SystemdArraySignature as Signature,
  type SystemdEmptyArrayFact } from "../app-server/adapters/systemd-service-arrays";

// Independent v255 text fixture: the custom printers omit all seven empty
// arrays. Regression red: missing text is silently converted to zero, or the
// real measured typed zeros cannot complete that legitimate lossy observation.
const lifecycleText = "Type=exec\nExitType=main\nRemainAfterExit=no\nKillMode=control-group\nSendSIGKILL=yes\n" +
  "Restart=no\nDelegate=no\nProtectControlGroups=no\nTimeoutStopUSec=1min 30s\nKillSignal=15\nFinalKillSignal=9\n";
const text = "Id=subscription-runtime-ordinary-12345678-1234-1234-1234-123456789abc.service\n" +
  "InvocationID=12345678123412341234123456789abc\nControlGroup=/system.slice/example.service\nMainPID=12\n" +
  "ActiveState=active\nFileDescriptorStoreMax=0\nNFileDescriptorStore=0\nTriggeredBy=\n" +
  "UnsetEnvironment=LD_PRELOAD NODE_OPTIONS\nPassEnvironment=\n" +
  "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /runtime/bootstrap.js ; ignore_errors=no ; }\nRootDirectory=\n" + lifecycleText;
const zeros: readonly SystemdEmptyArrayFact[] = [
  { property: Property.ExecCondition, signature: Signature.ExecCommandList, count: 0 },
  { property: Property.ExecStartPre, signature: Signature.ExecCommandList, count: 0 },
  { property: Property.ExecStartPost, signature: Signature.ExecCommandList, count: 0 },
  { property: Property.ExecReload, signature: Signature.ExecCommandList, count: 0 },
  { property: Property.ExecStop, signature: Signature.ExecCommandList, count: 0 },
  { property: Property.ExecStopPost, signature: Signature.ExecCommandList, count: 0 },
  { property: Property.EnvironmentFiles, signature: Signature.EnvironmentFiles, count: 0 },
];
const arrayNames = ["EnvironmentFiles", "ExecCondition", "ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost"];

it("keeps omitted FDA arrays unresolved without measured facts", () => {
  const rows = decodeHostedFdUnitFields(text);
  expect(rows.size).toBe(23);
  for (const name of arrayNames) expect(rows.has(name)).toBe(false);
});
it("completes exactly the seven FDA slots including ExecCondition", () => {
  const rows = decodeHostedFdUnitFields(text, zeros);
  expect(rows.size).toBe(30);
  for (const name of arrayNames) expect(rows.get(name)).toBe("");
  expect(rows.get("ExecStart")).toBe("{ path=/usr/bin/node ; argv[]=/usr/bin/node /runtime/bootstrap.js ; ignore_errors=no ; }");
  expect(rows.get("MainPID")).toBe("12");
});
it("requires measured zeros even when systemctl prints the empty array rows", () => {
  const completeText = text + arrayNames.map(name => `${name}=\n`).join("");
  expect(decodeHostedFdUnitFields(completeText, zeros).size).toBe(30);
  expect(() => decodeHostedFdUnitFields(completeText, zeros.slice(0, 6))).toThrow("hosted_fd_boundary_unresolved");
});
// Regression red: partial/wrong-query/duplicate typed facts fill another slot,
// or a conflicting text row is erased before the original service predicates.
it.each([
  { facts: zeros.slice(0, 6) },
  { facts: [zeros[0]!, zeros[2]!, zeros[1]!, ...zeros.slice(3)] },
  { facts: [zeros[0]!, zeros[0]!, ...zeros.slice(2)] },
  { facts: [...zeros, zeros[0]!] },
  { facts: [{ ...zeros[0]!, signature: Signature.EnvironmentFiles }, ...zeros.slice(1)] },
])("rejects incomplete, misordered or wrong-signature facts %#", ({ facts }) => {
  expect(() => decodeHostedFdUnitFields(text, facts)).toThrow("hosted_fd_boundary_unresolved");
});
it.each([1, -1, "0", null])("rejects nonzero/noncanonical count %s", count => {
  // Malformed wire data at a pure decoder boundary, not a manager/profile mock.
  const facts = JSON.parse(JSON.stringify(zeros)) as SystemdEmptyArrayFact[];
  Object.assign(facts[0]!, { count });
  expect(() => decodeHostedFdUnitFields(text, facts)).toThrow("hosted_fd_boundary_unresolved");
});
it("rejects extra fact fields instead of accepting a widened proof shape", () => {
  const facts = [{ ...zeros[0]!, unrelated: 0 }, ...zeros.slice(1)];
  expect(() => decodeHostedFdUnitFields(text, facts)).toThrow("hosted_fd_boundary_unresolved");
});
it.each([
  text + "ExecCondition={ path=/tmp/hook ; }\n",
  text + "EnvironmentFiles=/tmp/override\n",
  text + "MainPID=12\n",
  text + "UnknownField=\n",
  text + "\n",
  text.replace("MainPID=12\n", ""),
  text.replace("MainPID=12\n", "MainPID\n"),
  text.replace("MainPID=12\n", "MainPID=12\r\n"),
])("rejects conflicting, unknown, duplicate, partial or trailing text %#", input => {
  expect(() => decodeHostedFdUnitFields(input, zeros)).toThrow("hosted_fd_boundary_unresolved");
});

it("copies actual lifecycle facts without substituting provider protection or timeout", () => {
  const ordinary = decodeHostedFdUnitLifecycle(decodeHostedFdUnitFields(text, zeros));
  expect(ordinary).toEqual({ Type: "exec", ExitType: "main", RemainAfterExit: "no", KillMode: "control-group",
    SendSIGKILL: "yes", Restart: "no", Delegate: "no", ProtectControlGroups: "no", TimeoutStopUSec: "90000000",
    KillSignal: "15", FinalKillSignal: "9" });
  expect(Object.isFrozen(ordinary)).toBe(true);
  const provider = decodeHostedFdUnitLifecycle(decodeHostedFdUnitFields(text
    .replace("ProtectControlGroups=no", "ProtectControlGroups=yes").replace("1min 30s", "30s"), zeros));
  expect(provider.ProtectControlGroups).toBe("yes");
  expect(provider.TimeoutStopUSec).toBe("30000000");
  // The original launch must compare these copied facts to its private recipe;
  // decoding ordinary's real 90s observation does not authorize that budget.
  expect(provider).not.toEqual(ordinary);
});

it.each([
  ["Type", "simple"], ["ExitType", "cgroup"], ["RemainAfterExit", "yes"], ["KillMode", "process"],
  ["SendSIGKILL", "no"], ["Restart", "always"], ["Delegate", "yes"], ["ProtectControlGroups", "false"],
  ["KillSignal", "9"], ["FinalKillSignal", "15"],
])("refuses incompatible/noncanonical actual lifecycle %s=%s", (key, value) => {
  const rows = new Map(decodeHostedFdUnitFields(text, zeros)); rows.set(key, value);
  expect(() => decodeHostedFdUnitLifecycle(rows)).toThrow("hosted_fd_boundary_unresolved");
});

it("never fills missing, empty or duplicate lifecycle scalar observations", () => {
  for (const line of lifecycleText.trimEnd().split("\n")) {
    const key = line.slice(0, line.indexOf("=")), rows = new Map(decodeHostedFdUnitFields(text, zeros));
    expect(() => decodeHostedFdUnitFields(text.replace(line + "\n", ""), zeros)).toThrow();
    expect(() => decodeHostedFdUnitFields(text + line + "\n", zeros)).toThrow();
    rows.delete(key); expect(() => decodeHostedFdUnitLifecycle(rows)).toThrow();
    rows.set(key, ""); expect(() => decodeHostedFdUnitLifecycle(rows)).toThrow();
  }
});

it.each([
  ["1us", "1"], ["1.001ms", "1001"], ["12.345678s", "12345678"], ["1min 1.000001s", "61000001"],
  ["2h 3min 4s", "7384000000"], ["1d", "86400000000"],
])("decodes finite systemctl duration %s exactly without floating rounding", (duration, usec) => {
  const rows = new Map(decodeHostedFdUnitFields(text, zeros)); rows.set("TimeoutStopUSec", duration);
  expect(decodeHostedFdUnitLifecycle(rows).TimeoutStopUSec).toBe(usec);
});

it.each(["", "infinity", "0", "0s", "-1s", "30", "30sec", "30s ", " 30s", "1min  30s", "30s 1min",
  "30s 1s", "01s", "1.0000001s", "1.0001ms", "1.5min", "1s;Restart=always", "18446744073709551615us"])
  ("refuses absent, unlimited, ambiguous, lossy or conflicting stop duration %s", duration => {
    const rows = new Map(decodeHostedFdUnitFields(text, zeros)); rows.set("TimeoutStopUSec", duration);
    expect(() => decodeHostedFdUnitLifecycle(rows)).toThrow("hosted_fd_boundary_unresolved");
  });

it("retains changed finite timer facts for the original readiness/release drift comparison", () => {
  const before = new Map(decodeHostedFdUnitFields(text, zeros)), after = new Map(before);
  after.set("TimeoutStopUSec", "1min 30.000001s");
  expect(decodeHostedFdUnitLifecycle(after).TimeoutStopUSec).toBe("90000001");
  expect(decodeHostedFdUnitLifecycle(after)).not.toEqual(decodeHostedFdUnitLifecycle(before));
});
