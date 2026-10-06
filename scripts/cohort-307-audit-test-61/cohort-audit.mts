import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const cohortSha256 = '8b0467e9cdf7d83bace82df97893ed77e9f311dcd83110a18cbfcd0fc01a7da4';
const payloadSha256 = 'd9eb2396fbdd50b846820cd136b0eb78d23ef4afa67a8e51e2b62942fcf1133d';
const machineId = 'd856d40da5ad4e23b4f67773e5942842';
const Mode = { ProcReferences: 'ProcReferences', AllocatedMetadata: 'AllocatedMetadata' } as const;
type Mode = (typeof Mode)[keyof typeof Mode];
type RecordValue = Record<string, unknown>;

export function parseMode(args: readonly string[]): { mode: Mode; partition: number | null } {
  if (args.length === 1 && args[0] === 'proc') return { mode: Mode.ProcReferences, partition: null };
  if (args.length === 2 && args[0] === 'allocated' && /^(0|[1-9][0-9]?)$/.test(args[1] ?? '')) {
    const partition = Number(args[1]);
    if (partition < 77) return { mode: Mode.AllocatedMetadata, partition };
  }
  throw new Error('Expected proc or allocated PARTITION_0_TO_76; no automatic second request');
}

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// This is output sanitation, never a permit or a substitute for native provenance.
const keys = new Set(`schemaVersion mode startedAt finishedAt cohortSha256 necessaryBytes futureAdmissionCoverage
cleanupEligibility visibleProcCoverage allocation proc capacityBefore capacityAfter limitations machineId bootId
hostProcProvenance finalMachineBootNamespaceBindingVerified errors errorRecordsOmitted metadataBytesRead accountedBytes enumeratedEntries
status cohortRootObservations cohortRootsUnobserved bounds coverageIssues phase reason pid tid cohortIndex count dev ino availableBytes signedAvailableBytes blockSize
leadersDiscovered tasksDiscovered tasksObserved namespaceRootViewsObserved counts observations matches externalCurrentReferences
auditOwnedReferences ancestorExposures fdEntries mapEntries matchesOmitted observationsOmitted namespaceFdTargetsUnobserved startTicks name path scope kind basis bucket
auditCreatedHandle join cohortFinalJoin partition partitions trees crosslinks crosslinksOmitted aggregation crosslinksStatus measurement
allocatedUniqueWithinPartitionBytes apparentUniqueWithinPartitionBytes uniqueInodes entryKindsObserved Directory Regular Symlink
allocatedBytes nlink size ctimeNs mtimeNs members observedLinks seconds identities fdEntriesPerTask fdEntriesTotal textBytes
aggregateBytes namespaceRootViews allocationEntries outputBytes`.split(/\s+/));
const labels = new Set(`ProcReferences AllocatedMetadata Unknown NotEstablished Incomplete ObservedWindow NotRequested
ObservedRoot Unmeasured ObservedMetadata Pending Joined TargetObject NamespacePathAndObject NamespaceMountRoot
Workspace Dependencies Cwd Root Exe Fd Map DirectMountBinding AncestorExposure AuditOwned ExternalCurrentReference
Directory Regular Symlink ExistingOwnerRouteExpectedMachinePid1Consistent SeparateIntervalsNoHistoricalSubstitution
SequentialWindowNotAbsenceProof ExternalHardlinkAndSymlinkAliasesUncovered DetachedUnobservedNamespacesUncovered
AnonymousKernelObjectsUncovered HistoricalAllocationNotCurrent
CohortRoot CohortCapture CohortFinalJoin TaskDiscovery ProcessScan ProcessView ProcessLink FdEntry MapEntry SelfOrigin ProcVisibility NamespaceCoverage
FinalTaskDiscovery AllocationTree AllocationOutput Request FinalCohort FinalIdentity FinalCapacity Output
Deadline EntryLimit ByteLimit NameEncoding NameLimit TextLimit LineLimit PathShape AncestorDrift MountIdentityUnknown
AmbiguousMountPath MountShape MountJoinUnknown SymlinkJoinUnknown StatShape LinkLimit PrivilegeOrPlatformUnknown
MachineOrBootMismatch HostProcViewUnknown MachineOrBootDrift OwnNamespaceDrift HistoricalRootMismatch RootAlias
RootMountJoinUnknown WorkspaceMountJoinUnknown WorkspaceDrift TreeDrift MountDrift AmbiguousReference ReferenceObjectMismatch
IdentityLimit NamespaceViewLimit UnclassifiedSelfOrigin FdLimit FdMembershipDrift MapShape ProcessIdentityDrift
TaskMembershipDrift UnexpectedEntryKind NegativeMetadata HardlinkConflict HardlinkLimit DepthLimit MountedEntry
EntryIdentityOrMountDrift EntryDrift DirectoryMembershipDrift RootUnmeasured RequestShape PartitionShape
CohortDigestMismatch CohortShape CapacityDeviceDrift CapacityShape OutputLimit ProcHiddenView ProcCapabilitiesIncomplete UnobservedMountNamespace UnknownError OtherErrno
EACCES EPERM ENOENT ESRCH ENOTDIR ELOOP EINVAL EMFILE ENFILE EIO ENOMEM ESTALE EBADF ENOSYS ENOTSUP EOVERFLOW EAGAIN EINTR ETIMEDOUT`.split(/\s+/));

export function validateReport(value: unknown, expectedMode: Mode, cohortJson: string): asserts value is RecordValue {
  if (!object(value) || value.schemaVersion !== 1 || value.mode !== expectedMode || value.cohortSha256 !== cohortSha256 ||
      value.necessaryBytes !== 'Unknown' || value.futureAdmissionCoverage !== 'Unknown' || value.cleanupEligibility !== 'NotEstablished') {
    throw new Error('Invalid sanitized observation envelope');
  }
  const cohort: unknown = JSON.parse(cohortJson);
  if (!object(cohort) || !Array.isArray(cohort.cohort)) throw new Error('Invalid frozen cohort');
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const row of cohort.cohort) {
    if (!object(row) || typeof row.name !== 'string' || typeof row.workspace !== 'string' || typeof row.dependencies !== 'string') {
      throw new Error('Invalid frozen cohort');
    }
    names.add(row.name); paths.add(row.workspace); paths.add(row.dependencies);
  }
  let nodes = 0;
  const inspect = (item: unknown, key?: string): void => {
    if (++nodes > 262144) throw new Error('Sanitized result node bound exceeded');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || item < 0) throw new Error('Invalid numeric observation');
      return;
    }
    if (typeof item === 'string') {
      if (key === 'name' ? names.has(item) : key === 'path' ? paths.has(item) :
          key === 'machineId' ? item === machineId : key === 'cohortSha256' ? item === cohortSha256 :
          key === 'bootId' ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item) :
          key === 'ctimeNs' || key === 'mtimeNs' || key === 'signedAvailableBytes' ? /^(0|-?[1-9][0-9]{0,31})$/.test(item) :
          key === 'startedAt' || key === 'finishedAt' ? /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,20}\+00:00$/.test(item) :
          labels.has(item) || /^(0|[1-9][0-9]{0,31})$/.test(item)) return;
      throw new Error('Unexpected string in sanitized result');
    }
    if (Array.isArray(item)) { for (const child of item) inspect(child, key); return; }
    if (object(item)) {
      for (const [childKey, child] of Object.entries(item)) {
        if (!keys.has(childKey)) throw new Error('Unknown sanitized result field');
        inspect(child, childKey);
      }
      return;
    }
    throw new Error('Invalid sanitized result value');
  };
  inspect(value);
}

export function main(args: readonly string[]): void {
  const selection = parseMode(args);
  const cohortBytes = readFileSync(join(root, 'input/fixed-cohort.json'));
  const payload = readFileSync(join(root, 'audit-payload.py'));
  if (createHash('sha256').update(cohortBytes).digest('hex') !== cohortSha256 ||
      createHash('sha256').update(payload).digest('hex') !== payloadSha256) throw new Error('Frozen input digest mismatch');
  const cohortJson = cohortBytes.toString('utf8');
  const request = { version: 1, ...selection, cohortSha256, cohortJson };
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
  const program = `import base64, json\nREQUEST=json.loads(base64.b64decode('${encoded}'))\n${payload.toString('utf8')}`;
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=5m',
    '-o', 'ControlPath=/Users/belief/.ssh/controlmasters/a-%C', 'workers-fsn1-01', 'sudo -n /usr/bin/python3 -B -'];
  // One foreground read-only request. Transport failure is not an empty observation.
  const raw = execFileSync('ssh', sshArgs, { input: program, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  const result: unknown = JSON.parse(raw);
  validateReport(result, selection.mode, cohortJson);
  const out = join(root, 'observations'); mkdirSync(out, { recursive: true, mode: 0o700 });
  const filename = `${selection.mode}-${selection.partition ?? 'all'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const saved = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(saved) > 2 * 1024 * 1024) throw new Error('Sanitized output byte bound exceeded');
  writeFileSync(join(out, filename), saved, { flag: 'wx', mode: 0o600 });
  console.log(`Saved sanitized ${selection.mode} observation; needed bytes remain Unknown and cleanup NotEstablished.`);
  if (result.status === 'Incomplete') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch { console.error('Bounded read-only request failed or returned invalid data; no empty-result or cleanup inference.'); process.exitCode = 1; }
}
