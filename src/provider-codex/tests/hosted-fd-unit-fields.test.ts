import { expect, it } from "vitest";
import { decodeHostedFdUnitFields } from "../app-server/adapters/hosted-fd-observation";
import { SystemdArrayProperty as Property, SystemdArraySignature as Signature,
  type SystemdEmptyArrayFact } from "../app-server/adapters/systemd-service-arrays";

// Independent v255 text fixture: the custom printers omit all seven empty
// arrays. Regression red: missing text is silently converted to zero, or the
// real measured typed zeros cannot complete that legitimate lossy observation.
const text = "Id=subscription-runtime-ordinary-12345678-1234-1234-1234-123456789abc.service\n" +
  "InvocationID=12345678123412341234123456789abc\nControlGroup=/system.slice/example.service\nMainPID=12\n" +
  "ActiveState=active\nFileDescriptorStoreMax=0\nNFileDescriptorStore=0\nTriggeredBy=\n" +
  "UnsetEnvironment=LD_PRELOAD NODE_OPTIONS\nPassEnvironment=\n" +
  "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /runtime/bootstrap.js ; ignore_errors=no ; }\nRootDirectory=\n";
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
  expect(rows.size).toBe(12);
  for (const name of arrayNames) expect(rows.has(name)).toBe(false);
});
it("completes exactly the seven FDA slots including ExecCondition", () => {
  const rows = decodeHostedFdUnitFields(text, zeros);
  expect(rows.size).toBe(19);
  for (const name of arrayNames) expect(rows.get(name)).toBe("");
  expect(rows.get("ExecStart")).toBe("{ path=/usr/bin/node ; argv[]=/usr/bin/node /runtime/bootstrap.js ; ignore_errors=no ; }");
  expect(rows.get("MainPID")).toBe("12");
});
it("requires measured zeros even when systemctl prints the empty array rows", () => {
  const completeText = text + arrayNames.map(name => `${name}=\n`).join("");
  expect(decodeHostedFdUnitFields(completeText, zeros).size).toBe(19);
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
