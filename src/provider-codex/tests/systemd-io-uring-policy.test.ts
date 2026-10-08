import { describe, expect, it } from "vitest";
import { assertSystemdIoUringPolicy } from "../app-server/adapters/systemd-service-arrays";

// Red when a manager tuple can omit/change a denial and still pass admission.
const filter = '(bas) false 3 "io_uring_enter:ENOSYS" "io_uring_register:ENOSYS" "io_uring_setup:ENOSYS"';
const reply = `${filter}\nas 1 "native"\nb true\n`;
describe("fixed managed io_uring policy protocol", () => {
  it("accepts the literal v255 typed response", () => {
    expect(() => assertSystemdIoUringPolicy(reply)).not.toThrow();
    expect(() => assertSystemdIoUringPolicy(reply.slice(0, -1))).not.toThrow();
  });
  it.each([
    reply.replace("false", "true"), reply.replace("false 3", "false 0"),
    reply.replace(' "io_uring_setup:ENOSYS"', ""), reply.replace(":ENOSYS", ""),
    reply.replace("io_uring_setup", "io_uring_enter"), reply.replace("io_uring_setup", "unknown"),
    reply.replace("ENOSYS", "EPERM"), reply.replace('as 1 "native"', 'as 2 "native" "x86"'),
    reply.replace('"native"', '"x86-64"'), reply.replace("b true", "b false"),
    reply.replace("(bas)", "as"), reply.replace("false 3", "false 4"),
    reply.replace('"io_uring_enter:ENOSYS"', '"@io-event:ENOSYS"'),
    reply.replace("\nb true", ""), reply + "\n", "", reply.replaceAll("\n", "\r\n"),
  ])("rejects incomplete or conflicting kernel policy facts", value => {
    expect(() => assertSystemdIoUringPolicy(value)).toThrow("systemd_service_arrays_unqualified");
  });
});
