import datetime, errno, hashlib, json, os, re, resource, select, stat, sys, time

# Finite read-only operator payload. No tool calls, setns, file contents or writes.
MACHINE = 'd856d40da5ad4e23b4f67773e5942842'
TARGET = '/srv/workers/jobs/subscription-runtime/mimo-orchestrator-v1/workspaces'
COHORT_DIGEST = '8b0467e9cdf7d83bace82df97893ed77e9f311dcd83110a18cbfcd0fc01a7da4'
MAX_TEXT, MAX_MOUNT_TEXT, MAX_BYTES, MAX_OUTPUT = 2 * 1024**2, 8 * 1024**2, 64 * 1024**2, 2 * 1024**2
MAX_MOUNT_IO, MAX_VIEW_HEAP = 1024**3, 64 * 1024**2
NAME = re.compile(r'^[A-Za-z0-9_.-]{1,200}$')
DECIMAL = re.compile(r'^(0|[1-9][0-9]*)$')
ERRNO_NAMES = set('EACCES EPERM ENOENT ESRCH ENOTDIR ELOOP EINVAL EMFILE ENFILE EIO ENOMEM ESTALE EBADF ENOSYS ENOTSUP EOVERFLOW EAGAIN EINTR ETIMEDOUT'.split())
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
O_PATH = getattr(os, 'O_PATH', 0) | os.O_NOFOLLOW | os.O_CLOEXEC

class Refusal(Exception):
    pass

def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def pin(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size,
            s.st_nlink, s.st_blocks, s.st_mtime_ns, s.st_ctime_ns)

def object_pin(s):
    return (s.st_dev, s.st_ino)

class Budget:
    def __init__(self, seconds, entries=262144, hardlinks=16384):
        self.deadline = time.monotonic() + seconds
        self.entries, self.entry_limit, self.bytes, self.text_bytes = 0, entries, 0, 0
        self.hardlink_limit, self.fd_entries = hardlinks, 0
        self.incomplete, self.errors, self.error_total, self.error_counts = False, [], 0, {}
        self.owned = {}
        self.mount_io, self.mount_io_exhausted, self.view_heap, self.view_heap_peak, self.group_fds = 0, False, 0, 0, 0
        self.mount_allocations = {}

    def check(self):
        if time.monotonic() >= self.deadline:
            raise Refusal('Deadline')

    def entry(self):
        self.check()
        self.entries += 1
        if self.entries > self.entry_limit:
            raise Refusal('EntryLimit')
        self.charge(128)  # Conservative inventory overhead, before retaining the entry.

    def charge(self, size):
        self.check()
        self.bytes += size
        if self.bytes > MAX_BYTES:
            raise Refusal('ByteLimit')

    def heap_reserve(self, size):
        self.check()
        if size < 0 or self.view_heap + size > MAX_VIEW_HEAP: raise Refusal('ByteLimit')
        self.view_heap += size; self.view_heap_peak = max(self.view_heap_peak, self.view_heap)

    def heap_release(self, size):
        if size < 0 or size > self.view_heap: raise Refusal('ByteLimit')
        self.view_heap -= size

    def release_mounts(self, rows):
        size = self.mount_allocations.pop(id(rows)); rows.clear(); self.heap_release(size)

    def own(self, fd):
        try:
            self.charge(512); observed = object_pin(os.fstat(fd)); self.heap_reserve(512); self.owned[fd] = observed; return fd
        except BaseException:
            os.close(fd); raise

    def read_charge(self, size):
        self.text_bytes += size; self.charge(size)

    def close(self, fd):
        if fd in self.owned: self.owned.pop(fd); self.heap_release(512)
        os.close(fd)

    def issue(self, phase, error, pid=None, tid=None, index=None):
        self.incomplete, self.error_total = True, self.error_total + 1
        reason = str(error) if isinstance(error, Refusal) else errno.errorcode.get(getattr(error, 'errno', None), 'UnknownError')
        if not isinstance(error, Refusal) and reason != 'UnknownError' and reason not in ERRNO_NAMES: reason = 'OtherErrno'
        self.error_counts[reason] = self.error_counts.get(reason, 0) + 1
        row = {'phase': phase, 'reason': reason}
        if pid is not None: row['pid'] = pid
        if tid is not None: row['tid'] = tid
        if index is not None: row['cohortIndex'] = index
        if len(self.errors) < 256: self.errors.append(row)

def read_bytes_at(parent, name, limit, budget):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        result = bytearray()
        while True:
            budget.check()
            chunk = os.read(fd, min(65536, limit + 1 - len(result)))
            if not chunk: return bytes(result)
            budget.read_charge(len(chunk)); result.extend(chunk)
            if len(result) > limit: raise Refusal('TextLimit')
    finally: os.close(fd)

def lines_at(parent, name, budget, max_bytes=MAX_TEXT):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    digest, total, carry = hashlib.sha256(), 0, b''
    try:
        while True:
            budget.check(); chunk = os.read(fd, 65536)
            if not chunk: break
            total += len(chunk); budget.read_charge(len(chunk))
            if total > max_bytes: raise Refusal('TextLimit')
            digest.update(chunk); carry += chunk
            while b'\n' in carry:
                line, carry = carry.split(b'\n', 1)
                if len(line) > 8192: raise Refusal('LineLimit')
                yield line
            if len(carry) > 8192: raise Refusal('LineLimit')
        if carry: yield carry
    finally: os.close(fd)

def bounded_names(fd, limit, budget, numeric=False):
    names, total_bytes = [], 0
    with os.scandir(fd) as entries:
        for entry in entries:
            budget.entry()
            name = entry.name
            if numeric and not name.isascii(): raise Refusal('NameEncoding')
            if numeric and not name.isdecimal(): continue
            total_bytes += len(os.fsencode(name)); budget.charge(len(os.fsencode(name)))
            if len(names) >= limit: raise Refusal('NameLimit')
            names.append(name)
    return tuple(sorted(names))

class DirectoryChain:
    def __init__(self, path, budget):
        if not path.startswith('/') or any(x in ('.', '..') for x in path.split('/')):
            raise Refusal('PathShape')
        self.budget, self.links = budget, []
        self._proc_root_mount_id = None
        fd = budget.own(os.open('/', O_DIR)); self.links.append((None, '', fd, pin(os.fstat(fd))))
        try:
            for name in filter(None, path.split('/')):
                budget.check(); child = budget.own(os.open(name, O_DIR, dir_fd=fd))
                self.links.append((fd, name, child, pin(os.fstat(child)))); fd = child
        except BaseException:
            self.close(); raise
        self.fd = fd

    def _bind_proc_root(self, mount):
        # Only preflight's physically joined procfs root may have a volatile link count.
        if len(self.links) != 2 or self.links[-1][1] != 'proc' or mount['point'] != '/proc' or mount['root'] != '/' or mount['type'] != b'proc':
            raise Refusal('HostProcViewUnknown')
        actual = os.fstat(self.fd)
        if mount['dev'] != (os.major(actual.st_dev), os.minor(actual.st_dev)) or mount['id'] != mount_id(self.fd, self.budget):
            raise Refusal('HostProcViewUnknown')
        self._proc_root_mount_id = mount['id']

    def current(self):
        for parent, name, fd, expected in self.links:
            self.budget.check()
            actual = os.fstat(fd) if parent is None else os.stat(name, dir_fd=parent, follow_symlinks=False)
            if self._proc_root_mount_id is not None and fd == self.fd:
                # Keep every other pin field and both named/retained mount identities strict.
                held = pin(os.fstat(fd)); named = pin(actual)
                if named[:6] + named[7:] != expected[:6] + expected[7:] or held[:6] + held[7:] != expected[:6] + expected[7:]:
                    raise Refusal('AncestorDrift')
                fresh = self.budget.own(os.open(name, O_DIR, dir_fd=parent))
                try:
                    opened = pin(os.fstat(fresh))
                    if opened[:6] + opened[7:] != expected[:6] + expected[7:] or mount_id(fd, self.budget) != self._proc_root_mount_id or mount_id(fresh, self.budget) != self._proc_root_mount_id:
                        raise Refusal('AncestorDrift')
                finally: self.budget.close(fresh)
            elif pin(actual) != expected or pin(os.fstat(fd)) != expected: raise Refusal('AncestorDrift')

    def close(self):
        for _, _, fd, _ in reversed(self.links): self.budget.close(fd)
        self.links = []

def mount_id(fd, budget):
    parent = os.open('/proc/self/fdinfo', O_DIR)
    try:
        for line in read_bytes_at(parent, str(fd), 8192, budget).splitlines():
            if line.startswith(b'mnt_id:\t'):
                value = line[8:]
                if value.isdigit(): return int(value)
        raise Refusal('MountIdentityUnknown')
    finally: os.close(parent)

def unescape_mount(value):
    def replace(match): return bytes([int(match.group(1), 8)])
    value = re.sub(rb'\\([0-7]{3})', replace, value)
    if b'\x00' in value or b'\n' in value or b'\r' in value: raise Refusal('AmbiguousMountPath')
    return os.fsdecode(value)

def mount_lines(fd, budget):
    carry, total = b'', 0
    budget.heap_reserve(65536 + 8192)
    try:
        while True:
            budget.check()
            if budget.mount_io_exhausted: raise Refusal('ByteLimit')
            chunk = os.read(fd, 65536)
            if not chunk: break
            budget.mount_io += len(chunk); budget.text_bytes += len(chunk); total += len(chunk)
            if budget.mount_io > MAX_MOUNT_IO:
                budget.mount_io_exhausted = True; raise Refusal('ByteLimit')
            if total > MAX_MOUNT_TEXT: raise Refusal('TextLimit')
            carry += chunk
            while b'\n' in carry:
                line, carry = carry.split(b'\n', 1)
                if len(line) > 8192: raise Refusal('LineLimit')
                yield line
            if len(carry) > 8192: raise Refusal('LineLimit')
        if carry: yield carry
    finally: budget.heap_release(65536 + 8192)

def mount_digest_fd(fd, budget):
    os.lseek(fd, 0, os.SEEK_SET); digest = hashlib.sha256(); lines = mount_lines(fd, budget)
    try:
        for line in lines: digest.update(line + b'\n')
        return digest.hexdigest()
    finally: lines.close()

def mount_table_fd(fd, budget):
    rows, digest, allocated = [], hashlib.sha256(), 0
    lines = mount_lines(fd, budget)
    try:
        for line in lines:
            digest.update(line + b'\n'); fields = line.split(b' ')
            if len(fields) < 10 or b'-' not in fields or not fields[0].isdigit(): raise Refusal('MountShape')
            split = fields.index(b'-')
            if split < 6 or len(fields) < split + 4: raise Refusal('MountShape')
            dev = fields[2].split(b':')
            if len(dev) != 2 or not all(x.isdigit() for x in dev): raise Refusal('MountShape')
            size = 128 + len(line); budget.heap_reserve(size); allocated += size
            rows.append({'id': int(fields[0]), 'dev': (int(dev[0]), int(dev[1])),
                         'root': unescape_mount(fields[3]), 'point': unescape_mount(fields[4]),
                         'type': fields[split + 1], 'options': fields[5] + b',' + fields[split + 3]})
        budget.mount_allocations[id(rows)] = allocated
        return rows, digest.hexdigest()
    except BaseException:
        rows.clear(); budget.heap_release(allocated); raise
    finally: lines.close()

def mount_table(parent, budget):
    fd = os.open('mountinfo', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try: return mount_table_fd(fd, budget)
    finally: os.close(fd)

def mount_digest(parent, budget):
    fd = os.open('mountinfo', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try: return mount_digest_fd(fd, budget)
    finally: os.close(fd)

def beneath(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')

def filesystem_path(path, mounts):
    if not path.startswith('/') or any(x in ('.', '..') for x in path.split('/')):
        raise Refusal('PathShape')
    candidates = [m for m in mounts if beneath(path, m['point'])]
    if not candidates: raise Refusal('MountJoinUnknown')
    length = max(len(m['point']) for m in candidates)
    selected = [m for m in candidates if len(m['point']) == length]
    if len(selected) != 1: raise Refusal('MountJoinUnknown')
    m = selected[0]; suffix = path[len(m['point']):].lstrip('/')
    return m, m['root'].rstrip('/') + ('/' + suffix if suffix else '') or '/'

def source_leaf(root_fd, relative, budget):
    parts = relative.split('/') if relative else []
    if any(not x or x in ('.', '..') for x in parts) or len(parts) > 256:
        raise Refusal('PathShape')
    held, fd = [], root_fd
    try:
        for name in parts[:-1]:
            budget.check(); fd = budget.own(os.open(name, O_DIR, dir_fd=fd)); held.append(fd)
        if not parts: return os.fstat(fd)
        budget.check(); result = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(result.st_mode): raise Refusal('SymlinkJoinUnknown')
        return result
    finally:
        for fd in reversed(held): budget.close(fd)

def namespace_pin(proc_fd, name):
    return object_pin(os.stat('ns/' + name, dir_fd=proc_fd))

def retain_namespaces(proc_fd, budget):
    held = []
    try:
        for name in ('mnt', 'pid', 'user'):
            held.append(budget.own(os.open('ns/' + name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=proc_fd)))
        return held
    except BaseException:
        for fd in reversed(held): budget.close(fd)
        raise

def birth(proc_fd, budget):
    raw = read_bytes_at(proc_fd, 'stat', 8192, budget)
    end = raw.rfind(b') ')
    fields = raw[end + 2:].split() if end >= 0 else []
    if len(fields) < 20 or not fields[19].isdigit(): raise Refusal('StatShape')
    return fields[19].decode('ascii')

def link_at(proc_fd, name, budget):
    budget.check(); value = os.readlink(name, dir_fd=proc_fd)
    if len(os.fsencode(value)) > 4096: raise Refusal('LinkLimit')
    return value

def identity(proc_fd, budget):
    return (object_pin(os.fstat(proc_fd)), birth(proc_fd, budget),
            namespace_pin(proc_fd, 'mnt'), namespace_pin(proc_fd, 'pid'),
            namespace_pin(proc_fd, 'user'), object_pin(os.stat('root', dir_fd=proc_fd)))

def preflight(budget):
    if os.geteuid() != 0 or not getattr(os, 'O_PATH', 0): raise Refusal('PrivilegeOrPlatformUnknown')
    etc, proc, self_fd, one_fd, ns_files, rows = None, None, None, None, [], None
    try:
        etc, proc = DirectoryChain('/etc', budget), DirectoryChain('/proc', budget)
        self_fd = os.open('self', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=proc.fd)
        one_fd = os.open('1', O_DIR, dir_fd=proc.fd)
        machine = read_bytes_at(etc.fd, 'machine-id', 128, budget).strip().decode('ascii')
        boot = read_bytes_at(proc.fd, 'sys/kernel/random/boot_id', 128, budget).strip().decode('ascii')
        if machine != MACHINE or not re.fullmatch('[a-f0-9-]{36}', boot): raise Refusal('MachineOrBootMismatch')
        own = identity(self_fd, budget)
        task_fd = os.open('task', O_DIR, dir_fd=self_fd)
        own_tasks = {}
        try:
            for tid in bounded_names(task_fd, 4096, budget, True):
                t = os.open(tid, O_DIR, dir_fd=task_fd)
                try: own_tasks[int(tid)] = birth(t, budget)
                finally: os.close(t)
        finally: os.close(task_fd)
        ns_files = retain_namespaces(self_fd, budget)
        if tuple(object_pin(os.fstat(fd)) for fd in ns_files) != own[2:5]: raise Refusal('OwnNamespaceDrift')
        one = identity(one_fd, budget)
        if own[2:5] != one[2:5]: raise Refusal('HostProcViewUnknown')
        rows, digest = mount_table(self_fd, budget)
        m, _ = filesystem_path('/proc', rows)
        if m['type'] != b'proc' or m['id'] != mount_id(proc.fd, budget): raise Refusal('HostProcViewUnknown')
        proc._bind_proc_root(m)
        if any(x.startswith(b'hidepid=') and x != b'hidepid=0' for x in m['options'].split(b',')):
            budget.issue('ProcVisibility', Refusal('ProcHiddenView'))
        effective = None
        for line in lines_at(self_fd, 'status', budget):
            if line.startswith(b'CapEff:\t'):
                value = line[8:]
                if re.fullmatch(rb'[a-fA-F0-9]{1,16}', value): effective = int(value, 16)
                break  # Only the selected capability metadata, never a status payload.
        if effective is None or not effective & (1 << 19) or not effective & ((1 << 1) | (1 << 2)):
            budget.issue('ProcVisibility', Refusal('ProcCapabilitiesIncomplete'))
        return {'machineId': machine, 'bootId': boot, 'ownPid': os.getpid(), 'ownBirth': own[1],
                'ownIdentity': own, 'oneIdentity': one, 'ownTasks': own_tasks, 'proc': proc, 'etc': etc, 'selfFd': self_fd, 'oneFd': one_fd,
                'mounts': rows, 'mountDigest': digest, 'namespaceFiles': ns_files}
    except BaseException:
        if rows is not None: budget.release_mounts(rows)
        for fd in reversed(ns_files): budget.close(fd)
        if one_fd is not None: os.close(one_fd)
        if self_fd is not None: os.close(self_fd)
        if proc is not None: proc.close()
        if etc is not None: etc.close()
        raise

def finish_preflight(p, budget):
    machine = read_bytes_at(p['etc'].fd, 'machine-id', 128, budget).strip().decode('ascii')
    boot = read_bytes_at(p['proc'].fd, 'sys/kernel/random/boot_id', 128, budget).strip().decode('ascii')
    if (machine, boot) != (p['machineId'], p['bootId']): raise Refusal('MachineOrBootDrift')
    if identity(p['selfFd'], budget) != p['ownIdentity']: raise Refusal('OwnNamespaceDrift')
    if identity(p['oneFd'], budget) != p['oneIdentity']: raise Refusal('HostProcViewUnknown')
    if tuple(object_pin(os.fstat(fd)) for fd in p['namespaceFiles']) != p['ownIdentity'][2:5]: raise Refusal('OwnNamespaceDrift')
    p['proc'].current(); p['etc'].current()
    if mount_digest(p['selfFd'], budget) != p['mountDigest']: raise Refusal('MountDrift')

def close_preflight(p):
    p['proc'].budget.release_mounts(p['mounts'])
    for fd in reversed(p['namespaceFiles']): p['proc'].budget.close(fd)
    os.close(p['oneFd']); os.close(p['selfFd']); p['proc'].close(); p['etc'].close()

def capture_cohort(rows, parent, mounts, budget):
    result, seen = [], set()
    for row in rows:
        try: budget.check()
        except Refusal as error:
            budget.issue('CohortCapture', error); break
        item = {'row': row, 'status': 'Unknown', 'workspaceFd': None, 'fd': None}
        result.append(item)
        try:
            w = item['workspaceFd'] = budget.own(os.open(row['name'], O_DIR, dir_fd=parent.fd))
            item['workspacePin'] = pin(os.fstat(w))
            wm, wp = filesystem_path(row['workspace'], mounts)
            if wm['id'] != mount_id(w, budget): raise Refusal('WorkspaceMountJoinUnknown')
            item['workspacePhysical'], item['workspaceDev'] = wp, wm['dev']
            f = item['fd'] = budget.own(os.open('node_modules', O_DIR, dir_fd=w)); s = os.fstat(f)
            if object_pin(s) != (int(row['historicalDev']), int(row['historicalIno'])):
                raise Refusal('HistoricalRootMismatch')
            if object_pin(s) in seen: raise Refusal('RootAlias')
            seen.add(object_pin(s)); item['pin'] = pin(s); item['mountId'] = mount_id(f, budget)
            m, physical = filesystem_path(row['dependencies'], mounts)
            if m['id'] != item['mountId'] or m['dev'] != (os.major(s.st_dev), os.minor(s.st_dev)):
                raise Refusal('RootMountJoinUnknown')
            item['physical'], item['dev'], item['status'] = physical, m['dev'], 'ObservedRoot'
        except Exception as error: budget.issue('CohortRoot', error, index=row['index'])
    return result

def check_cohort(items, parent, budget):
    parent.current()
    for item in items:
        if item['status'] != 'ObservedRoot': continue
        row, w, f = item['row'], item['workspaceFd'], item['fd']
        try:
            if pin(os.stat(row['name'], dir_fd=parent.fd, follow_symlinks=False)) != item['workspacePin']:
                raise Refusal('WorkspaceDrift')
            if pin(os.stat('node_modules', dir_fd=w, follow_symlinks=False)) != item['pin'] or pin(os.fstat(f)) != item['pin']:
                raise Refusal('TreeDrift')
            if mount_id(f, budget) != item['mountId']: raise Refusal('MountDrift')
        except Exception as error:
            item['status'] = 'Unknown'; budget.issue('CohortFinalJoin', error, index=row['index'])

def close_cohort(items, budget):
    for item in reversed(items):
        for key in ('fd', 'workspaceFd'):
            if item[key] is not None: budget.close(item[key])

def classify_path(path, target, mounts, items, budget, collector_mounts=None):
    exact = []
    for item in items:
        if item['status'] == 'ObservedRoot' and target == tuple(item['pin'][:2]):
            exact.append((item, 'TargetObject', 'Dependencies'))
        elif 'workspacePin' in item and target == tuple(item['workspacePin'][:2]):
            exact.append((item, 'TargetObject', 'Workspace'))
    if exact: return exact, []
    if '\n' in path or '\r' in path or path.endswith(' (deleted)'):
        return [], [Refusal('AmbiguousReference')]
    matches, issues, candidates, seen = [], [], set(), set()
    # proc d_path can render relative to the collector, not the target task root.
    # Both interpretations are actual mount views; strings alone never prove a match.
    for view in (mounts, collector_mounts):
        if view is None: continue
        try:
            budget.check(); m, physical = filesystem_path(path, view)
            candidates.add((m['dev'], physical))
        except Exception as error: issues.append(error)
    for dev, physical in candidates:
        for item in items:
            scope = None
            if item['status'] == 'ObservedRoot' and item['dev'] == dev and beneath(physical, item['physical']):
                root, fd, scope = item['physical'], item['fd'], 'Dependencies'
            elif 'workspacePhysical' in item and item['workspaceDev'] == dev and beneath(physical, item['workspacePhysical']):
                root, fd, scope = item['workspacePhysical'], item['workspaceFd'], 'Workspace'
            if scope:
                try:
                    relative = physical[len(root):].lstrip('/')
                    if object_pin(source_leaf(fd, relative, budget)) != target: raise Refusal('ReferenceObjectMismatch')
                    key = (id(item), scope)
                    if key not in seen:
                        seen.add(key); matches.append((item, 'NamespacePathAndObject', scope))
                except Exception as error: issues.append(error)
    return matches, issues

def process_ids(proc, budget):
    result = set()
    leaders = bounded_names(proc, 4096, budget, True)
    for pid_name in leaders:
        budget.check()
        pid = int(pid_name)
        try:
            fd = os.open(pid_name + '/task', O_DIR, dir_fd=proc)
            try:
                for tid_name in bounded_names(fd, 4096, budget, True):
                    if len(result) >= 4096: raise Refusal('IdentityLimit')
                    result.add((pid, int(tid_name)))
            finally: os.close(fd)
        except Exception as error: budget.issue('TaskDiscovery', error, pid=pid)
    return result, len(leaders)

def reference_origin(pid, tid, ticks, audit, budget, fd_number, target):
    if pid != audit['ownPid'] or audit['ownTasks'].get(tid) != ticks: return 'External'
    if fd_number is not None and budget.owned.get(fd_number) == target: return 'AuditCreated'
    return 'UnclassifiedSelf'

class MountView:
    def __init__(self, task, before, root, budget):
        self.budget, self.key = budget, (before[2], before[5], mount_id(root, budget))
        self.fds, self.members, self.invalid, self.digest = [], [], False, None
        self.matches, self.observations, self.poll_drift = [], [], False
        budget.heap_reserve(1024)
        try:
            census = os.open('/proc/self/fd', O_DIR)
            try: current = bounded_names(census, 4096, budget, True)
            finally: os.close(census)
            soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
            if budget.group_fds + 3 > 768 or soft != resource.RLIM_INFINITY and len(current) + 3 + 300 > soft:
                raise Refusal('FdLimit')
            for name, flags in (('ns/mnt', os.O_RDONLY | os.O_CLOEXEC), ('root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC), ('mountinfo', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)):
                held = budget.own(os.open(name, flags, dir_fd=task)); self.fds.append(held); budget.group_fds += 1
            self.poller = select.poll(); self.poller.register(self.fds[2], select.POLLPRI | select.POLLERR | select.POLLHUP | select.POLLNVAL)
            self.poll()
            if object_pin(os.fstat(self.fds[0])) != before[2] or object_pin(os.fstat(self.fds[1])) != before[5] or mount_id(self.fds[1], budget) != self.key[2] or identity(task, budget) != before:
                raise Refusal('ProcessIdentityDrift')
        except BaseException:
            self.close(); raise

    def poll(self):
        self.budget.check()
        if self.poll_drift: raise Refusal('MountDrift')
        if any(mask & (select.POLLPRI | select.POLLERR | select.POLLHUP | select.POLLNVAL) for _, mask in self.poller.poll(0)):
            self.invalid = self.poll_drift = True; raise Refusal('MountDrift')

    def validate(self, proc):
        self.poll()
        if object_pin(os.fstat(self.fds[0])) != self.key[0] or object_pin(os.fstat(self.fds[1])) != self.key[1] or mount_id(self.fds[1], self.budget) != self.key[2]:
            raise Refusal('ProcessIdentityDrift')
        for pid, tid, expected in self.members:
            self.budget.check(); task = os.open(str(pid) + '/task/' + str(tid), O_DIR, dir_fd=proc)
            try:
                root = os.open('root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=task)
                try:
                    if identity(task, self.budget) != expected or mount_id(root, self.budget) != self.key[2]: raise Refusal('ProcessIdentityDrift')
                finally: os.close(root)
            finally: os.close(task)
        self.poll()

    def close(self):
        failed = None
        for fd in reversed(self.fds):
            try: self.budget.close(fd)
            except Exception as error: failed = error
            finally: self.budget.group_fds -= 1
        self.fds = []; self.budget.heap_release(1024 + len(self.members) * 512); self.members.clear()
        if failed is not None: raise failed

def discover_views(proc, start_ids, budget):
    groups = {}
    try:
        for pid, tid in sorted(start_ids):
            task, root = None, None
            try:
                budget.check(); task = os.open(str(pid) + '/task/' + str(tid), O_DIR, dir_fd=proc)
                before = identity(task, budget); root = os.open('root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=task)
                if object_pin(os.fstat(root)) != before[5]: raise Refusal('ProcessIdentityDrift')
                key = (before[2], before[5], mount_id(root, budget))
                if key not in groups:
                    if len(groups) >= 256: raise Refusal('NamespaceViewLimit')
                    groups[key] = MountView(task, before, root, budget)
                group = groups[key]; group.poll(); budget.heap_reserve(512); group.members.append((pid, tid, before))
            except Exception as error: budget.issue('ProcessView', error, pid, tid)
            finally:
                if root is not None: os.close(root)
                if task is not None: os.close(task)
        return list(groups.values())
    except BaseException:
        for group in groups.values(): group.close()
        raise

def mount_candidates(mounts, items, budget):
    pairs = []
    try:
        for m in mounts:
            for item in items:
                budget.check(); scope, ancestor = None, False
                if item['status'] == 'ObservedRoot' and item['dev'] == m['dev'] and beneath(m['root'], item['physical']):
                    physical, source, scope = item['physical'], item['fd'], 'Dependencies'
                elif 'workspacePhysical' in item and item['workspaceDev'] == m['dev'] and beneath(m['root'], item['workspacePhysical']):
                    physical, source, scope = item['workspacePhysical'], item['workspaceFd'], 'Workspace'
                elif item['status'] == 'ObservedRoot' and item['dev'] == m['dev'] and beneath(item['physical'], m['root']): ancestor = True
                if scope or ancestor:
                    if len(pairs) >= 16384: raise Refusal('ByteLimit')
                    budget.heap_reserve(256); pairs.append((m, item, scope, None if ancestor else physical, None if ancestor else source))
        return pairs
    except BaseException:
        budget.heap_release(len(pairs) * 256); pairs.clear(); raise

def proc_observation(p, items, budget):
    start_ids, leader_count = process_ids(p['proc'].fd, budget)
    matches, observations, views, namespace_fds = [], [], set(), set()
    counts = {'externalCurrentReferences': 0, 'auditOwnedReferences': 0, 'ancestorExposures': 0,
              'fdEntries': 0, 'mapEntries': 0, 'matchesOmitted': 0, 'observationsOmitted': 0,
              'namespaceFdTargetsUnobserved': 0}
    match_bytes, observation_bytes, tasks_observed = 0, 0, 0
    def emit(item, kind, basis, scope, pid, tid, ticks, start, own, tracked=False):
        nonlocal match_bytes
        bucket = 'AuditOwned' if own else 'ExternalCurrentReference'
        if kind == 'AncestorExposure':
            counts['ancestorExposures'] += 1
            return
        elif own: counts['auditOwnedReferences'] += 1
        else: counts['externalCurrentReferences'] += 1
        row = {'cohortIndex': item['row']['index'], 'name': item['row']['name'],
                        'path': item['row']['dependencies'] if scope == 'Dependencies' else item['row']['workspace'],
                        'scope': scope, 'pid': pid, 'tid': tid, 'startTicks': ticks,
                        'kind': kind, 'basis': basis, 'bucket': bucket,
                        'auditCreatedHandle': tracked if own else None,
                        'startedAt': start, 'finishedAt': stamp(), 'join': 'Pending'}
        size = len(json.dumps(row, separators=(',', ':')).encode()) + 64
        if len(matches) == 4096 or match_bytes + size > 768 * 1024:
            counts['matchesOmitted'] += 1; budget.incomplete = True; return
        match_bytes += size; matches.append(row); group.matches.append(row)
    groups = discover_views(p['proc'].fd, start_ids, budget)
    try:
        for group in groups:
            mounts, pairs = None, []
            try:
                group.poll(); mounts, group.digest = mount_table_fd(group.fds[2], budget); group.poll()
                pairs = mount_candidates(mounts, items, budget)
                for pid, tid, expected_identity in group.members:
                    try: budget.check()
                    except Refusal as error:
                        budget.issue('ProcessScan', error); break
                    base = str(pid) + '/task/' + str(tid); fd, root_fd, ns_files = None, None, []
                    begin, mark = stamp(), len(matches)
                    ob = {'pid': pid, 'tid': tid, 'startedAt': begin, 'join': 'Unknown'}
                    tasks_observed += 1
                    try:
                        group.poll()
                        fd = os.open(base, O_DIR, dir_fd=p['proc'].fd); before = identity(fd, budget); ticks = before[1]
                        if before != expected_identity: raise Refusal('ProcessIdentityDrift')
                        root_fd = budget.own(os.open('root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=fd))
                        if object_pin(os.fstat(root_fd)) != before[5] or mount_id(root_fd, budget) != group.key[2]: raise Refusal('ProcessIdentityDrift')
                        ns_files = retain_namespaces(fd, budget)
                        if tuple(object_pin(os.fstat(n)) for n in ns_files) != before[2:5]: raise Refusal('ProcessIdentityDrift')
                        own = pid == p['ownPid'] and ticks == p['ownTasks'].get(tid)
                        if pid == p['ownPid'] and not own: budget.issue('SelfOrigin', Refusal('UnclassifiedSelfOrigin'), pid, tid)
                        ob['startTicks'] = ticks
                        view = group.key; views.add(view)
                        if len(views) > 256: raise Refusal('NamespaceViewLimit')
                        for name, kind in (('cwd', 'Cwd'), ('root', 'Root'), ('exe', 'Exe')):
                            try:
                                raw = link_at(fd, name, budget); target = object_pin(os.stat(name, dir_fd=fd))
                                found, issues = classify_path(raw, target, mounts, items, budget, p['mounts'])
                                for error in issues:
                                    if isinstance(error, OSError) or isinstance(error, Refusal) and str(error) in ('ReferenceObjectMismatch', 'SymlinkJoinUnknown', 'AmbiguousReference'): group.invalid = True
                                    budget.issue('ProcessLink', error, pid, tid)
                                for item, basis, scope in found:
                                    emit(item, kind, basis, scope, pid, tid, ticks, begin, own)
                                    if own: budget.issue('SelfOrigin', Refusal('UnclassifiedSelfOrigin'), pid, tid)
                            except Exception as error: budget.issue('ProcessLink', error, pid, tid)
                        fds = os.open('fd', O_DIR, dir_fd=fd)
                        try:
                            names = bounded_names(fds, 1024, budget, True)
                            for name in names:
                                budget.fd_entries += 1; counts['fdEntries'] += 1
                                if budget.fd_entries > 32768: raise Refusal('FdLimit')
                                try:
                                    raw = link_at(fds, name, budget)
                                    namespace = re.fullmatch(r'mnt:\[([0-9]{1,32})\]', raw)
                                    if namespace: namespace_fds.add(int(namespace.group(1)))
                                    if not raw.startswith('/'): continue
                                    target = object_pin(os.stat(name, dir_fd=fds))
                                    tracked = reference_origin(pid, tid, ticks, p, budget, int(name), target) == 'AuditCreated'
                                    found, issues = classify_path(raw, target, mounts, items, budget, p['mounts'])
                                    for error in issues:
                                        if isinstance(error, OSError) or isinstance(error, Refusal) and str(error) in ('ReferenceObjectMismatch', 'SymlinkJoinUnknown', 'AmbiguousReference'): group.invalid = True
                                        budget.issue('FdEntry', error, pid, tid)
                                    for item, basis, scope in found:
                                        emit(item, 'Fd', basis, scope, pid, tid, ticks, begin, own, tracked)
                                        if own and not tracked: budget.issue('SelfOrigin', Refusal('UnclassifiedSelfOrigin'), pid, tid)
                                except Exception as error: budget.issue('FdEntry', error, pid, tid)
                            if names != bounded_names(fds, 1024, budget, True): raise Refusal('FdMembershipDrift')
                        finally: os.close(fds)
                        for line in lines_at(fd, 'maps', budget):
                            try:
                                counts['mapEntries'] += 1; fields = line.split(None, 5)
                                if len(fields) < 5: raise Refusal('MapShape')
                                dev, inode = fields[3].split(b':'), fields[4]
                                if len(dev) != 2 or not inode.isdigit(): raise Refusal('MapShape')
                                if len(fields) == 5 or not fields[5].startswith(b'/') or inode == b'0': continue
                                if b'\\' in fields[5]: raise Refusal('AmbiguousReference')
                                target = (os.makedev(int(dev[0], 16), int(dev[1], 16)), int(inode))
                                found, issues = classify_path(os.fsdecode(fields[5]), target, mounts, items, budget, p['mounts'])
                                for error in issues:
                                    if isinstance(error, OSError) or isinstance(error, Refusal) and str(error) in ('ReferenceObjectMismatch', 'SymlinkJoinUnknown', 'AmbiguousReference'): group.invalid = True
                                    budget.issue('MapEntry', error, pid, tid)
                                for item, basis, scope in found:
                                    emit(item, 'Map', basis, scope, pid, tid, ticks, begin, own)
                                    if own: budget.issue('SelfOrigin', Refusal('UnclassifiedSelfOrigin'), pid, tid)
                            except Exception as error: budget.issue('MapEntry', error, pid, tid)
                        for m, item, scope, physical, source in pairs:
                            budget.check()
                            if scope is None:
                                emit(item, 'AncestorExposure', 'NamespaceMountRoot', 'Dependencies', pid, tid, ticks, begin, own)
                            else:
                                try:
                                    actual = source_leaf(root_fd, m['point'].lstrip('/'), budget)
                                    joined = source_leaf(source, m['root'][len(physical):].lstrip('/'), budget)
                                    if object_pin(actual) != object_pin(joined): raise Refusal('ReferenceObjectMismatch')
                                    emit(item, 'DirectMountBinding', 'NamespaceMountRoot', scope, pid, tid, ticks, begin, own)
                                except Exception as error:
                                    group.invalid = True; budget.issue('ProcessView', error, pid, tid)
                        if object_pin(os.fstat(root_fd)) != before[5]: raise Refusal('ProcessIdentityDrift')
                        if identity(fd, budget) != before or object_pin(os.stat(base, dir_fd=p['proc'].fd)) != before[0]:
                            raise Refusal('ProcessIdentityDrift')
                        if mount_id(root_fd, budget) != group.key[2]: raise Refusal('ProcessIdentityDrift')
                        group.poll(); ob['join'] = 'Pending'
                    except Exception as error:
                        group.invalid = True; budget.issue('ProcessView', error, pid, tid)
                    finally:
                        for n in reversed(ns_files):
                            try: budget.close(n)
                            except Exception as error: group.invalid = True; budget.issue('ProcessView', error, pid, tid); ob['join'] = 'Unknown'
                        if root_fd is not None:
                            try: budget.close(root_fd)
                            except Exception as error: group.invalid = True; budget.issue('ProcessView', error, pid, tid); ob['join'] = 'Unknown'
                        if fd is not None:
                            try: os.close(fd)
                            except Exception as error: group.invalid = True; budget.issue('ProcessView', error, pid, tid); ob['join'] = 'Unknown'
                        ob['finishedAt'] = stamp(); group.observations.append(ob)
                        for row in matches[mark:]: row['join'] = ob['join']
                        size = len(json.dumps(ob, separators=(',', ':')).encode())
                        if observation_bytes + size <= 512 * 1024:
                            observation_bytes += size; observations.append(ob)
                        else: counts['observationsOmitted'] += 1; budget.incomplete = True
            except Exception as error:
                group.invalid = True; budget.issue('ProcessView', error)
            finally:
                budget.heap_release(len(pairs) * 256); pairs.clear()
                if mounts is not None: budget.release_mounts(mounts)
        for group in groups:
            try:
                group.validate(p['proc'].fd)
                if mount_digest_fd(group.fds[2], budget) != group.digest: raise Refusal('MountDrift')
                group.poll()
            except Exception as error:
                group.invalid = True; budget.issue('ProcessView', error)
        # Global barrier: all groups stay Pending until every final check and close completes.
        for group in groups:
            try: group.validate(p['proc'].fd)
            except Exception as error: group.invalid = True; budget.issue('ProcessView', error)
    finally:
        for group in groups:
            try: group.poll()
            except Exception as error: group.invalid = True; budget.issue('ProcessView', error)
        for group in groups:
            try: group.close()
            except Exception as error: group.invalid = True; budget.issue('ProcessView', error)
    for group in groups:
        for row in group.matches + group.observations:
            row['join'] = 'Unknown' if group.invalid or row['join'] != 'Pending' else 'Joined'
    try:
        end_ids, _ = process_ids(p['proc'].fd, budget)
        if start_ids != end_ids:
            budget.issue('FinalTaskDiscovery', Refusal('TaskMembershipDrift'))
            for row in matches + observations: row['join'] = 'Unknown'
    except Exception as error:
        budget.issue('FinalTaskDiscovery', error)
        for row in matches + observations: row['join'] = 'Unknown'
    unobserved = namespace_fds - {view[0][1] for view in views}
    counts['namespaceFdTargetsUnobserved'] = len(unobserved)
    if unobserved: budget.issue('NamespaceCoverage', Refusal('UnobservedMountNamespace'))
    return {'leadersDiscovered': leader_count, 'tasksDiscovered': len(start_ids),
            'tasksObserved': tasks_observed, 'namespaceRootViewsObserved': len(views),
            'counts': counts, 'observations': observations, 'matches': matches}

def inode_kind(s):
    if stat.S_ISDIR(s.st_mode): return 'Directory'
    if stat.S_ISREG(s.st_mode): return 'Regular'
    if stat.S_ISLNK(s.st_mode): return 'Symlink'
    raise Refusal('UnexpectedEntryKind')

def walk_allocated(root_fd, budget, hardlinks, index, root_mount=None):
    root_mount = mount_id(root_fd, budget) if root_mount is None else root_mount
    counts, allocated, apparent, inode_count = {'Directory': 0, 'Regular': 0, 'Symlink': 0}, 0, 0, 0
    def add(s):
        nonlocal allocated, apparent, inode_count
        kind, key = inode_kind(s), object_pin(s)
        counts[kind] += 1
        if s.st_blocks < 0 or s.st_size < 0: raise Refusal('NegativeMetadata')
        if kind != 'Directory' and s.st_nlink > 1:
            fact = (kind, s.st_blocks, s.st_nlink, s.st_size, s.st_ctime_ns, s.st_mtime_ns)
            if key in hardlinks:
                row = hardlinks[key]
                if row['fact'] != fact: raise Refusal('HardlinkConflict')
                row['members'][index] = row['members'].get(index, 0) + 1
                return
            if len(hardlinks) >= budget.hardlink_limit: raise Refusal('HardlinkLimit')
            hardlinks[key] = {'fact': fact, 'members': {index: 1}}
        allocated += s.st_blocks * 512; apparent += s.st_size; inode_count += 1
    def visit(fd, depth):
        if depth > 256: raise Refusal('DepthLimit')
        budget.check(); before = os.fstat(fd)
        if before.st_dev != os.fstat(root_fd).st_dev or mount_id(fd, budget) != root_mount:
            raise Refusal('MountedEntry')
        add(before); names = bounded_names(fd, budget.entry_limit, budget)
        for name in names:
            budget.check(); first = os.stat(name, dir_fd=fd, follow_symlinks=False); kind = inode_kind(first)
            child = budget.own(os.open(name, O_DIR if kind == 'Directory' else O_PATH, dir_fd=fd))
            try:
                actual = os.fstat(child)
                if pin(first) != pin(actual) or actual.st_dev != before.st_dev or mount_id(child, budget) != root_mount:
                    raise Refusal('EntryIdentityOrMountDrift')
                if kind == 'Directory': visit(child, depth + 1)
                else: add(actual)
                if pin(os.stat(name, dir_fd=fd, follow_symlinks=False)) != pin(os.fstat(child)):
                    raise Refusal('EntryDrift')
            finally: budget.close(child)
        if names != bounded_names(fd, budget.entry_limit, budget) or pin(os.fstat(fd)) != pin(before):
            raise Refusal('DirectoryMembershipDrift')
    visit(root_fd, 0)
    return {'allocatedUniqueWithinPartitionBytes': str(allocated), 'apparentUniqueWithinPartitionBytes': str(apparent),
            'uniqueInodes': str(inode_count), 'entryKindsObserved': counts}

def allocation_observation(items, partition, budget):
    selected, hardlinks, results = items[partition * 4:partition * 4 + 4], {}, []
    for item in selected:
        row = {'cohortIndex': item['row']['index'], 'name': item['row']['name'], 'status': 'Unmeasured',
               'startedAt': stamp(), 'measurement': None}
        results.append(row)
        try:
            if item['status'] != 'ObservedRoot': raise Refusal('RootUnmeasured')
            row['measurement'] = walk_allocated(item['fd'], budget, hardlinks, item['row']['index'], item['mountId'])
            row['status'] = 'ObservedMetadata'
        except Exception as error:
            budget.issue('AllocationTree', error, index=item['row']['index']); row['status'] = 'Unknown'
        row['finishedAt'] = stamp()
    crosslinks, serialized_bytes, omitted = [], 0, 0
    for (dev, ino), value in hardlinks.items():
        kind, blocks, links, size, ctime, mtime = value['fact']
        row = {'dev': str(dev), 'ino': str(ino), 'kind': kind, 'allocatedBytes': str(blocks * 512),
                           'nlink': str(links), 'size': str(size), 'ctimeNs': str(ctime), 'mtimeNs': str(mtime),
                           'members': [{'cohortIndex': index, 'observedLinks': count} for index, count in sorted(value['members'].items())]}
        size = len(json.dumps(row, separators=(',', ':')).encode())
        if serialized_bytes + size > 1024 * 1024:
            omitted += 1; continue
        serialized_bytes += size; crosslinks.append(row)
    if omitted: budget.issue('AllocationOutput', Refusal('OutputLimit'))
    return {'partition': partition, 'partitions': 77, 'trees': results, 'crosslinks': crosslinks, 'crosslinksOmitted': omitted,
            'aggregation': 'SeparateIntervalsNoHistoricalSubstitution'}

def capacity(fd):
    v, s = os.fstatvfs(fd), os.fstat(fd)
    if v.f_frsize <= 0: raise Refusal('CapacityShape')
    return {'dev': str(s.st_dev), 'availableBytes': str(max(0, v.f_bavail * v.f_frsize)),
            'signedAvailableBytes': str(v.f_bavail * v.f_frsize), 'blockSize': str(v.f_frsize)}

def request_rows(request):
    if set(request) != {'version', 'mode', 'partition', 'cohortSha256', 'cohortJson'} or type(request['version']) is not int or request['version'] != 1:
        raise Refusal('RequestShape')
    if request['mode'] not in ('ProcReferences', 'AllocatedMetadata') or request['cohortSha256'] != COHORT_DIGEST:
        raise Refusal('RequestShape')
    partition = request['partition']
    if request['mode'] == 'ProcReferences' and partition is not None: raise Refusal('PartitionShape')
    if request['mode'] == 'AllocatedMetadata' and (type(partition) is not int or not 0 <= partition < 77): raise Refusal('PartitionShape')
    raw = request['cohortJson']
    if not isinstance(raw, str) or len(raw.encode()) > 256 * 1024 or hashlib.sha256(raw.encode()).hexdigest() != COHORT_DIGEST:
        raise Refusal('CohortDigestMismatch')
    cohort = json.loads(raw)
    if set(cohort) != {'version', 'machineId', 'target', 'historicalAllocationMeasuredAt', 'historicalTotalAllocatedBytes', 'cohort'}:
        raise Refusal('CohortShape')
    if cohort['version'] != 1 or cohort['machineId'] != MACHINE or cohort['target'] != TARGET: raise Refusal('CohortShape')
    rows = cohort['cohort']
    if not isinstance(rows, list) or len(rows) != 307: raise Refusal('CohortShape')
    seen = set()
    for index, row in enumerate(rows):
        if set(row) != {'index', 'name', 'workspace', 'dependencies', 'historicalDev', 'historicalIno', 'historicalAllocatedBytes'}:
            raise Refusal('CohortShape')
        if row['index'] != index or not isinstance(row['name'], str) or not NAME.fullmatch(row['name']): raise Refusal('CohortShape')
        if row['name'] in seen or row['workspace'] != TARGET + '/' + row['name'] or row['dependencies'] != row['workspace'] + '/node_modules':
            raise Refusal('CohortShape')
        seen.add(row['name'])
        if not all(isinstance(row[k], str) and len(row[k]) <= 32 and DECIMAL.fullmatch(row[k]) for k in ('historicalDev', 'historicalIno', 'historicalAllocatedBytes')):
            raise Refusal('CohortShape')
    return rows

def main(request):
    budget = Budget(35 if request.get('mode') == 'ProcReferences' else 40)
    mode = request.get('mode') if request.get('mode') in ('ProcReferences', 'AllocatedMetadata') else 'Unknown'
    report = {'schemaVersion': 1, 'mode': mode, 'startedAt': stamp(),
              'cohortSha256': COHORT_DIGEST,
              'necessaryBytes': 'Unknown', 'futureAdmissionCoverage': 'Unknown', 'cleanupEligibility': 'NotEstablished',
              'visibleProcCoverage': 'Incomplete' if mode == 'ProcReferences' else 'NotRequested',
              'allocation': None, 'proc': None, 'capacityBefore': None, 'capacityAfter': None,
              'limitations': ['SequentialWindowNotAbsenceProof', 'ExternalHardlinkAndSymlinkAliasesUncovered',
                              'DetachedUnobservedNamespacesUncovered', 'AnonymousKernelObjectsUncovered', 'HistoricalAllocationNotCurrent']}
    p, parent, items = None, None, []
    try:
        rows = request_rows(request); p = preflight(budget); parent = DirectoryChain(TARGET, budget)
        report['machineId'], report['bootId'] = p['machineId'], p['bootId']
        report['hostProcProvenance'] = 'ExistingOwnerRouteExpectedMachinePid1Consistent'
        items = capture_cohort(rows, parent, p['mounts'], budget)
        report['capacityBefore'] = capacity(parent.fd)
        if request['mode'] == 'ProcReferences': report['proc'] = proc_observation(p, items, budget)
        else: report['allocation'] = allocation_observation(items, request['partition'], budget)
    except Exception as error: budget.issue('Request', error)
    finally:
        final_binding = False
        if parent is not None:
            try: check_cohort(items, parent, budget)
            except Exception as error: budget.issue('FinalCohort', error)
        if p is not None:
            try:
                finish_preflight(p, budget); final_binding = True
            except Exception as error: budget.issue('FinalIdentity', error)
        if parent is not None:
            try:
                report['capacityAfter'] = capacity(parent.fd)
                if report['capacityBefore'] is None or report['capacityAfter']['dev'] != report['capacityBefore']['dev']:
                    final_binding = False; raise Refusal('CapacityDeviceDrift')
            except Exception as error: budget.issue('FinalCapacity', error)
        report['finalMachineBootNamespaceBindingVerified'] = final_binding
        states = {i['row']['index']: i['status'] for i in items}
        if report['proc'] is not None:
            for row in report['proc']['matches']: row['cohortFinalJoin'] = states.get(row['cohortIndex'], 'Unknown')
            report['visibleProcCoverage'] = 'Incomplete' if budget.incomplete else 'ObservedWindow'
        close_cohort(items, budget)
        if parent is not None: parent.close()
        if p is not None: close_preflight(p)
        report['finishedAt'], report['errors'] = stamp(), budget.errors
        report['errorRecordsOmitted'] = max(0, budget.error_total - len(budget.errors))
        report['coverageIssues'] = [{'reason': k, 'count': v} for k, v in sorted(budget.error_counts.items())]
        report['metadataBytesRead'], report['accountedBytes'], report['enumeratedEntries'] = str(budget.text_bytes), str(budget.bytes), str(budget.entries)
        report['mountBytesRead'], report['viewHeapPeakBytes'] = str(budget.mount_io), str(budget.view_heap_peak)
        report['status'] = 'Incomplete' if budget.incomplete else 'ObservedWindow'
        report['cohortRootObservations'] = [{'cohortIndex': i['row']['index'], 'status': i['status'],
                                            'dev': str(i['pin'][0]) if i['status'] == 'ObservedRoot' else None,
                                            'ino': str(i['pin'][1]) if i['status'] == 'ObservedRoot' else None} for i in items]
        report['cohortRootsUnobserved'] = 307 - len(items)
        report['bounds'] = {'seconds': 35 if mode == 'ProcReferences' else 40, 'identities': 4096,
                            'fdEntriesPerTask': 1024, 'fdEntriesTotal': 32768, 'textBytes': MAX_TEXT,
                            'mountTableBytes': MAX_MOUNT_TEXT, 'mountIoBytes': MAX_MOUNT_IO, 'viewHeapBytes': MAX_VIEW_HEAP, 'viewGroupFds': 768, 'mountCandidatePairs': 16384, 'aggregateBytes': MAX_BYTES, 'namespaceRootViews': 256, 'matches': 4096,
                            'allocationEntries': 262144, 'crosslinks': 16384, 'outputBytes': MAX_OUTPUT}
        if report['allocation'] is not None:
            complete = final_binding and not report['allocation']['crosslinksOmitted'] and all(row['status'] == 'ObservedMetadata' and states.get(row['cohortIndex']) == 'ObservedRoot'
                                             for row in report['allocation']['trees'])
            if not complete:
                for row in report['allocation']['trees']: row['status'] = 'Unknown'; row['measurement'] = None
            report['allocation']['crosslinksStatus'] = 'ObservedMetadata' if complete else 'Incomplete'
    encoded = json.dumps(report, separators=(',', ':'))
    if len(encoded.encode()) > MAX_OUTPUT:
        report['proc'], report['allocation'], report['status'], report['visibleProcCoverage'] = None, None, 'Incomplete', 'Incomplete'
        report['errors'] = [{'phase': 'Output', 'reason': 'OutputLimit'}]
        encoded = json.dumps(report, separators=(',', ':'))
    return encoded

if __name__ == '__main__':
    print(main(REQUEST))
