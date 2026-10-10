import { expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine, CodexJsonAgentDriver } from "@vioxen/subscription-runtime/provider-codex";
import { StaticRunner } from "../../provider-codex/tests/codex-provider-test-support";
import { web, completed, fixture } from "../../provider-codex/tests/app-server/native-web-test-support";
import { assertNativeWebHostExport } from "./native-web-host-export-support";

// d38's real managed mapper and actual goal Host latest-result dropped native
// observations despite generic task codecs retaining them. Exercise the full
// transport -> runner/engine -> driver -> managed -> Host writer dataflow.
it.each([
  { logical: false, failed: false, large: false, item: true },
  { logical: true, failed: false, large: false, item: true },
  { logical: false, failed: false, large: true, item: true },
  { logical: false, failed: true, large: false, item: true },
  { logical: false, failed: true, large: false, item: false },
])('exports trusted transport to actual Host (logical=$logical, failed=$failed, prefix=$large, item=$item)', async ({ logical, failed, large, item }) => {
  const f = await fixture((thread, turn) => item ? [completed(thread, turn, web('web-1', large ? { results: ['PRIVATE'.repeat(20_000)] } : {}))] : [], { failed, goals: ['complete'] });
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: logical, maxGoalTurns: 2 });
  const driver = new CodexJsonAgentDriver({ engine, model: 'test', sessionMaterializer: {
    mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: async () => {} }),
  } });
  try {
    const result = await driver.runTask({ session: { kind: 'opaque-bytes', providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' }, task: { kind: 'structured-prompt', prompt: 'TEST' }, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal,
      ...(logical ? { logicalThread: { threadId: 'TEST-logical', onCheckpoint: async () => {} } } : {}),
    });
    expect(result.status).toBe(failed ? 'failed' : 'completed');
    expect(result.telemetry?.nativeWeb?.turns[0]?.records).toHaveLength(item ? 1 : 0);
    await assertNativeWebHostExport(result);
    if (item) expect(result.telemetry?.nativeWeb?.turns[0]?.records[0]?.resultSummary?.digestScope).toBe(large ? 'prefix_reserialized_json' : 'complete_reserialized_json');
  } finally { await driver.dispose(); await f.close(); }
});
