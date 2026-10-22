import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { createCodexGoalRuntimeEventWriter, codexGoalRuntimeEventObservability } from "../../codex-goal-runtime-events";
import type { RuntimeMetric } from "@vioxen/subscription-runtime/core";

assert.equal(process.platform, "linux", "actual kernel descriptor census requires Linux");
const compiled = process.argv[2]; assert(compiled);
const runtime = await import(pathToFileURL(compiled).href) as {
  createCodexGoalRuntimeEventWriter: typeof createCodexGoalRuntimeEventWriter;
  codexGoalRuntimeEventObservability: typeof codexGoalRuntimeEventObservability;
};
const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-compiled-runtime-event-fd-")));
const eventPath = join(root, "events", "runtime.jsonl");
let observations = 0, samples = 0;
function census(): void {
  samples++;
  for (const fd of readdirSync("/proc/self/fd")) {
    try { if (readlinkSync("/proc/self/fd/" + fd) === eventPath) observations++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
const hook = createHook({ before: census, after: census });
try {
  const writer = runtime.createCodexGoalRuntimeEventWriter({ eventPath, taskId: "TEST-events", terminalCheckpointJobRootDir: root });
  const port = runtime.codexGoalRuntimeEventObservability(writer);
  hook.enable();
  // These callbacks intentionally return void while publication remains queued.
  port.emit({ name: "TEST-observation" });
  port.count("TEST-counter" as RuntimeMetric, 0);
  port.timing("TEST-timing" as RuntimeMetric, 7);
  await writer.write("TEST-flush");
  hook.disable();
  assert(samples > 0, "must sample actual async boundaries");
  assert.equal(observations, 0, "runtime event file remained open across an async census boundary");
  const events = readFileSync(eventPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ["runtime_observability_event", "runtime_metric", "runtime_metric", "TEST-flush"]);
  console.log(JSON.stringify({ status: "passed", eventDescriptorObservations: observations, eventCount: events.length, censusSamples: samples }));
} finally { hook.disable(); rmSync(root, { recursive: true, force: true }); }
