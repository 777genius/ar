import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCrashLane } from "../crash-lane-runner.mts";

const childFixture = fileURLToPath(new URL("./crash-lane-child-fixture.mts", import.meta.url));
const run = (mode: string, lane = 0) => runCrashLane(lane, {
  executable: process.execPath,
  args: [childFixture, mode],
  timeoutMs: mode === "complete" ? 2_000 : 500,
  killAfterMs: 100,
});

test("all eight lanes must finish their exact ordered shard lifecycles", async () => {
  for (let lane = 0; lane < 8; lane += 1) assert.equal(await run("complete", lane), 0);
});
test("zero exit with missing shards cannot certify a lane", async () => {
  assert.equal(await run("incomplete"), 1);
});
test("duplicate shard starts cannot reset the active shard budget", async () => {
  assert.equal(await run("duplicate-start"), 1);
});
for (const mode of ["startup-stall", "shard-stall", "gap-stall"]) {
  test(`${mode} is bounded outside the child event loop`, { timeout: 4_000 }, async () => {
    const start = Date.now();
    assert.equal(await run(mode), 1);
    assert.ok(Date.now() - start < 3_000, "supervisor must finish despite the blocked child");
  });
}
test("invalid lane does not launch a certification", async () => {
  await assert.rejects(run("complete", 8), /SHARD_LANE/);
});
