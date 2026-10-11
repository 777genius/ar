import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const cohortSha256 = '8b0467e9cdf7d83bace82df97893ed77e9f311dcd83110a18cbfcd0fc01a7da4';
const payloadSha256 = '2683d36e623c7c7d6a4ca4ab4c0b76521f3d0aab617ff611d6deac74f32590f5';
const machineId = 'd856d40da5ad4e23b4f67773e5942842';
const Mode = { ProcReferences: 'ProcReferences', AllocatedMetadata: 'AllocatedMetadata' } as const;
type Mode = (typeof Mode)[keyof typeof Mode];
type RecordValue = Record<string, unknown>;

enum RequestStage {
  Unknown = 'Unknown', Selection = 'Selection', FrozenInputs = 'FrozenInputs', RequestEncode = 'RequestEncode',
  Transport = 'Transport', Decode = 'Decode', Validation = 'Validation', RequiredEvidence = 'RequiredEvidence',
  SavePrepare = 'SavePrepare', SaveWrite = 'SaveWrite', SavedNotice = 'SavedNotice',
}
// A closed diagnostic carrier has no raw error, cause, stdout, stderr or trace.
class RequestFailure {
  readonly stage: RequestStage;
  constructor(stage: RequestStage) { this.stage = stage; }
}


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
aggregateBytes mountTableBytes mountIoBytes viewHeapBytes viewGroupFds mountCandidatePairs mountBytesRead viewHeapPeakBytes namespaceRootViews allocationEntries outputBytes`.split(/\s+/));
const labels = new Set(`ProcReferences AllocatedMetadata Unknown NotEstablished Incomplete ObservedWindow NotRequested
ObservedRoot Unmeasured ObservedMetadata Pending Joined TargetObject NamespacePathAndObject NamespaceMountRoot
Workspace Dependencies Cwd Root Exe Fd Map DirectMountBinding AncestorExposure AuditOwned ExternalCurrentReference
Directory Regular Symlink ExistingOwnerRouteExpectedMachinePid1Consistent SeparateIntervalsNoHistoricalSubstitution
SequentialWindowNotAbsenceProof ExternalHardlinkAndSymlinkAliasesUncovered DetachedUnobservedNamespacesUncovered
AnonymousKernelObjectsUncovered HistoricalAllocationNotCurrent
CohortRoot CohortCapture CohortFinalJoin TaskDiscovery ProcessScan ProcessView ProcessLink FdEntry MapEntry SelfOrigin ProcVisibility NamespaceCoverage
FinalTaskDiscovery AllocationTree AllocationOutput Request FinalCohort FinalIdentity FinalCapacity Output
Deadline EntryLimit ByteLimit NameEncoding NameLimit DirectoryEntryShape TextLimit LineLimit PathShape AncestorDrift MountIdentityUnknown
AmbiguousMountPath MountShape MountJoinUnknown SymlinkJoinUnknown StatShape LinkLimit PrivilegeOrPlatformUnknown
MachineOrBootMismatch HostProcViewUnknown MachineOrBootDrift OwnNamespaceDrift HistoricalRootMismatch RootAlias
RootMountJoinUnknown WorkspaceMountJoinUnknown WorkspaceDrift TreeDrift MountDrift AmbiguousReference ReferenceObjectMismatch
IdentityLimit NamespaceViewLimit UnclassifiedSelfOrigin FdLimit FdMembershipDrift MapShape ProcessIdentityDrift
TaskMembershipDrift UnexpectedEntryKind NegativeMetadata HardlinkConflict HardlinkLimit DepthLimit MountedEntry
EntryIdentityOrMountDrift EntryDrift DirectoryMembershipDrift RootUnmeasured RequestShape PartitionShape
CohortDigestMismatch CohortShape CapacityDeviceDrift CapacityShape OutputLimit ProcHiddenView ProcCapabilitiesIncomplete UnobservedMountNamespace UnknownError OtherErrno
EACCES EPERM ENOENT ESRCH ENOTDIR ELOOP EINVAL EMFILE ENFILE EIO ENOMEM ESTALE EBADF ENOSYS ENOTSUP EOVERFLOW EAGAIN EINTR ETIMEDOUT`.split(/\s+/));

const exactBounds: Readonly<Record<string, number>> = { mountTableBytes: 8 * 1024 ** 2, mountIoBytes: 1024 ** 3,
  viewHeapBytes: 64 * 1024 ** 2, viewGroupFds: 768, mountCandidatePairs: 16384 };

const pinFacets = ['Device', 'Inode', 'Mode', 'Uid', 'Gid', 'Size', 'LinkCount', 'Blocks', 'Mtime', 'Ctime'] as const;
const identityFacets = ['TaskProcPin', 'StartTicks', 'MountNamespacePin', 'PidNamespacePin', 'UserNamespacePin', 'PhysicalRootPin', 'RootMountIdentity'] as const;
const failureFacets = { DiscoveryCompare: identityFacets, RetainedMountAnchor: identityFacets, FinalMemberCompare: identityFacets,
  AncestorNamed: pinFacets, AncestorHeld: pinFacets, AncestorReopened: [...pinFacets, 'RootMountIdentity'],
  FinalMountDigest: ['DigestMismatch'], MountPoll: ['PollEvent'], OwnFdEnvelope: ['DescriptorRoster'] } as const;
type FailureGate = keyof typeof failureFacets;
const resourceKeys = ['status', 'softBefore', 'hardBefore', 'softAfter', 'hardAfter', 'ownDescriptorCount', 'floor', 'reason'] as const;
for (const key of ['failureFacts', 'gate', 'facet', 'resourceQualification', 'fdEnvelopeFailure', ...resourceKeys]) keys.add(key);
for (const [gate, facets] of Object.entries(failureFacets)) { labels.add(gate); for (const facet of facets) labels.add(facet); }
labels.add('Qualified'); labels.add('Infinity');
function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value); return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function finiteLimit(value: unknown): value is string {
  return typeof value === 'string' && (value === 'Infinity' || /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n);
}
function limitAtLeast(left: string, right: string): boolean {
  return left === 'Infinity' || right !== 'Infinity' && BigInt(left) >= BigInt(right);
}
function validateFailureEvidence(value: RecordValue): void {
  if (Object.hasOwn(value, 'failureFacts')) {
    if (!Array.isArray(value.failureFacts) || value.failureFacts.length > Object.keys(failureFacets).length) throw new Error('Invalid closed failure facts');
    if (value.failureFacts.length && value.status !== 'Incomplete') throw new Error('Failure facts cannot establish complete coverage');
    const gates = new Set<FailureGate>();
    for (const fact of value.failureFacts) {
      if (!object(fact) || !exactKeys(fact, ['gate', 'facet']) || typeof fact.gate !== 'string' || !Object.hasOwn(failureFacets, fact.gate)) throw new Error('Invalid closed failure fact');
      const gate = fact.gate as FailureGate;
      if (gates.has(gate) || typeof fact.facet !== 'string' || !(failureFacets[gate] as readonly string[]).includes(fact.facet)) throw new Error('Invalid closed failure facet');
      gates.add(gate);
    }
  }
  if (Object.hasOwn(value, 'fdEnvelopeFailure') && value.fdEnvelopeFailure !== null) {
    if (value.status !== 'Incomplete') throw new Error('Descriptor refusal cannot establish complete coverage');
    const failure = value.fdEnvelopeFailure;
    if (!object(failure) || !exactKeys(failure, ['ownDescriptorCount', 'reason']) || failure.reason !== 'FdLimit' ||
        !Number.isSafeInteger(failure.ownDescriptorCount) || typeof failure.ownDescriptorCount !== 'number' ||
        failure.ownDescriptorCount < 0 || failure.ownDescriptorCount > 4096 || failure.ownDescriptorCount + 3 + 7 <= 1024) throw new Error('Invalid owned descriptor envelope failure');
  }
  if (!Object.hasOwn(value, 'resourceQualification')) return;
  const q = value.resourceQualification;
  if (!object(q) || !exactKeys(q, resourceKeys) || q.floor !== 4096 || typeof q.status !== 'string' || !['Qualified', 'Unknown', 'NotRequested'].includes(q.status) ||
      q.reason !== null && q.reason !== 'FdLimit' && q.reason !== 'Unknown') throw new Error('Invalid resource qualification');
  if (value.mode !== 'ProcReferences' && q.status !== 'NotRequested') throw new Error('Resource qualification mode mismatch');
  if (q.status === 'Unknown' && value.status !== 'Incomplete') throw new Error('Unknown resource qualification cannot establish complete coverage');
  for (const key of ['softBefore', 'hardBefore', 'softAfter', 'hardAfter'] as const) {
    if (q[key] !== null && !finiteLimit(q[key])) throw new Error('Invalid resource limit');
  }
  if (q.ownDescriptorCount !== null && (typeof q.ownDescriptorCount !== 'number' || !Number.isSafeInteger(q.ownDescriptorCount) || q.ownDescriptorCount < 0 || q.ownDescriptorCount > 4096)) throw new Error('Invalid owned descriptor count');
  if (typeof q.softBefore === 'string' && typeof q.hardBefore === 'string' && !limitAtLeast(q.hardBefore, q.softBefore) ||
      typeof q.softAfter === 'string' && typeof q.hardAfter === 'string' && !limitAtLeast(q.hardAfter, q.softAfter)) throw new Error('Invalid soft/hard relation');
  if (typeof q.hardBefore === 'string' && typeof q.hardAfter === 'string' && q.hardBefore !== q.hardAfter) throw new Error('Resource qualification changed hard limit');
  if (q.status === 'NotRequested') {
    if (value.mode === 'ProcReferences' && value.status !== 'Incomplete') throw new Error('Unqualified process resource coverage');
    if (resourceKeys.some(key => key !== 'status' && key !== 'floor' && q[key] !== null)) throw new Error('Unexpected unrequested resource evidence');
  } else if (q.status === 'Qualified') {
    if (typeof q.softBefore !== 'string' || typeof q.hardBefore !== 'string' || typeof q.softAfter !== 'string' || typeof q.hardAfter !== 'string' ||
        typeof q.ownDescriptorCount !== 'number' || q.reason !== null || q.hardAfter !== q.hardBefore || !limitAtLeast(q.softAfter, '4096') ||
        q.softAfter !== (limitAtLeast(q.softBefore, '4096') ? q.softBefore : '4096') || !limitAtLeast(q.softAfter, String(q.ownDescriptorCount + 614 + 768 + 300))) throw new Error('Unproved resource qualification');
  } else if (q.reason !== 'FdLimit' && q.reason !== 'Unknown') throw new Error('Unknown resource qualification lacks closed reason');
}

export function validateReport(value: unknown, expectedMode: Mode, cohortJson: string): asserts value is RecordValue {
  if (!object(value) || value.schemaVersion !== 1 || value.mode !== expectedMode || value.cohortSha256 !== cohortSha256 ||
      value.necessaryBytes !== 'Unknown' || value.futureAdmissionCoverage !== 'Unknown' || value.cleanupEligibility !== 'NotEstablished') {
    throw new Error('Invalid sanitized observation envelope');
  }
  validateFailureEvidence(value);
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
        if (Object.hasOwn(exactBounds, childKey) && child !== exactBounds[childKey]) throw new Error('Invalid mount view bound');
        inspect(child, childKey);
      }
      return;
    }
    throw new Error('Invalid sanitized result value');
  };
  inspect(value);
}

export function main(args: readonly string[]): void {
  let stage: RequestStage = RequestStage.Unknown;
  try {
    stage = RequestStage.Selection;
    const selection = parseMode(args);
    stage = RequestStage.FrozenInputs;
    const cohortBytes = readFileSync(join(root, 'input/fixed-cohort.json'));
    const payload = readFileSync(join(root, 'audit-payload.py'));
    if (createHash('sha256').update(cohortBytes).digest('hex') !== cohortSha256 ||
        createHash('sha256').update(payload).digest('hex') !== payloadSha256) throw new Error('Frozen input digest mismatch');
    stage = RequestStage.RequestEncode;
    const cohortJson = cohortBytes.toString('utf8');
    const request = { version: 1, ...selection, cohortSha256, cohortJson };
    const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
    const program = `import base64, json\nREQUEST=json.loads(base64.b64decode('${encoded}'))\n${payload.toString('utf8')}`;
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=5m',
      '-o', 'ControlPath=/Users/belief/.ssh/controlmasters/a-%C', 'workers-fsn1-01', 'sudo -n /usr/bin/python3 -B -'];
    // One foreground read-only request. Transport failure is not an empty observation.
    stage = RequestStage.Transport;
    const raw = execFileSync('ssh', sshArgs, { input: program, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    stage = RequestStage.Decode;
    const result: unknown = JSON.parse(raw);
    stage = RequestStage.Validation;
    validateReport(result, selection.mode, cohortJson);
    stage = RequestStage.RequiredEvidence;
    if (!['failureFacts', 'resourceQualification', 'fdEnvelopeFailure'].every(key => Object.hasOwn(result, key))) throw new Error('Missing pinned failure evidence');
    stage = RequestStage.SavePrepare;
    const out = join(root, 'observations'); mkdirSync(out, { recursive: true, mode: 0o700 });
    const filename = `${selection.mode}-${selection.partition ?? 'all'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const saved = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(saved) > 2 * 1024 * 1024) throw new Error('Sanitized output byte bound exceeded');
    stage = RequestStage.SaveWrite;
    writeFileSync(join(out, filename), saved, { flag: 'wx', mode: 0o600 });
    stage = RequestStage.SavedNotice;
    console.log(`Saved sanitized ${selection.mode} observation; needed bytes remain Unknown and cleanup NotEstablished.`);
    if (result.status === 'Incomplete') process.exitCode = 1;
  } catch { throw new RequestFailure(stage); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error: unknown) {
    const stage = error instanceof RequestFailure && Object.values(RequestStage).some(value => value === error.stage)
      ? error.stage : RequestStage.Unknown;
    console.error(`Bounded read-only request failed at ${stage}; needed bytes remain Unknown; no empty-result or cleanup inference.`);
    process.exitCode = 1;
  }
}
