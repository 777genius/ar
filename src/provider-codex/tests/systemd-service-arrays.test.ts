import { describe, expect, it } from "vitest";
import { decodeSystemdEmptyArrays, SystemdServiceArrayKind } from "../app-server/adapters/systemd-service-arrays";

// Independent v255 terse protocol fixtures. These grant no OS authority.
const six = "a(sasbttttuii) 0\na(sasbttttuii) 0\na(sasbttttuii) 0\na(sasbttttuii) 0\na(sasbttttuii) 0\na(sb) 0\n";
describe("fixed typed empty service-array facts", () => {
  it("retains actual named signatures/counts and distinguishes the seventh FDA slot", () => {
    const bus = decodeSystemdEmptyArrays(SystemdServiceArrayKind.Infrastructure, six);
    expect(bus.map(row => row.property)).toEqual(["ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost", "EnvironmentFiles"]);
    expect(bus.map(row => row.signature)).toEqual(["a(sasbttttuii)", "a(sasbttttuii)", "a(sasbttttuii)", "a(sasbttttuii)", "a(sasbttttuii)", "a(sb)"]);
    expect(bus.every(row => row.count === 0 && Object.isFrozen(row))).toBe(true);
    expect(Object.isFrozen(bus)).toBe(true);
    const fd = decodeSystemdEmptyArrays(SystemdServiceArrayKind.FdManaged, "a(sasbttttuii) 0\n" + six);
    expect(fd).toHaveLength(7); expect(fd[0]!.property).toBe("ExecCondition");
    expect(() => decodeSystemdEmptyArrays(SystemdServiceArrayKind.FdManaged, six)).toThrow("unqualified");
  });
  it.each([
    six.replace("a(sasbttttuii) 0", "a(sb) 0"), six.replace("a(sb) 0", "a(sasbttttuii) 0"),
    six.replace("a(sasbttttuii) 0", "a(sasbttttuii) 1"), six.replace(" 0", " 00"),
    six + "\n", "\n" + six, six + "a(sb) 0\n", six.replace(" 0", " 0 ignored"),
    six.slice(0, six.lastIndexOf("a(sb)")), six.replace(/\n/g, "\r\n"),
  ])("rejects malformed, missing, nonzero or extra data without absence inference", reply => {
    expect(() => decodeSystemdEmptyArrays(SystemdServiceArrayKind.Infrastructure, reply)).toThrow("unqualified");
  });
});
