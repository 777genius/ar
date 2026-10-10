import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateReport } from './cohort-audit.mts';

const artifact = dirname(fileURLToPath(import.meta.url));
// Separate finite reader boundary; never part of the required eight namespace cases.
test('complete large mount tables have a separate finite text bound', () => {
  assert.equal(process.platform, 'linux');
  const root = mkdtempSync(join(tmpdir(), 'TEST-mount-table-bound-'));
  try {
    const rows = (count: number): string => Array.from({ length: count }, (_, i) =>
      `${i + 1} 1 0:1 /fixture-${i} /mnt-${i} rw - tmpfs tmpfs rw\n`).join('');
    const large = rows(70_000), excessive = rows(150_000);
    assert.ok(Buffer.byteLength(large) > 2 * 1024 ** 2 && Buffer.byteLength(large) < 8 * 1024 ** 2);
    assert.ok(Buffer.byteLength(excessive) > 8 * 1024 ** 2);
    writeFileSync(join(root, 'mountinfo'), large);
    writeFileSync(join(root, 'excessive'), excessive);
    const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py') })).toString('base64');
    let result: unknown;
    try { result = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c',
      `import base64,json,os,runpy\ni=json.loads(base64.b64decode('${encoded}'));p=runpy.run_path(i['payload']);fd=os.open(i['root'],os.O_RDONLY|os.O_DIRECTORY)\ntry:\n    budget=p['Budget'](10);table,_=p['mount_table'](fd,budget)\n    ordinary=None;oversized=None\n    try:list(p['lines_at'](fd,'mountinfo',p['Budget'](10)))\n    except p['Refusal'] as error:ordinary=str(error)\n    os.rename(i['root']+'/excessive',i['root']+'/mountinfo')\n    try:p['mount_table'](fd,p['Budget'](10))\n    except p['Refusal'] as error:oversized=str(error)\n    print(json.dumps({'rows':len(table),'firstId':table[0]['id'],'lastId':table[-1]['id'],'chargedReads':budget.text_bytes,'ordinary':ordinary,'oversized':oversized}))\nfinally:os.close(fd)`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 4096 }));
    } catch { throw new Error('Finite mount table boundary fixture failed'); }
    assert.deepEqual(result, { rows: 70_000, firstId: 1, lastId: 70_000, chargedReads: Buffer.byteLength(large),
      ordinary: 'TextLimit', oversized: 'TextLimit' });
    const cohort = readFileSync(join(artifact, 'input/fixed-cohort.json'), 'utf8');
    const envelope = { schemaVersion: 1, mode: 'ProcReferences', cohortSha256: '8b0467e9cdf7d83bace82df97893ed77e9f311dcd83110a18cbfcd0fc01a7da4',
      necessaryBytes: 'Unknown', futureAdmissionCoverage: 'Unknown', cleanupEligibility: 'NotEstablished', status: 'Incomplete',
      bounds: { textBytes: 2 * 1024 ** 2, mountTableBytes: 8 * 1024 ** 2, aggregateBytes: 64 * 1024 ** 2 } };
    validateReport(envelope, 'ProcReferences', cohort);
    assert.throws(() => validateReport({ ...envelope, bounds: { ...envelope.bounds, mountTableBytes: 0 } }, 'ProcReferences', cohort));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
