import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeIoUringControlFailure, ioUringControlProcessFacts } from "./io-uring.ts";

// Independent finite wire fixtures. They assert parsing/redaction, not kernel effects.
const setupDenied = "TEST_uring_control_failure_v1 1 -1 1 0 0 0 1 -1 9 1 -1 9 0 0 2 0\n";
const closeFailed = "TEST_uring_control_failure_v1 1 3 0 1 -1 4 0 0 0 0 0 0 1 0 2 0\n";
test("observed setup failure and unattempted close remain separate facts", () => {
  assert.deepEqual(decodeIoUringControlFailure(setupDenied), { setup: { returnValue: -1, errno: 1 }, close: null,
    enter: { returnValue: -1, errno: 9 }, register: { returnValue: -1, errno: 9 },
    child: { noNewPrivs: { returnValue: 0, errno: 0 }, seccomp: { returnValue: 2, errno: 0 } } });
  const trace = decodeIoUringControlFailure(closeFailed);
  assert.deepEqual(trace.close, { returnValue: -1, errno: 4 }); assert.equal(trace.enter, null); assert.equal(trace.register, null);
});
test("rejects forged attempts, errno, partial/extra/noncanonical/unsafe rows", () => {
  const change = (row: string, index: number, value: string) => {
    const tokens = row.trimEnd().split(" "); tokens[index + 1] = value; return tokens.join(" ") + "\n";
  };
  for (const row of [setupDenied + "\n", setupDenied.trimEnd(), setupDenied.replace("\n", "\r\n"),
    setupDenied.replace("failure_v1", "failure_v2"), setupDenied.replace(" 1 -1", " +1 -1"),
    setupDenied.replace(" 1 -1", " 01 -1"), setupDenied.replace(" -1 1", " -0 1"),
    setupDenied.replace(" 1 -1", " 1.0 -1"), setupDenied.replace(" 1 -1", " 1e0 -1"),
    setupDenied.replace(" 1 -1", " 1  -1"), setupDenied.slice(0, -1) + " 0\n", "", "secret\n",
    change(setupDenied, 0, "0"), change(setupDenied, 0, "2"), change(setupDenied, 1, "-2"),
    change(setupDenied, 1, "2147483648"), change(setupDenied, 1, "9007199254740993"),
    change(setupDenied, 2, "0"), change(setupDenied, 2, "4096"), change(setupDenied, 4, "1"),
    change(setupDenied, 3, "1"), change(setupDenied, 6, "0"), change(setupDenied, 8, "0"),
    change(setupDenied, 12, "2"), change(setupDenied, 13, "1"), change(setupDenied, 14, "3"),
    change(setupDenied, 14, "-1"), change(closeFailed, 7, "1"), change(closeFailed, 9, "1"),
    "TEST_uring_control_failure_v1 1 3 0 0 0 0 1 -1 9 1 -1 9 0 0 2 0\n",
    "TEST_uring_control_failure_v1 1 3 0 1 1 0 1 -1 9 1 -1 9 0 0 2 0\n",
  ]) assert.throws(() => decodeIoUringControlFailure(row), row);
});
test("redacts arbitrary stdio/error/signal while retaining bounded diagnostic classes", () => {
  const result = ioUringControlProcessFacts({ status: 127, signal: "SECRET_signal", error: { code: "SECRET_error" },
    stdout: "SECRET_stdout", stderr: "SECRET_path: error while loading shared libraries: libc.so.6: cannot open shared object file" });
  assert.equal(result.signal, "OTHER"); assert.equal(result.error, "OTHER"); assert.deepEqual(result.record, { state: "malformed" });
  assert.deepEqual(result.stderrClasses, ["loader_missing"]); assert.equal(result.mentionsLibc, true);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  const unknown = ioUringControlProcessFacts({ status: null, signal: "SIGSYS", error: { code: { toString: () => "EACCES" } }, stdout: "", stderr: "" });
  assert.equal(unknown.error, "OTHER"); assert.equal(unknown.signal, "SIGSYS"); assert.deepEqual(unknown.record, { state: "missing" });
  const loader = ioUringControlProcessFacts({ status: 70, signal: null, stdout: setupDenied,
    stderr: "ld-linux-x86-64.so.2: version `GLIBC_2.40' not found. Permission denied" });
  assert.equal(loader.record.state, "observed"); assert.deepEqual(loader.stderrClasses, ["glibc_version_missing", "permission_denied"]);
  assert.equal(loader.mentionsLoader, true); assert.equal(loader.status, 70);
});
