"""Standalone source for review. Default prints plan; --apply-once has kernel-wide effects.
Independent SOURCE review is required before transfer or execution. No retries,
unloads, persistence, policy changes, native fixtures or production activation.
"""
import errno
import select
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import resource
import re
import stat
import struct
import sys
import signal
import threading
import tempfile
import time

MACHINE = 'd856d40da5ad4e23b4f67773e5942842'
BOOT = 'f12bc43a-9252-42d4-919d-85b846a176a8'
KERNEL = '6.8.0-139-generic'
INTENT = pathlib.Path('/var/lib/subscription-runtime-test/quota-prerequisite-20261010-r1')
ENV = {'PATH': '/usr/bin:/usr/sbin:/bin:/sbin', 'LC_ALL': 'C'}
NAMES = ('quota_tree', 'quota_v2')
MODULE_DIR = '/usr/lib/modules/' + KERNEL + '/kernel/fs/quota/'
ARGV = [('/usr/sbin/insmod', MODULE_DIR + name + '.ko.zst') for name in NAMES]
SLOT = 32768
SLOTS = 16
HEADER = struct.Struct('!I32s')
FLOOR = 5368709120
EXPECTED = {'/usr/bin/kmod': {'canonical': '/usr/bin/kmod', 'device': 2306, 'inode': 20477995, 'bytes': 174328, 'uid': 0, 'gid': 0, 'sha256': '5abf732e561c8be9ccd1794940b5d43025b041d4bed1db34782d979e0accc36f', 'mode': 493}, '/usr/lib/x86_64-linux-gnu/libzstd.so.1.5.5': {'canonical': '/usr/lib/x86_64-linux-gnu/libzstd.so.1.5.5', 'device': 2306, 'inode': 20448819, 'bytes': 755864, 'uid': 0, 'gid': 0, 'sha256': '0a2128bc10841fb29e76d08d945864dfb0b6a66da5df6df5d8299197439e54bb', 'mode': 420}, '/usr/lib/x86_64-linux-gnu/liblzma.so.5.4.5': {'canonical': '/usr/lib/x86_64-linux-gnu/liblzma.so.5.4.5', 'device': 2306, 'inode': 20447431, 'bytes': 202904, 'uid': 0, 'gid': 0, 'sha256': '696e868dd0700a19a6d65fc01608ec2d70d3cb91f65710e89180cd2e688f30cb', 'mode': 420}, '/usr/lib/x86_64-linux-gnu/libcrypto.so.3': {'canonical': '/usr/lib/x86_64-linux-gnu/libcrypto.so.3', 'device': 2306, 'inode': 20519242, 'bytes': 5309400, 'uid': 0, 'gid': 0, 'sha256': '6866ed711dab8927e1bf82bf1cd30e828bdfc34f3cc1e83b1c9eb01ce6c37d9a', 'mode': 420}, '/usr/lib/x86_64-linux-gnu/libc.so.6': {'canonical': '/usr/lib/x86_64-linux-gnu/libc.so.6', 'device': 2306, 'inode': 20447787, 'bytes': 2129424, 'uid': 0, 'gid': 0, 'sha256': '3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf', 'mode': 493}, '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2': {'canonical': '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', 'device': 2306, 'inode': 20448604, 'bytes': 236616, 'uid': 0, 'gid': 0, 'sha256': 'c20a2dc8917c755f02b94049356320fe1f62ac7d9f8994731f807d9df39302da', 'mode': 493}, '/usr/lib/modules/6.8.0-139-generic/kernel/fs/quota/quota_tree.ko.zst': {'canonical': '/usr/lib/modules/6.8.0-139-generic/kernel/fs/quota/quota_tree.ko.zst', 'device': 2306, 'inode': 20476897, 'bytes': 10344, 'uid': 0, 'gid': 0, 'sha256': 'cfd540f904666ed7bb0d8138761ded1510b0937432c22c7a3d287047eef606e7', 'mode': 420}, '/usr/lib/modules/6.8.0-139-generic/kernel/fs/quota/quota_v2.ko.zst': {'canonical': '/usr/lib/modules/6.8.0-139-generic/kernel/fs/quota/quota_v2.ko.zst', 'device': 2306, 'inode': 20476895, 'bytes': 6623, 'uid': 0, 'gid': 0, 'sha256': 'e1d1218bee7062f7b904c3c5ba138540b18c3f26836c8e11620fc1f24c8ab383', 'mode': 420}}

PACKAGE_EXPECTED = {'linux-modules-extra-6.8.0-139-generic': 'linux-modules-extra-6.8.0-139-generic\t6.8.0-139.139\tamd64\tlinux\t6.8.0-139.139\tinstall ok installed\n', 'kmod': 'kmod\t31+20240202-2ubuntu7.2\tamd64\tkmod\t31+20240202-2ubuntu7.2\tinstall ok installed\n', 'libc6:amd64': 'libc6\t2.39-0ubuntu8.9\tamd64\tglibc\t2.39-0ubuntu8.9\tinstall ok installed\n', 'libssl3t64:amd64': 'libssl3t64\t3.0.13-0ubuntu3.16\tamd64\topenssl\t3.0.13-0ubuntu3.16\tinstall ok installed\n', 'liblzma5:amd64': 'liblzma5\t5.6.1+really5.4.5-1ubuntu0.3\tamd64\txz-utils\t5.6.1+really5.4.5-1ubuntu0.3\tinstall ok installed\n', 'libzstd1:amd64': 'libzstd1\t1.5.5+dfsg2-2build1.1\tamd64\tlibzstd\t1.5.5+dfsg2-2build1.1\tinstall ok installed\n'}
PACKAGE_ENTRIES = [{'metadata': '/var/lib/dpkg/info/linux-modules-extra-6.8.0-139-generic.md5sums', 'entry': 'lib/modules/6.8.0-139-generic/kernel/fs/quota/quota_tree.ko.zst', 'expectedMd5': 'a0167f15f1b0bee1d3f7f6e92bff7cb3'}, {'metadata': '/var/lib/dpkg/info/linux-modules-extra-6.8.0-139-generic.md5sums', 'entry': 'lib/modules/6.8.0-139-generic/kernel/fs/quota/quota_v2.ko.zst', 'expectedMd5': 'a0eeab23c58745012eb68a470628dd9d'}, {'metadata': '/var/lib/dpkg/info/kmod.md5sums', 'entry': 'usr/bin/kmod', 'expectedMd5': '7d11c71f7f95aee7f4f34943c115f04b'}, {'metadata': '/var/lib/dpkg/info/libc6:amd64.md5sums', 'entry': 'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', 'expectedMd5': '7b881f7506cc7ede50bc4fba0063ec0e'}, {'metadata': '/var/lib/dpkg/info/libc6:amd64.md5sums', 'entry': 'usr/lib/x86_64-linux-gnu/libc.so.6', 'expectedMd5': '0d071be36a77f5c2bde1023f3fa81fa0'}, {'metadata': '/var/lib/dpkg/info/libssl3t64:amd64.md5sums', 'entry': 'usr/lib/x86_64-linux-gnu/libcrypto.so.3', 'expectedMd5': 'db869f2487148fa958e74f7aed3928b9'}, {'metadata': '/var/lib/dpkg/info/liblzma5:amd64.md5sums', 'entry': 'usr/lib/x86_64-linux-gnu/liblzma.so.5.4.5', 'expectedMd5': '06d0cb775ea3209bcfa35227d7e87c1c'}, {'metadata': '/var/lib/dpkg/info/libzstd1:amd64.md5sums', 'entry': 'usr/lib/x86_64-linux-gnu/libzstd.so.1.5.5', 'expectedMd5': '4cca5432aba6e0ddf11cc25289af4cb6'}]
ELF_PATHS = ['/usr/bin/kmod', '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/usr/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/x86_64-linux-gnu/libcrypto.so.3', '/usr/lib/x86_64-linux-gnu/liblzma.so.5.4.5', '/usr/lib/x86_64-linux-gnu/libzstd.so.1.5.5']

# Frozen references are carried as data. No future invocation needs a fixed
# pre-existing evidence receipt for a fact it can collect itself.
INPUT_HASHES = {
    'r18': 'e15eb92da09fe742d512f78ac4ddaa1258b0023626246f2fa2ab51111d98cb55',
    'r19': '540be7c73ffbaaf24435109ab62062cbd585f924930aba15a5276161b466ee40',
    'r19Controls': 'a51292cf8cefc662501e8e3d02deb3c330befc90c8e27fcf6afa9b4546c513fa',
    'actualHold': '993c886e7f49702a4e826dfc5469b9fa5f0c8f46bc68d3aef77c1139265e7269',
    'procedure': 'f349e0ad92d3c4e0083831cbfd6a39b3345fe1ebb13f48db58a1727aba865be0',
    'procedureReview': 'c69a1d61cb46621fc408818ced1b994d39f43f7ac807c5e567736b2427be7c22',
    'policy': '51a8a3159b9061133bfd3efcf5c84bef50b8d64967034b2b2d35771be193446a',
    'custody': '80d6c1916aac2a9429d080ca1ed6e48e434ca4067b6af9a2e768f78e3c08ce74',
    'plan': '2eaefb1651be6eba547e7d41fa9db33c9c3603e4bc666d5c1cef6a953f8df864',
    'resourcesR20': '9f82fe4018eb0ea26f5f7760e22acec12373afb8b428b881e6edee801670503a',
    'managerR20': 'bb81a37764b451b324fec1a7e2f09dedc8df126cf41e036fbb5ea017a156729b',
}
POLICY = {
    '/proc/sys/kernel/modules_disabled': '0',
    '/sys/module/module/parameters/sig_enforce': 'N',
    '/sys/kernel/security/lockdown': '[none] integrity confidentiality',
    '/proc/sys/kernel/tainted': '16384', '/sys/module/compression': 'zstd',
    '/sys/kernel/security/lsm': 'lockdown,capability,landlock,yama,apparmor',
}
NAMESPACES = {'user': 'user:[4026531837]', 'pid': 'pid:[4026531836]',
              'mnt': 'mnt:[4026531841]', 'net': 'net:[4026531840]',
              'cgroup': 'cgroup:[4026531835]'}
LOADER = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
INTERPRETER = '/lib64/ld-linux-x86-64.so.2'
ALIASES = {'/usr/sbin/insmod': '/usr/bin/kmod', '/lib': '/usr/lib',
           INTERPRETER: LOADER}
for _name, _canonical in [('libzstd.so.1', ELF_PATHS[-1]),
                          ('liblzma.so.5', ELF_PATHS[-2]),
                          ('libcrypto.so.3', ELF_PATHS[-3]),
                          ('libc.so.6', ELF_PATHS[2]),
                          ('ld-linux-x86-64.so.2', LOADER)]:
    for _base in ('/lib/x86_64-linux-gnu/', '/usr/lib/x86_64-linux-gnu/'):
        ALIASES[_base + _name] = _canonical
LOG_SIZE = 65536
POLL_SECONDS = 0.05
OBSERVATION_SECONDS = 10.0
# Fixed reservations permit a minimal WAIT even if an earlier publication is
# damaged. Sparse slots are intentional; each has exactly one semantic role.
STEP_EVENTS = {'STEP_INTENT': 0, 'DISPATCH': 1, 'EXEC_PHASE': 2,
               'UNCERTAIN': 3, 'WAIT_RESULT': 4, 'POSTSTATE': 5}
FIXED_EVENTS = {'INTENT': 0, 'SUPPORT_READY': 13, 'SUMMARY': 14, 'OWNER_NOTICE': 15}
SCHEMA = 2


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical_json(value)).hexdigest()


def control_hash():
    return digest({'schema': SCHEMA, 'machine': MACHINE, 'boot': BOOT, 'kernel': KERNEL,
                   'intent': str(INTENT), 'argv': ARGV, 'environment': ENV, 'cwd': '/',
                   'files': EXPECTED, 'packages': PACKAGE_EXPECTED, 'entries': PACKAGE_ENTRIES,
                   'aliases': ALIASES, 'policy': POLICY, 'namespaces': NAMESPACES,
                   'inputs': INPUT_HASHES, 'floor': FLOOR, 'slots': [SLOT, SLOTS],
                   'logSize': LOG_SIZE, 'stepEvents': STEP_EVENTS, 'fixedEvents': FIXED_EVENTS,
                   'observationSeconds': OBSERVATION_SECONDS})


def source_hash():
    return hashlib.sha256(bounded_file(__file__, 262144)).hexdigest()


def binding():
    return {'schema': SCHEMA, 'sourceSha256': source_hash(), 'controlSha256': control_hash()}


def error_fact(error):
    # No exception repr, arbitrary command output, environment values or log dump.
    return {'type': type(error).__name__, 'errno': getattr(error, 'errno', None)}


def stable_stat(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def bounded_file(path, limit, exact=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_size > limit or (exact is not None and s.st_size != exact):
            raise RuntimeError('unsupported regular file size/type')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) != s.st_size or len(data) > limit or stable_stat(os.fstat(fd)) != stable_stat(s):
            raise RuntimeError('file changed during bounded read')
        return bytes(data)
    finally:
        os.close(fd)


def bounded_text(path, limit=4096):
    # proc/sysfs sizes are commonly zero; enforce actual read bounds instead.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise RuntimeError('OS read exceeded bound')
        return data.decode('ascii').strip()
    finally:
        os.close(fd)


def trusted_resolve(path):
    """Check every traversed symlink and replacing parent before normalization.

    Existing local root custody, under the operator's controlled window. This
    is deliberately not a claim of atomic checked-FD exec or root adversary exclusion.
    """
    p = pathlib.Path(path)
    if not p.is_absolute() or len(str(p)) > 4096:
        raise RuntimeError('bounded absolute trusted path required')
    todo, current, observed, links = list(p.parts[1:]), pathlib.Path('/'), [], 0
    for _ in range(256):
        s = current.lstat()
        if s.st_uid != 0 or (not stat.S_ISLNK(s.st_mode) and s.st_mode & 0o022):
            raise RuntimeError('untrusted traversed custody')
        if not stat.S_ISLNK(s.st_mode):
            attrs = os.listxattr(current, follow_symlinks=False)
            if any(x in attrs for x in ('system.posix_acl_access', 'system.posix_acl_default',
                                       'security.capability')):
                raise RuntimeError('unresolved ACL or file capability custody')
        fact = {'path': str(current), 'device': s.st_dev, 'inode': s.st_ino,
                'uid': s.st_uid, 'gid': s.st_gid, 'mode': s.st_mode}
        observed.append(fact)
        if stat.S_ISLNK(s.st_mode):
            links += 1
            if links > 40:
                raise RuntimeError('too many trusted symlink hops')
            target = pathlib.Path(os.readlink(current))
            fact['target'] = str(target)
            if len(str(target)) > 4096:
                raise RuntimeError('oversized symlink target')
            if target.is_absolute():
                current, todo = pathlib.Path('/'), list(target.parts[1:]) + todo
            else:
                current, todo = current.parent, list(target.parts) + todo
            continue
        if not todo:
            return current, observed
        if not stat.S_ISDIR(s.st_mode):
            raise RuntimeError('non-directory replacing parent')
        component = todo.pop(0)
        if component == '..':
            current = current.parent
        elif component not in ('', '.'):
            current = current / component
    raise RuntimeError('path traversal exceeded bound')


def check_path(path, expected=None, custody=None):
    actual, walked = trusted_resolve(path)
    if custody is not None:
        for fact in walked:
            old = custody.get(fact['path'])
            if old is not None and old != fact:
                raise RuntimeError('custody changed within guard')
            custody[fact['path']] = fact
        if len(custody) > 128:
            raise RuntimeError('custody receipt exceeded bound')
    if expected is not None:
        s = actual.stat()
        data = bounded_file(actual, expected['bytes'], expected['bytes'])
        observed = {'canonical': str(actual), 'device': s.st_dev, 'inode': s.st_ino,
                    'bytes': s.st_size, 'uid': s.st_uid, 'gid': s.st_gid,
                    'mode': stat.S_IMODE(s.st_mode), 'sha256': hashlib.sha256(data).hexdigest()}
        if observed != expected or not stat.S_ISREG(s.st_mode) or stable_stat(actual.stat()) != stable_stat(s):
            raise RuntimeError('installed file identity changed')
    return actual


def preload_receipt(path='/etc/ld.so.preload', custody=None):
    p = pathlib.Path(path)
    check_path(str(p.parent), custody=custody)
    try:
        p.lstat()
    except FileNotFoundError:
        return {'entry': 'ABSENT', 'parentChecked': True}
    actual = check_path(path, custody=custody)  # dangling/access errors are not absence
    if bounded_file(actual, 4096).strip():
        raise RuntimeError('nonempty loader preload unsupported')
    return {'entry': 'EMPTY_REGULAR', 'canonical': str(actual), 'parentChecked': True}


def elf_interpreters(path):
    data = bounded_file(path, EXPECTED[path]['bytes'], EXPECTED[path]['bytes'])
    if data[:6] != b'\x7fELF\x02\x01' or len(data) < 64:
        raise RuntimeError('only exact ELF64 little-endian closure supported')
    off = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if size != 56 or count > 128 or off + size * count > len(data):
        raise RuntimeError('invalid ELF program header bounds')
    out = []
    for i in range(count):
        at = off + i * size
        kind = struct.unpack_from('<I', data, at)[0]
        if kind != 3:
            continue
        start = struct.unpack_from('<Q', data, at + 8)[0]
        length = struct.unpack_from('<Q', data, at + 32)[0]
        if not 1 < length <= 4096 or start + length > len(data):
            raise RuntimeError('invalid PT_INTERP bounds')
        value = data[start:start + length]
        if value[-1:] != b'\0' or b'\0' in value[:-1]:
            raise RuntimeError('invalid PT_INTERP string')
        out.append(value[:-1].decode('ascii'))
    return out


def require_wait_owner():
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise RuntimeError('default SIGCHLD required before any dispatch')
    # Python thread count alone misses native threads.
    if threading.active_count() != 1 or len(os.listdir('/proc/self/task')) != 1:
        raise RuntimeError('standalone single-threaded sole reaper required')
    return {'sigchld': 'SIG_DFL', 'threads': 1, 'soleReaper': os.getpid()}


class Stop:
    def __init__(self):
        self.reasons = []
        self.signals = []
        self.saved = {}

    def fail(self, reason):
        if reason not in self.reasons and len(self.reasons) < 8:
            self.reasons.append(reason)

    def handle(self, signum, _frame):
        if signum not in self.signals:
            self.signals.append(signum)
        self.fail('parent_signal')

    def __enter__(self):
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT):
            self.saved[sig] = signal.getsignal(sig)
            signal.signal(sig, self.handle)
        return self

    def __exit__(self, *_):
        for sig, old in self.saved.items():
            signal.signal(sig, old)


def event_slot(event, step=None):
    if event in FIXED_EVENTS:
        if step is not None:
            raise RuntimeError('global event has a step')
        return FIXED_EVENTS[event]
    if event not in STEP_EVENTS or type(step) is not int or step not in (1, 2):
        raise RuntimeError('unsupported event or step')
    return 1 + (step - 1) * 6 + STEP_EVENTS[event]


def encode_record(value):
    data = canonical_json(value)
    if len(data) > SLOT - HEADER.size:
        raise RuntimeError('record exceeds preallocated slot')
    return HEADER.pack(len(data), hashlib.sha256(data).digest()) + data


class Journal:
    def __init__(self, fd, bound=None):
        self.fd = fd
        self.bound = binding() if bound is None else bound
        self.used = set()
        self.failed = False

    def append(self, event, **fields):
        slot = event_slot(event, fields.get('step'))
        value = {'sequence': slot, 'time': stamp(), 'event': event, **self.bound, **fields}
        raw = encode_record(value)
        if slot in self.used or any(os.pread(self.fd, SLOT, slot * SLOT)):
            raise RuntimeError('occupied journal slot; no overwrite')
        self.used.add(slot)
        try:
            if os.pwrite(self.fd, raw, slot * SLOT) != len(raw):
                raise RuntimeError('partial publication')
            os.fsync(self.fd)
        except BaseException:
            self.failed = True
            raise
        return value

    def retain(self, stop, event, **fields):
        try:
            return self.append(event, **fields)
        except BaseException:
            self.failed = True
            stop.fail('publication_failure')
            return None


def read_integrity_records(fd):
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_size != SLOT * SLOTS:
        raise RuntimeError('journal requires regular file and exact preallocated size')
    records = []
    for slot in range(SLOTS):
        raw = os.pread(fd, SLOT, slot * SLOT)
        if len(raw) != SLOT:
            raise RuntimeError('short journal')
        if not any(raw):
            continue
        length, sha = HEADER.unpack(raw[:HEADER.size])
        if not 0 < length <= SLOT - HEADER.size:
            raise RuntimeError('invalid journal length')
        payload = raw[HEADER.size:HEADER.size + length]
        if hashlib.sha256(payload).digest() != sha or any(raw[HEADER.size + length:]):
            raise RuntimeError('damaged journal; original intent remains unresolved')
        value = json.loads(payload)
        if not isinstance(value, dict) or type(value.get('sequence')) is not int or value['sequence'] != slot:
            raise RuntimeError('journal slot mismatch')
        if event_slot(value.get('event'), value.get('step')) != slot:
            raise RuntimeError('event/step slot mismatch')
        if not isinstance(value.get('time'), str) or len(value['time']) > 40:
            raise RuntimeError('missing bounded event timestamp')
        if datetime.datetime.fromisoformat(value['time']).tzinfo is None:
            raise RuntimeError('unbound timestamp timezone')
        records.append(value)
    if stable_stat(os.fstat(fd)) != stable_stat(s):
        raise RuntimeError('concurrent journal change; no interpretation')
    return records


def read_records(fd, bound=None):
    records = read_integrity_records(fd)
    validate_history(records, binding() if bound is None else bound)
    return records


def validate_history(records, bound):
    if not records or records[0]['event'] != 'INTENT':
        raise RuntimeError('no bound intent')
    for r in records:
        if any(r.get(k) != v for k, v in bound.items()):
            raise RuntimeError('source/control binding mismatch')
    intent = records[0]
    required = {'machine': MACHINE, 'boot': BOOT, 'kernel': KERNEL,
                'argv': [list(a) for a in ARGV], 'environment': ENV, 'cwd': '/',
                'controlledWindow': True, 'intent': str(INTENT)}
    if any(intent.get(k) != v for k, v in required.items()):
        raise RuntimeError('intent command/context mismatch')
    by = {(r['event'], r.get('step')): r for r in records}
    for step in (1, 2):
        si = by.get(('STEP_INTENT', step))
        dispatch = by.get(('DISPATCH', step))
        ack = by.get(('EXEC_PHASE', step))
        wait = by.get(('WAIT_RESULT', step))
        post = by.get(('POSTSTATE', step))
        if any((dispatch, ack, wait, post)) and si is None:
            raise RuntimeError('step fact without durable step intent')
        if si and (si.get('argv') != list(ARGV[step - 1]) or si.get('attempt') != step):
            raise RuntimeError('step command/attempt mismatch')
        if step == 2 and si:
            tree = by.get(('POSTSTATE', 1))
            tw = by.get(('WAIT_RESULT', 1))
            if not tree or tree.get('outcome') != 'ESTABLISHED' or not tw or tw.get('returncode') != 0:
                raise RuntimeError('v2 intent without established tree barrier')
        if (ack or wait) and (not dispatch or dispatch.get('phase') != 'FORKED'):
            raise RuntimeError('child fact without retained fork identity')
        if ack:
            if ack.get('phase') == 'PREEXEC_FAILURE' and (type(ack.get('preexecErrno')) is not int or ack['preexecErrno'] <= 0):
                raise RuntimeError('pre-exec failure lacks positive errno')
            if ack.get('phase') not in ('EXEC_CHANNEL_CLOSED', 'PREEXEC_FAILURE', 'UNKNOWN'):
                raise RuntimeError('unknown exec phase')
            if type(ack.get('pid')) is not int or ack['pid'] <= 0:
                raise RuntimeError('missing child identity')
        if dispatch and dispatch.get('phase') not in ('FORKED', 'NO_CHILD'):
            raise RuntimeError('unknown dispatch phase')
        if dispatch and dispatch.get('phase') == 'FORKED':
            if type(dispatch.get('pid')) is not int or dispatch['pid'] <= 0:
                raise RuntimeError('invalid forked child identity')
        if wait:
            status = wait.get('waitStatus')
            if type(status) is not int or status < 0 or not (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                raise RuntimeError('invalid terminal wait status')
            if wait.get('returncode') != os.waitstatus_to_exitcode(status) or type(wait.get('pid')) is not int:
                raise RuntimeError('wait result mismatch')
            if dispatch and dispatch.get('phase') == 'FORKED' and dispatch.get('pid') != wait['pid']:
                raise RuntimeError('dispatch/wait PID mismatch')
            if ack and ack['pid'] != wait['pid']:
                raise RuntimeError('exec/wait PID mismatch')
        if post:
            if post.get('outcome') not in ('ESTABLISHED', 'DEFINITE_FAILED', 'NOT_EXECUTED', 'UNCERTAIN'):
                raise RuntimeError('unknown poststate outcome')
            if post['outcome'] == 'ESTABLISHED':
                if (not wait or wait['returncode'] != 0 or not ack or ack['phase'] != 'EXEC_CHANNEL_CLOSED' or
                        not dispatch or dispatch.get('phase') != 'FORKED'):
                    raise RuntimeError('success without actual wait/exec facts')
                validate_guard_receipt(post.get('receipt'), bound, NAMES[:step])
            if post['outcome'] == 'NOT_EXECUTED':
                if not ((ack and ack['phase'] == 'PREEXEC_FAILURE' and wait is not None) or
                        (dispatch and dispatch['phase'] == 'NO_CHILD')):
                    raise RuntimeError('no-exec without positive phase evidence')
            if post['outcome'] == 'DEFINITE_FAILED':
                if (not wait or wait['returncode'] <= 0 or not ack or ack['phase'] != 'EXEC_CHANNEL_CLOSED'):
                    raise RuntimeError('failure without positive exit and known exec phase')
                state = post.get('receipt', {}).get('after', post.get('receipt', {})).get('modules', {})
                if state.get(NAMES[step - 1], {}).get('present') is not False:
                    raise RuntimeError('failed target state unresolved')
                if step == 2 and not (state.get('quota_tree', {}).get('initstate') == 'live' and
                                      state.get('quota_tree', {}).get('taint') == ''):
                    raise RuntimeError('partial failure lost established tree state')
    summary = by.get(('SUMMARY', None))
    if summary:
        established = [NAMES[s - 1] for s in (1, 2)
                       if by.get(('POSTSTATE', s), {}).get('outcome') == 'ESTABLISHED']
        if summary.get('established') != established:
            raise RuntimeError('summary changed established steps')
        outcomes = summary.get('outcomes')
        if not isinstance(outcomes, list) or len(outcomes) != 2:
            raise RuntimeError('missing distinct step outcomes')
        for s in (1, 2):
            post = by.get(('POSTSTATE', s))
            if post and outcomes[s - 1] != post['outcome']:
                raise RuntimeError('summary changed step result')
            if not post and outcomes[s - 1] != 'NOT_SUBMITTED':
                raise RuntimeError('summary invents a step result')
            if outcomes[s - 1] == 'NOT_SUBMITTED' and by.get(('DISPATCH', s)):
                raise RuntimeError('submitted step summarized as unsubmitted')
        result = summary.get('result')
        if result == 'DEFINITE_FAILED' and (established or outcomes[0] not in ('NOT_SUBMITTED', 'NOT_EXECUTED', 'DEFINITE_FAILED')):
            raise RuntimeError('failed summary contradicts evidence')
        if result == 'SUPPORT_READY' and ('SUPPORT_READY', None) not in by:
            raise RuntimeError('summary invents readiness')
        if result == 'DEFINITE_PARTIAL' and not (established == ['quota_tree'] and outcomes[1] in
                                                ('NOT_SUBMITTED', 'NOT_EXECUTED', 'DEFINITE_FAILED')):
            raise RuntimeError('partial summary contradicts evidence')
        if result == 'UNCERTAIN_V2_TREE_RETAINED' and established != ['quota_tree']:
            raise RuntimeError('uncertain v2 summary lost tree fact')
        if result not in ('SUPPORT_READY', 'DEFINITE_PARTIAL', 'DEFINITE_FAILED', 'UNCERTAIN', 'UNCERTAIN_V2_TREE_RETAINED'):
            raise RuntimeError('unknown summary classification')
    if ('SUPPORT_READY', None) in by:
        if any(by.get(('POSTSTATE', s), {}).get('outcome') != 'ESTABLISHED' for s in (1, 2)):
            raise RuntimeError('readiness without both established steps')
        validate_guard_receipt(by[('SUPPORT_READY', None)].get('receipt'), bound, NAMES)
    validate_guard_receipt(intent.get('receipt'), bound, ())
    for step in (1, 2):
        si = by.get(('STEP_INTENT', step))
        dispatch = by.get(('DISPATCH', step))
        if si:
            validate_guard_receipt(si.get('receipt'), bound, NAMES[:step - 1])
        if dispatch and dispatch.get('phase') == 'FORKED':
            validate_fast_receipt(dispatch.get('boundary'), NAMES[:step - 1])


def validate_guard_receipt(receipt, bound, live):
    if not isinstance(receipt, dict) or not receipt.get('admitted'):
        raise RuntimeError('missing admitted guard receipt')
    if any(receipt.get(k) != v for k, v in bound.items()):
        raise RuntimeError('guard source/control mismatch')
    if (receipt.get('argv') != [list(a) for a in ARGV] or receipt.get('environment') != ENV or
            receipt.get('cwd') != '/' or receipt.get('controlledWindow') is not True):
        raise RuntimeError('guard command binding mismatch')
    if receipt.get('packages') != PACKAGE_EXPECTED or len(receipt.get('integrity', [])) != len(PACKAGE_ENTRIES):
        raise RuntimeError('guard package attribution incomplete')
    for entry, observed in zip(PACKAGE_ENTRIES, receipt['integrity']):
        if any(observed.get(k) != v for k, v in entry.items()):
            raise RuntimeError('guard integrity entry mismatch')
    for path, expected in EXPECTED.items():
        if receipt.get('files', {}).get(path) != expected:
            raise RuntimeError('guard file binding mismatch')
    if receipt.get('interpreters', {}).get('/usr/bin/kmod') != [INTERPRETER]:
        raise RuntimeError('guard interpreter missing')
    if not receipt.get('custody') or not receipt.get('loader', {}).get('rawPaths'):
        raise RuntimeError('guard alias/loader custody missing')
    for field in ('before', 'after'):
        sample = receipt.get(field, {})
        required = () if field == 'before' and not live else live
        # Before and after a post-return guard both require the same live set.
        validate_fast_receipt(sample, required)
    if 'readinessBoundary' in receipt:
        validate_fast_receipt(receipt['readinessBoundary'], live)


def validate_fast_receipt(sample, live):
    if not isinstance(sample, dict) or sample.get('admitted') is not True or sample.get('failures') != []:
        raise RuntimeError('fast guard not admitted')
    if sample.get('host') != {'machine': MACHINE, 'boot': BOOT, 'kernel': KERNEL} or sample.get('policy') != POLICY:
        raise RuntimeError('fast host/policy changed')
    d = sample.get('diagnostics', {})
    if not d.get('available') or d.get('relevantTags') != [] or d.get('source') != '/dev/kmsg':
        raise RuntimeError('fresh diagnostics missing or failed')
    context = sample.get('context', {})
    if context.get('namespaces') != NAMESPACES or context.get('uidMap') != ['0', '0', '4294967295']:
        raise RuntimeError('root namespace receipt missing')
    if any(context.get(k, '').split() != ['0'] * 4 for k in ('Uid', 'Gid')):
        raise RuntimeError('root UID/GID receipt missing')
    if context.get('NoNewPrivs') != '0' or context.get('Seccomp') != '0':
        raise RuntimeError('root policy context changed')
    for k in ('CapPrm', 'CapEff'):
        if not int(context.get(k, '0'), 16) & (1 << 16):
            raise RuntimeError('root capability receipt missing')
    owner = context.get('waitOwner', {})
    if owner.get('sigchld') != 'SIG_DFL' or owner.get('threads') != 1:
        raise RuntimeError('wait owner receipt missing')
    for path, device in (('/', 2306), ('/srv/workers', 66305)):
        c = sample.get('capacity', {}).get(path, {})
        if c.get('device') != device or c.get('availableBytes', 0) < FLOOR or c.get('availableInodes', 0) < 50000:
            raise RuntimeError('capacity receipt failed')
    if sample.get('capacity', {}).get('memoryBytes', {}).get('MemAvailable', 0) < 536870912:
        raise RuntimeError('RAM receipt missing')
    for n in NAMES:
        state = sample.get('modules', {}).get(n, {})
        if n in live:
            if not (state.get('present') is True and state.get('initstate') == 'live' and state.get('taint') == '' and
                    isinstance(state.get('holders'), list)):
                raise RuntimeError('live module/holders receipt missing')
        elif state.get('present') is not False:
            raise RuntimeError('unexpected module presence')


class OwnedChild:
    """The actual fork parent is the sole reaper; no Popen ECHILD fallback.

    The PID is retained before ticks, journal writes or exec-channel reads.
    Observation expiry stops progression, then polls this same wait handle.
    """
    def __init__(self, argv, log, stop, journal=None, step=None, timeout=OBSERVATION_SECONDS):
        self.argv, self.log, self.stop = tuple(argv), log, stop
        self.journal, self.step, self.timeout = journal, step, timeout
        self.pid = None
        self.wait_status = None
        self.wait_unavailable = False
        self.start_ticks = None
        self.phase = 'UNKNOWN'
        self.preexec_errno = None
        self.channel = bytearray()
        self.channel_fd = None
        self.channel_closed = False
        self.channel_eof = False
        self.phase_published = False
        self.expired = False

    def publish(self, event, **fields):
        if self.journal:
            self.journal.retain(self.stop, event, step=self.step, **fields)

    def drain_channel(self):
        if self.channel_closed:
            return
        try:
            while len(self.channel) <= 16:
                data = os.read(self.channel_fd, 17 - len(self.channel))
                if not data:
                    self.channel_eof = True
                    self.channel_closed = True
                    break
                self.channel.extend(data)
            if len(self.channel) > 16:
                self.stop.fail('invalid_exec_channel')
                self.channel_closed = True
        except BlockingIOError:
            pass
        except BaseException:
            self.stop.fail('exec_channel_error')
            self.channel_closed = True
        if self.channel_closed:
            # R then close-on-exec EOF is the OS exec error-channel convention.
            # Signal death still leaves effect uncertain, including death in the
            # tiny pre-exec interval after R. E errno is positive pre-exec proof.
            if not self.channel_eof:
                self.phase = 'UNKNOWN'
                self.stop.fail('unknown_exec_handshake')
            elif self.channel == b'R':
                self.phase = 'EXEC_CHANNEL_CLOSED'
            elif ((len(self.channel) == 5 and self.channel[:1] == b'E') or
                  (len(self.channel) == 6 and self.channel[:2] == b'RE')):
                self.phase = 'PREEXEC_FAILURE'
                self.preexec_errno = struct.unpack('!I', self.channel[-4:])[0]
            else:
                self.phase = 'UNKNOWN'
                self.stop.fail('unknown_exec_handshake')
            if not self.phase_published:
                self.publish('EXEC_PHASE', pid=self.pid, startTicks=self.start_ticks,
                             phase=self.phase, preexecErrno=self.preexec_errno)
                self.phase_published = True

    def poll_wait(self):
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
        except InterruptedError:
            return
        except ChildProcessError:
            self.wait_unavailable = True
            self.stop.fail('wait_status_unavailable')
            return
        except BaseException:
            self.stop.fail('wait_error')
            return
        if pid == self.pid:
            self.wait_status = status
            # Minimal actual status first: no log fsync/hash, post-state or ticks.
            self.publish('WAIT_RESULT', pid=self.pid, waitStatus=status,
                         returncode=os.waitstatus_to_exitcode(status))

    def retain_wait(self, deadline):
        while self.wait_status is None and not self.wait_unavailable:
            try:
                self.poll_wait()
                self.drain_channel()
                if not self.expired and time.monotonic() >= deadline and self.wait_status is None:
                    self.expired = True
                    self.stop.fail('observation_expired')
                    self.publish('UNCERTAIN', pid=self.pid, reason='OBSERVATION_EXPIRED_KEEP_SAME_WAIT')
                if self.wait_status is None and not self.wait_unavailable:
                    time.sleep(POLL_SECONDS)
            except BaseException:
                # Catchable interruption/errors may stop progression; they must
                # never exit the ownership loop with an unreaped child.
                self.stop.fail('owner_processing_error')
        self.drain_channel()

    def run(self):
        try:
            return self._run()
        except BaseException as error:
            if self.pid is None:
                self.phase = 'PREEXEC_FAILURE'
                self.preexec_errno = getattr(error, 'errno', None) or errno.EIO
                self.publish('DISPATCH', phase='NO_CHILD', error=error_fact(error))
                self.stop.fail('parent_preexec_failure')
                return self
            # _run's finally has already retained this same wait relationship.
            raise

    def _run(self):
        require_wait_owner()
        if self.stop.reasons:
            raise RuntimeError('progression stopped before fork')
        rfd, wfd = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        self.channel_fd = rfd
        null = None
        oldmask = None
        try:
            null = os.open('/dev/null', os.O_RDONLY | os.O_CLOEXEC)
            # Prevent a catchable termination between fork and storing its PID.
            oldmask = signal.pthread_sigmask(signal.SIG_BLOCK,
                                            {signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT})
            try:
                self.pid = os.fork()
            except OSError as error:
                self.publish('DISPATCH', phase='NO_CHILD', error=error_fact(error))
                self.phase = 'PREEXEC_FAILURE'
                self.preexec_errno = error.errno
                return self
            if self.pid == 0:
                try:
                    os.close(rfd)
                    os.chdir('/')
                    os.dup2(null, 0)
                    os.dup2(self.log, 1)
                    os.dup2(self.log, 2)
                    resource.setrlimit(resource.RLIMIT_FSIZE, (LOG_SIZE, LOG_SIZE))
                    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT,
                                signal.SIGPIPE, signal.SIGCHLD):
                        signal.signal(sig, signal.SIG_DFL)
                    # All parent evidence descriptors are CLOEXEC; explicitly
                    # close other descriptors so a stalled pre-exec child has none.
                    for fd in os.listdir('/proc/self/fd'):
                        n = int(fd)
                        if n > 2 and n != wfd:
                            try:
                                os.close(n)
                            except OSError:
                                pass
                    signal.pthread_sigmask(signal.SIG_SETMASK, oldmask)
                    os.write(wfd, b'R')
                    try:
                        os.execve(self.argv[0], self.argv, ENV)
                    except BaseException as error:
                        # Replace R with a second explicit failure frame: REerrno.
                        os.write(wfd, b'E' + struct.pack('!I', getattr(error, 'errno', None) or errno.EIO))
                except BaseException as error:
                    try:
                        os.write(wfd, b'E' + struct.pack('!I', getattr(error, 'errno', None) or errno.EIO))
                    except BaseException:
                        pass
                os._exit(127)
            # self.pid now identifies the actual unreaped child, before any slow work.
            deadline = time.monotonic() + self.timeout
            os.close(wfd)
            wfd = None
            signal.pthread_sigmask(signal.SIG_SETMASK, oldmask)
            oldmask = None
            self.publish('DISPATCH', phase='FORKED', pid=self.pid,
                         boundary=getattr(self, 'boundary', None))
            try:
                self.start_ticks = ticks(self.pid)
            except BaseException:
                self.stop.fail('ticks_error')
            self.retain_wait(deadline)
            return self
        finally:
            # Any parent exception after fork still owns this exact child.
            if self.pid and self.wait_status is None and not self.wait_unavailable:
                if wfd is not None:
                    os.close(wfd)
                    wfd = None
                self.stop.fail('parent_phase_exception')
                if oldmask is not None:
                    signal.pthread_sigmask(signal.SIG_SETMASK, oldmask)
                    oldmask = None
                self.retain_wait(time.monotonic())
            if oldmask is not None:
                signal.pthread_sigmask(signal.SIG_SETMASK, oldmask)
            for fd in (rfd, wfd, null):
                if fd is not None:
                    os.close(fd)


def ticks(pid):
    try:
        value = bounded_text('/proc/' + str(pid) + '/stat')
    except FileNotFoundError:
        return None
    return value.rsplit(')', 1)[1].split()[19]


def read_command(argv, stop):
    # Internal fixed selections only, not a public caller-command interface.
    allowed = (tuple(argv) == (LOADER, '--list', '/usr/bin/kmod') or
               (len(argv) == 4 and argv[0:2] == ['/usr/bin/dpkg-query', '-W'] and
                argv[-1] in PACKAGE_EXPECTED and argv[2] ==
                '-f=${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${Status}\n'))
    if not allowed:
        raise RuntimeError('untrusted read command selection')
    fd = os.memfd_create('quota-read-result', os.MFD_CLOEXEC)
    try:
        os.ftruncate(fd, LOG_SIZE)
        child = OwnedChild(argv, fd, stop, timeout=3).run()
        if child.wait_status is None or os.waitstatus_to_exitcode(child.wait_status) != 0 or stop.reasons:
            raise RuntimeError('read command unavailable')
        length = os.lseek(fd, 0, os.SEEK_CUR)
        if not 0 <= length < LOG_SIZE:
            raise RuntimeError('read command output limit')
        return os.pread(fd, length, 0).decode('ascii')
    finally:
        os.close(fd)

class KernelCursor:
    """Future initial-root /dev/kmsg reader only. Never dump raw global messages.

    SEEK_END starts at the current cursor. EPIPE, malformed/oversized records,
    byte/record exhaustion or unavailable access make the delta unsupported.
    All priority-error records veto; warning/lockup/module/security patterns also
    veto even if sticky taint 16384 remains unchanged. Only tags are retained.
    """
    def __init__(self):
        self.fd = None
        self.sequence = None
        self.total_records = 0
        self.total_bytes = 0
        self.tags = set()
        self.available = False
        self.error = None
        try:
            actual = check_path('/dev/kmsg')
            fd = os.open(actual, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
            self.fd = fd
            s = os.fstat(fd)
            if not stat.S_ISCHR(s.st_mode) or (os.major(s.st_rdev), os.minor(s.st_rdev)) != (1, 11):
                raise RuntimeError('unsupported kernel read source type')
            os.lseek(fd, 0, os.SEEK_END)
            self.available = True
        except Exception as error:
            self.error = error_fact(error)
        self.started = stamp()

    def sample(self):
        start = stamp()
        count, size = 0, 0
        if self.available:
            try:
                for _ in range(256):
                    try:
                        raw = os.read(self.fd, 8192)
                    except BlockingIOError:
                        break
                    if not raw:
                        raise RuntimeError('kernel cursor unexpectedly closed')
                    count += 1
                    size += len(raw)
                    if size > 131072:
                        raise RuntimeError('kernel delta byte overflow')
                    head, sep, body = raw.partition(b';')
                    fields = head.split(b',')
                    if not sep or len(fields) != 4 or not all(x.isdigit() for x in fields[:3]):
                        raise RuntimeError('unsupported kernel record format')
                    priority, seq, usec = (int(x) for x in fields[:3])
                    if self.sequence is not None and seq != self.sequence + 1:
                        raise RuntimeError('kernel delta sequence loss')
                    self.sequence = seq
                    self.total_records += 1
                    self.total_bytes += len(raw)
                    if priority & 7 <= 3:
                        self.tags.add('KERNEL_ERROR_PRIORITY')
                    lower = body.lower()
                    for token, tag in ((b'soft lockup', 'SOFT_LOCKUP'), (b'hard lockup', 'HARD_LOCKUP'),
                                       (b'watchdog', 'WATCHDOG'), (b'bug:', 'BUG'),
                                       (b'oops', 'OOPS'), (b'warning:', 'WARNING'),
                                       (b'quota_tree', 'QUOTA_TREE_MESSAGE'), (b'quota_v2', 'QUOTA_V2_MESSAGE'),
                                       (b'module verification failed', 'MODULE_VERIFICATION'),
                                       (b'unknown symbol', 'UNKNOWN_SYMBOL'), (b'lockdown:', 'LOCKDOWN')):
                        if token in lower:
                            self.tags.add(tag)
                else:
                    raise RuntimeError('kernel delta record overflow')
            except Exception as error:
                self.available = False
                self.error = error_fact(error)
        return {'source': '/dev/kmsg', 'cursorStarted': self.started, 'started': start,
                'finished': stamp(), 'available': self.available, 'error': self.error,
                'records': count, 'bytes': size, 'totalRecords': self.total_records,
                'totalBytes': self.total_bytes, 'lastSequence': self.sequence,
                'relevantTags': sorted(self.tags), 'rawMessagesPersisted': False}

    def close(self):
        if self.fd is not None:
            os.close(self.fd)


def module_state(name):
    if name not in NAMES:
        raise RuntimeError('unexpected module selection')
    p = pathlib.Path('/sys/module') / name
    try:
        p.lstat()
    except FileNotFoundError:
        # Parent access failures are distinct from the single entry's ENOENT.
        os.stat('/sys/module')
        return {'present': False}
    state = {'present': True, 'initstate': bounded_text(p / 'initstate', 32),
             'taint': bounded_text(p / 'taint', 64), 'refcnt': bounded_text(p / 'refcnt', 32)}
    holders = os.listdir(p / 'holders')
    if len(holders) > 128 or any(not re.fullmatch(r'[a-zA-Z0-9_]{1,64}', x) for x in holders):
        raise RuntimeError('unsupported holders bounds')
    state['holders'] = sorted(holders)
    if state['initstate'] not in ('live', 'coming', 'going') or not re.fullmatch(r'-?\d{1,12}', state['refcnt']):
        raise RuntimeError('unsupported module state')
    return state


def context_receipt():
    status = bounded_text('/proc/self/status', 16384)
    values = dict(x.split(':', 1) for x in status.splitlines() if ':' in x)
    keys = ('Uid', 'Gid', 'CapPrm', 'CapEff', 'NoNewPrivs', 'Seccomp')
    fact = {k: values[k].strip() for k in keys}
    if any(fact[k].split() != ['0'] * 4 for k in ('Uid', 'Gid')):
        raise RuntimeError('normal root UID/GID context required')
    if any(not int(fact[k], 16) & (1 << 16) for k in ('CapPrm', 'CapEff')):
        raise RuntimeError('existing module capability required')
    if fact['NoNewPrivs'] != '0' or fact['Seccomp'] != '0':
        raise RuntimeError('normal root execution context required')
    fact['namespaces'] = {n: os.readlink('/proc/self/ns/' + n) for n in NAMESPACES}
    if fact['namespaces'] != NAMESPACES:
        raise RuntimeError('known initial-host namespaces required')
    fact['uidMap'] = bounded_text('/proc/self/uid_map').split()
    if fact['uidMap'] != ['0', '0', '4294967295']:
        raise RuntimeError('initial UID map required')
    fact['waitOwner'] = require_wait_owner()
    if not (sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode):
        raise RuntimeError('trusted isolated -I -S -B Python startup required')
    if set(os.environ) - {'PATH', 'LC_ALL', 'LANG'}:
        raise RuntimeError('cleared parent environment required')
    # Values of inherited variables are never persisted. Child env is fixed ENV.
    fact['startup'] = {'isolated': True, 'noSite': True, 'noBytecode': True,
                       'environmentNames': sorted(os.environ), 'python': sys.version.split()[0],
                       'executable': sys.executable}
    return fact


def capacity_receipt():
    fact = {'admitted': True}
    for path, device in (('/', 2306), ('/srv/workers', 66305)):
        s = os.statvfs(path)
        values = {'device': os.stat(path).st_dev, 'availableBytes': s.f_bavail * s.f_frsize,
                  'availableInodes': s.f_favail}
        fact[path] = values
        if values['device'] != device or values['availableBytes'] < FLOOR or values['availableInodes'] < 50000:
            fact['admitted'] = False
    memory = dict(x.split(':', 1) for x in bounded_text('/proc/meminfo', 8192).splitlines())
    fact['memoryBytes'] = {k: int(memory[k].split()[0]) * 1024 for k in ('MemTotal', 'MemAvailable', 'SwapFree')}
    if fact['memoryBytes']['MemAvailable'] < 536870912:
        fact['admitted'] = False
    return fact


def fast_sample(cursor, required_live, custody=None, enforce=True):
    fact = {'started': stamp()}
    failures = []
    for field, collect in (
        ('host', lambda: {'machine': bounded_text('/etc/machine-id'),
                         'boot': bounded_text('/proc/sys/kernel/random/boot_id'), 'kernel': os.uname().release}),
        ('context', context_receipt), ('capacity', capacity_receipt),
        ('policy', lambda: {p: bounded_text(p) for p in POLICY}),
        ('modules', lambda: {n: module_state(n) for n in NAMES}),
        ('diagnostics', cursor.sample),
    ):
        try:
            fact[field] = collect()
        except Exception as error:
            fact[field] = {'unavailable': error_fact(error)}
            failures.append(field + '_unavailable')
    if fact.get('host') != {'machine': MACHINE, 'boot': BOOT, 'kernel': KERNEL}:
        failures.append('host_changed')
    if not fact.get('capacity', {}).get('admitted'):
        failures.append('capacity_refusal')
    if fact.get('policy') != POLICY:
        failures.append('policy_changed')
    modules = fact.get('modules', {})
    for n in NAMES:
        s = modules.get(n, {})
        if n in required_live:
            if not (s.get('present') and s.get('initstate') == 'live' and s.get('taint') == ''):
                failures.append(n + '_not_established')
        elif s.get('present') is not False:
            failures.append(n + '_unexpected')
    d = fact.get('diagnostics', {})
    if not d.get('available') or d.get('relevantTags'):
        failures.append('kernel_diagnostics_refusal')
    if custody is not None:
        try:
            for path, old in custody.items():
                s = pathlib.Path(path).lstat()
                now = {'path': path, 'device': s.st_dev, 'inode': s.st_ino,
                       'uid': s.st_uid, 'gid': s.st_gid, 'mode': s.st_mode}
                if stat.S_ISLNK(s.st_mode):
                    now['target'] = os.readlink(path)
                if old != now:
                    raise RuntimeError('custody changed at fast boundary')
            fact['custodyRechecked'] = True
        except Exception as error:
            fact['custodyError'] = error_fact(error)
            failures.append('custody_changed')
    fact['finished'] = stamp()
    fact['failures'] = failures
    fact['admitted'] = not failures
    if enforce and failures:
        raise GuardRefusal(fact)
    return fact


class GuardRefusal(RuntimeError):
    def __init__(self, receipt):
        super().__init__('fresh guard refused')
        self.receipt = receipt


def guards(cursor, stop, required_live=()):
    receipt = {'started': stamp(), **binding(), 'argv': ARGV, 'environment': ENV, 'cwd': '/',
               'controlledWindow': True, 'custody': {}, 'files': {}, 'packages': {}, 'integrity': []}
    try:
        if bounded_text('/etc/machine-id') != MACHINE or bounded_text('/proc/sys/kernel/random/boot_id') != BOOT:
            raise RuntimeError('machine/boot mismatch')
        if os.uname().release != KERNEL:
            raise RuntimeError('kernel mismatch')
        receipt['before'] = fast_sample(cursor, required_live)
        custody = receipt['custody']
        for path, expected in EXPECTED.items():
            check_path(path, expected, custody)
            receipt['files'][path] = expected
        for path, target in ALIASES.items():
            if str(check_path(path, custody=custody)) != target:
                raise RuntimeError('actual alias changed')
        # Collect currently trusted Python/tool identities rather than require
        # nonexistent frozen attestations. Existing OS/root trust is explicit.
        for path in (__file__, sys.executable, '/usr/bin/dpkg-query', '/etc/ld.so.cache'):
            canonical = check_path(path, custody=custody)
            data = bounded_file(canonical, 16777216)
            s = canonical.stat()
            receipt['files'][path] = {'canonical': str(canonical), 'device': s.st_dev,
                                     'inode': s.st_ino, 'bytes': len(data),
                                     'sha256': hashlib.sha256(data).hexdigest()}
        receipt['preload'] = preload_receipt(custody=custody)
        interp = {p: elf_interpreters(p) for p in ELF_PATHS}
        for paths in interp.values():
            for path in paths:
                if path != INTERPRETER or str(check_path(path, custody=custody)) != LOADER:
                    raise RuntimeError('actual PT_INTERP chain changed')
        if interp['/usr/bin/kmod'] != [INTERPRETER]:
            raise RuntimeError('missing actual kmod PT_INTERP')
        receipt['interpreters'] = interp
        output = read_command([LOADER, '--list', '/usr/bin/kmod'], stop)
        raw_paths = re.findall(r'/[^\s()]+', output)
        if len(raw_paths) > 16 or not raw_paths or 'not found' in output:
            raise RuntimeError('unsupported normal loader output')
        resolved = []
        for path in raw_paths:
            # Both sides of absolute loader aliases and each raw SONAME path
            # are checked before creating the canonical set.
            if path not in ALIASES and path not in ELF_PATHS:
                raise RuntimeError('unexpected raw loader path')
            resolved.append(str(check_path(path, custody=custody)))
        if set(resolved) | {'/usr/bin/kmod'} != set(ELF_PATHS):
            raise RuntimeError('actual normal loader closure changed')
        receipt['loader'] = {'rawPaths': raw_paths, 'canonicalSet': sorted(set(resolved)),
                             'outputSha256': hashlib.sha256(output.encode()).hexdigest()}
        for package, expected in PACKAGE_EXPECTED.items():
            argv = ['/usr/bin/dpkg-query', '-W',
                    '-f=${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${Status}\n', package]
            if read_command(argv, stop) != expected:
                raise RuntimeError('installed package attribution changed')
            receipt['packages'][package] = expected
        for entry in PACKAGE_ENTRIES:
            metadata = check_path(entry['metadata'], custody=custody)
            data = bounded_file(metadata, 8388608)
            lines = data.decode('ascii').splitlines()
            exact = entry['expectedMd5'] + '  ' + entry['entry']
            if lines.count(exact) != 1:
                raise RuntimeError('installed integrity entry changed')
            target = check_path('/' + entry['entry'], custody=custody)
            if hashlib.md5(bounded_file(target, 8388608)).hexdigest() != entry['expectedMd5']:
                raise RuntimeError('installed integrity mismatch')
            receipt['integrity'].append({**entry, 'metadataSha256': hashlib.sha256(data).hexdigest()})
        receipt['after'] = fast_sample(cursor, required_live, custody)
        receipt['admitted'] = not stop.reasons
        if stop.reasons:
            raise RuntimeError('owner stopped progression')
    except Exception as error:
        receipt['admitted'] = False
        receipt['error'] = error_fact(error)
        if isinstance(error, GuardRefusal):
            receipt['refusedFastSample'] = error.receipt
    receipt['finished'] = stamp()
    # This checks the actual bounded future receipt, not a source string.
    if len(canonical_json(receipt)) > SLOT - HEADER.size - 2048:
        receipt = {'started': receipt['started'], 'finished': stamp(), **binding(),
                   'admitted': False, 'failure': 'GUARD_RECEIPT_CAPACITY'}
    if not receipt['admitted']:
        raise GuardRefusal(receipt)
    return receipt


def log_receipt(fd):
    os.fsync(fd)
    size = os.lseek(fd, 0, os.SEEK_CUR)
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_size != LOG_SIZE or not 0 <= size <= LOG_SIZE:
        raise RuntimeError('log bounds changed')
    raw = os.pread(fd, size, 0)
    if len(raw) != size:
        raise RuntimeError('short log')
    # Retain bounded raw child output in its private preallocated log. Publish
    # only relevant classifications/hash, never a global/raw diagnostic dump.
    tags = [tag for token, tag in ((b'File exists', 'EXISTS_CONFLICT'),
                                   (b'Unknown symbol', 'UNKNOWN_SYMBOL'),
                                   (b'Operation not permitted', 'PERMISSION_DENIED')) if token in raw]
    return {'bytes': size, 'sha256': hashlib.sha256(raw).hexdigest(), 'tags': tags}


def classify(child, receipt, index):
    if child.pid is None or child.phase == 'PREEXEC_FAILURE':
        return 'NOT_EXECUTED', 'POSITIVE_PREEXEC_FAILURE'
    if child.wait_status is None:
        return 'UNCERTAIN', 'WAIT_UNAVAILABLE'
    code = os.waitstatus_to_exitcode(child.wait_status)
    if code < 0:
        return 'UNCERTAIN', 'SIGNAL_DEATH_EFFECT_UNRESOLVED'
    if child.phase != 'EXEC_CHANNEL_CLOSED':
        return 'UNCERTAIN', 'EXEC_HANDSHAKE_UNRESOLVED'
    # Known positive exits are definite command failures. A settled absent
    # target with intact prior tree is definite failure/partial; other state or
    # diagnostics leaves kernel outcome separate and unresolved.
    if code > 0:
        modules = receipt.get('after', receipt).get('modules', {})
        expected_absent = modules.get(NAMES[index], {}).get('present') is False
        tree_ok = index == 0 or (modules.get('quota_tree', {}).get('initstate') == 'live' and
                                 modules.get('quota_tree', {}).get('taint') == '')
        if expected_absent and tree_ok:
            return 'DEFINITE_FAILED', 'POSITIVE_EXIT_SETTLED_ABSENT'
        return 'UNCERTAIN', 'POSITIVE_FAILED_EXIT_EFFECT_DISAGREES_OR_UNREADABLE'
    if receipt.get('admitted') and not child.stop.reasons:
        return 'ESTABLISHED', 'ZERO_EXIT_FRESH_GUARDS'
    return 'UNCERTAIN', 'KNOWN_ZERO_READINESS_REFUSED'


def allocate_intent():
    parent = check_path(str(INTENT.parent))
    if parent != INTENT.parent or os.stat(parent).st_dev != 2306:
        raise RuntimeError('unexpected existing evidence parent')
    os.mkdir(INTENT, 0o700)  # fixed occupied name is never removed/reused/adopted
    directory = os.open(INTENT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fds = []
    try:
        for name, size in [('journal.bin', SLOT * SLOTS), ('tree.log', LOG_SIZE), ('v2.log', LOG_SIZE)]:
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=directory)
            fds.append(fd)
            os.posix_fallocate(fd, 0, size)
            os.fsync(fd)
        os.fsync(directory)
        pd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(pd)
        finally:
            os.close(pd)
        return directory, fds
    except BaseException:
        for fd in fds:
            os.close(fd)
        os.close(directory)
        raise


def apply_once(controlled_window):
    if not controlled_window:
        raise RuntimeError('existing operator must establish the controlled custody window')
    require_wait_owner()
    with Stop() as stop:
        cursor = KernelCursor()
        directory, fds = None, []
        journal = None
        established = []
        outcomes = ['NOT_SUBMITTED', 'NOT_SUBMITTED']
        try:
            initial = guards(cursor, stop)
            directory, fds = allocate_intent()
            journal = Journal(fds[0])
            journal.append('INTENT', machine=MACHINE, boot=BOOT, kernel=KERNEL,
                           argv=ARGV, environment=ENV, cwd='/', intent=str(INTENT),
                           controlledWindow=True, receipt=initial,
                           interpretation='Existing local OS trust; no exclusive initialization or live-byte claim.')
            for index, argv in enumerate(ARGV):
                step = index + 1
                try:
                    if stop.reasons:
                        raise RuntimeError('owner stopped progression')
                    receipt = guards(cursor, stop, tuple(established))
                    journal.append('STEP_INTENT', step=step, attempt=step, argv=argv, receipt=receipt)
                    # Slow attribution and durable intent are complete. Resample
                    # fast facts immediately at submission, then record with dispatch.
                    child = OwnedChild(argv, fds[step], stop, journal, step)
                    boundary = fast_sample(cursor, tuple(established), receipt['custody'])
                    child.boundary = boundary
                    try:
                        child.run()
                    except BaseException:
                        stop.fail('dispatch_processing_error')
                    # run() cannot release an unreaped actual child on any parent error.
                    post = fast_sample(cursor, tuple(established), enforce=False)
                    try:
                        logs = log_receipt(fds[step])
                    except BaseException as error:
                        stop.fail('log_processing_error')
                        logs = {'unavailable': error_fact(error)}
                    if child.wait_status is not None and os.waitstatus_to_exitcode(child.wait_status) == 0:
                        try:
                            post = guards(cursor, stop, tuple(established) + (NAMES[index],))
                        except GuardRefusal as error:
                            post = error.receipt
                    outcome, reason = classify(child, post, index)
                    if 'EXISTS_CONFLICT' in logs.get('tags', []):
                        outcome, reason = 'UNCERTAIN', 'DETECTED_CONFLICT_NO_ADOPTION'
                    outcomes[index] = outcome
                    published_post = journal.retain(stop, 'POSTSTATE', step=step, outcome=outcome, reason=reason,
                                   commandFact=('UNKNOWN' if child.wait_status is None else
                                                'SIGNAL' if os.WIFSIGNALED(child.wait_status) else
                                                'ZERO_EXIT' if os.waitstatus_to_exitcode(child.wait_status) == 0 else 'POSITIVE_FAILED_EXIT'),
                                   receipt=post, log=logs)
                    if outcome == 'ESTABLISHED' and published_post is not None:
                        established.append(NAMES[index])
                    if outcome != 'ESTABLISHED' or stop.reasons or journal.failed:
                        break
                except BaseException as error:
                    stop.fail('step_barrier_refusal')
                    if isinstance(error, GuardRefusal):
                        refusal = error.receipt
                    else:
                        refusal = {'admitted': False, 'error': error_fact(error)}
                    journal.retain(stop, 'OWNER_NOTICE', stoppedBeforeStep=step, receipt=refusal)
                    break
            if len(established) == 2 and not stop.reasons and not journal.failed:
                try:
                    final = guards(cursor, stop, NAMES)
                    final['readinessBoundary'] = fast_sample(cursor, NAMES, final['custody'])
                    journal.append('SUPPORT_READY', receipt=final, machine=MACHINE, boot=BOOT,
                                   limits='Support only; no quota/EDQUOT/native/A/B/C/P1/E2E/CI/merge/rollout.')
                except BaseException as error:
                    stop.fail('readiness_refusal')
                    journal.retain(stop, 'OWNER_NOTICE', receipt=getattr(error, 'receipt', None), error=error_fact(error))
            result = ('SUPPORT_READY' if len(established) == 2 and not stop.reasons and not journal.failed else
                      'DEFINITE_PARTIAL' if established == ['quota_tree'] and outcomes[1] in
                      ('NOT_SUBMITTED', 'NOT_EXECUTED', 'DEFINITE_FAILED') else
                      'UNCERTAIN_V2_TREE_RETAINED' if established == ['quota_tree'] else
                      'DEFINITE_FAILED' if outcomes[0] in ('NOT_SUBMITTED', 'NOT_EXECUTED', 'DEFINITE_FAILED') else 'UNCERTAIN')
            journal.retain(stop, 'SUMMARY', result=result, established=established, outcomes=outcomes,
                           stopReasons=stop.reasons, parentSignals=stop.signals)
            return 0 if result == 'SUPPORT_READY' and not journal.failed else 1 if result.startswith('DEFINITE') else 2
        finally:
            # Every actual child has been waited by run's own finally first.
            # Crash/SIGKILL cannot publish: the occupied STEP_INTENT stays unresolved.
            for fd in fds:
                os.close(fd)
            if directory is not None:
                os.close(directory)
            cursor.close()


def observe_only():
    # This is factual parsing only. No append, dispatch, new intent, recovery or adoption.
    if bounded_text('/etc/machine-id') != MACHINE or bounded_text('/proc/sys/kernel/random/boot_id') != BOOT:
        raise RuntimeError('different machine/boot; original history unresolved')
    if os.uname().release != KERNEL:
        raise RuntimeError('kernel mismatch')
    check_path(str(INTENT))
    path = INTENT / 'journal.bin'
    check_path(str(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        records = read_records(fd)
    finally:
        os.close(fd)
    processes, logs = [], []
    for r in records:
        if r['event'] == 'DISPATCH' and r['phase'] == 'FORKED':
            ack = next((a for a in records if a['event'] == 'EXEC_PHASE' and a['step'] == r['step']), {})
            pid, start = r['pid'], ack.get('startTicks')
            try:
                now = ticks(pid)
                cmdfd = os.open('/proc/' + str(pid) + '/cmdline', os.O_RDONLY | os.O_NONBLOCK)
                try:
                    data = os.read(cmdfd, 4097)
                    if len(data) > 4096:
                        raise RuntimeError('process command bounds')
                finally:
                    os.close(cmdfd)
                expected = b'\0'.join(a.encode() for a in ARGV[r['step'] - 1]) + b'\0'
                processes.append({'step': r['step'], 'pid': pid, 'startTicks': now,
                                  'sameSampledCommand': start is not None and start == now and data == expected,
                                  'ownedWaitByObserver': False})
            except Exception as error:
                processes.append({'step': r['step'], 'pid': pid, 'unavailable': error_fact(error),
                                  'ownedWaitByObserver': False})
        if r['event'] == 'POSTSTATE' and 'sha256' in r.get('log', {}):
            log = INTENT / ('tree.log' if r['step'] == 1 else 'v2.log')
            check_path(str(log))
            data = bounded_file(log, LOG_SIZE, LOG_SIZE)
            length = r['log']['bytes']
            if type(length) is not int or not 0 <= length <= LOG_SIZE:
                raise RuntimeError('invalid log byte bounds')
            if hashlib.sha256(data[:length]).hexdigest() != r['log']['sha256'] or any(data[length:]):
                raise RuntimeError('log readback changed')
            logs.append({'step': r['step'], 'digestMatched': True})
    policy = {p: bounded_text(p) for p in POLICY}
    print(json.dumps({'mode': 'READ_ONLY_SAME_INTENT', 'records': records, 'processes': processes,
                      'logs': logs, 'currentPolicy': policy,
                      'modules': {n: module_state(n) for n in NAMES},
                      'limits': 'Samples cannot reconstruct exec/wait after parent crash/SIGKILL. Missing facts stay unresolved. No resume/retry/adoption/kill/unload.'}, indent=2))


def self_test():
    # Only private real journal files. No guards, proc/module/policy, loader,
    # host diagnostics, dispatch or kernel operations. Caller supplies TMPDIR.
    with tempfile.TemporaryDirectory(prefix='quota-journal-selftest-') as folder:
        p = pathlib.Path(folder) / 'journal'
        fd = os.open(p, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.posix_fallocate(fd, 0, SLOT * SLOTS)
            bound = binding()
            j = Journal(fd, bound)
            j.append('INTENT', machine=MACHINE, boot=BOOT, kernel=KERNEL, intent=str(INTENT),
                     argv=ARGV, environment=ENV, cwd='/', controlledWindow=True)
            assert len(read_integrity_records(fd)) == 1
            try:
                read_records(fd, bound)
            except RuntimeError:
                pass
            else:
                raise AssertionError('missing guard receipt accepted')
            original = os.pread(fd, 1, HEADER.size + 5)
            os.pwrite(fd, bytes([original[0] ^ 1]), HEADER.size + 5)
            try:
                read_integrity_records(fd)
            except (RuntimeError, ValueError):
                pass
            else:
                raise AssertionError('corruption accepted')
            os.pwrite(fd, original, HEADER.size + 5)
            os.ftruncate(fd, SLOT * SLOTS + 1)
            try:
                read_integrity_records(fd)
            except RuntimeError:
                pass
            else:
                raise AssertionError('oversized journal accepted')
            os.ftruncate(fd, SLOT * SLOTS - 1)
            try:
                read_integrity_records(fd)
            except RuntimeError:
                pass
            else:
                raise AssertionError('short journal accepted')
        finally:
            os.close(fd)
    print('Real journal roundtrip/corruption/exact-size refusals PASS; all host/effect branches UNRUN.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply-once', action='store_true')
    parser.add_argument('--controlled-window', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--observe', action='store_true')
    options = parser.parse_args()
    if sum([options.apply_once, options.self_test, options.observe]) > 1:
        parser.error('apply, self-test and observe are mutually exclusive')
    if options.self_test:
        self_test()
    elif options.observe:
        observe_only()
    elif options.apply_once:
        sys.exit(apply_once(options.controlled_window))
    else:
        print(json.dumps({'mode': 'PLAN_NO_EFFECT', 'host': MACHINE, 'boot': BOOT,
                          'argv': ARGV, 'intent': str(INTENT), 'sourceSha256': source_hash(),
                          'controlSha256': control_hash(), 'review': 'PENDING_INDEPENDENT_REVIEW',
                          'required': 'Reviewed source, future fresh guards, -I -S -B cleared root startup, existing operator controlled window.'}, indent=2))
