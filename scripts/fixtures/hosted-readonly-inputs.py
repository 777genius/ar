#!/usr/bin/env python3
"""Disposable evidence probe. Does not create jobs, grants, policies or services.

ROOT prepares a fresh fixture, enrolls/launches it through the production runtime,
then runs `probe ROOT` *inside the real provider command sandbox*. After service
termination, ROOT runs `verify ROOT PROBE_JSON` outside that namespace. A successful
probe is only input to the full lifecycle/isolation qualification, never approval.
"""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

OWN = "source-parent-v6-TEST"
ROOTS = [
    "input-contract", "runtime/node", f"{OWN}/README.md",
    f"{OWN}/cache/v8-positive-TEST/corepack/v1/pnpm/11.18.0",
    f"{OWN}/cases.json", f"{OWN}/inputs/v8-positive-TEST",
    *[f"{OWN}/{name}" for name in ("instrumented-case.mjs", "lifecycle.mjs",
       "observe-exec.mjs", "run-case.py", "successor-binding.json", "successor-binding.mjs")],
    f"{OWN}/tool-shims-v8-TEST", "tools/published-cli",
]
DIRECTORIES = {ROOTS[i] for i in (0, 1, 3, 5, 12, 13)}
WRITABLE = [f"{OWN}/consumer", f"{OWN}/store", f"{OWN}/metadata", f"{OWN}/index",
            f"{OWN}/proof", f"{OWN}/evidence", f"{OWN}/dispatch", "home", "tmp"]
DENIALS = {errno.EROFS, errno.EPERM, errno.EACCES, errno.EBUSY}


def snapshot(path):
    info = path.lstat()
    result = {"dev": info.st_dev, "ino": info.st_ino, "mode": info.st_mode}
    # Writable ancestor contents may legitimately add/remove subdirectories.
    # Their directory link count is not an immutable input identity.
    if not stat.S_ISDIR(info.st_mode):
        result["nlink"] = info.st_nlink
    if stat.S_ISREG(info.st_mode):
        result["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    elif stat.S_ISLNK(info.st_mode):
        result["target"] = os.readlink(path)
    return result


def anchors(workspace):
    found = set()
    for name in ROOTS:
        parent = (workspace / name).parent
        while True:
            found.add(parent)
            if parent == workspace:
                break
            parent = parent.parent
    return sorted(found)


def prepare(root):
    # Refuse reuse: a previous partially tested tree is never fresh evidence.
    root.mkdir(mode=0o700)
    workspace = root / "workspace"
    workspace.mkdir()
    for name in ROOTS:
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in DIRECTORIES:
            path.mkdir()
            path = path / "member.txt"
        path.write_text("sealed fixture member: " + name + "\n")
    published = workspace / "tools/published-cli"
    (published / "corepack.cjs").write_text("// synthetic reviewed Corepack target\n")
    shim = workspace / OWN / "tool-shims-v8-TEST/pnpm"
    shim.symlink_to("../../tools/published-cli/corepack.cjs")
    for name in WRITABLE:
        (workspace / name).mkdir(parents=True, exist_ok=True)
    protected = set(anchors(workspace))
    for name in ROOTS:
        path = workspace / name
        protected.add(path)
        if path.is_dir():
            protected.update(path.rglob("*"))
    consumer = workspace / WRITABLE[0]
    manifest = {"schemaVersion": 1, "fixtureRoot": str(root), "workspacePath": str(workspace),
                "readonlyPaths": [str(workspace / name) for name in ROOTS],
                "anchors": [str(path) for path in anchors(workspace)],
                "protected": {str(path): snapshot(path) for path in sorted(protected)},
                "consumer": {"path": str(consumer), **snapshot(consumer)},
                "reviewedSymlink": {"path": str(shim), "target": os.readlink(shim)},
                "admission": "NOT_ENROLLED", "liveAcceptance": False}
    (root / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (root / "fixture.json").chmod(0o600)
    return manifest


def mount_entries():
    entries = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split()
        separator = fields.index("-")
        path = fields[4]
        for escaped, value in ((r"\040", " "), (r"\011", "\t"), (r"\012", "\n"), (r"\134", "\\")):
            path = path.replace(escaped, value)
        entries.append({"path": path, "options": fields[5].split(","),
                        "id": fields[0], "parent": fields[1], "device": fields[2],
                        "root": fields[3], "filesystem": fields[separator + 1]})
    return entries



def readonly_mount_observation(path, entries):
    applicable = [item for item in entries if path == item["path"] or
                  path.startswith(item["path"].rstrip("/") + "/")]
    if not applicable:
        return False, []
    deepest = max(len(item["path"]) for item in applicable)
    effective = [item for item in applicable if len(item["path"]) == deepest]
    descendants = [item for item in entries if item["path"].startswith(path + "/")]
    # mountinfo order cannot disambiguate stacked mounts. Reject any ambiguous
    # pathname below the root as well as at the effective root itself.
    unique = len({item["path"] for item in descendants}) == len(descendants)
    return (len(effective) == 1 and "ro" in effective[0]["options"] and unique and
            all("ro" in item["options"] for item in descendants)), effective


def inherited_input_descriptors(manifest):
    """Inspect descriptor metadata only; never read descriptor contents/targets.

    Even readonly/O_PATH file handles can retain an original writable mount
    view through procfs reopening; directory handles can do so through openat.
    Reject all input/scaffold handles since their capture point is not proven.
    This covers this command's inherited handles, not other processes' custody.
    """
    identities = {(info["dev"], info["ino"]): path for path, info in manifest["protected"].items()}
    unsafe = []
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        try:
            info = os.fstat(fd)
            flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        except OSError as exc:
            if exc.errno == errno.EBADF:  # The enumeration directory has closed.
                continue
            raise
        path = identities.get((info.st_dev, info.st_ino))
        if path is not None:
            unsafe.append({"fd": fd, "path": path, "flags": flags})
    return {"operation": "inherited-input-descriptors", "path": manifest["workspacePath"],
            "passed": not unsafe, "unsafe": unsafe}


def writable_sibling_lifecycle(workspace, unchanged):
    sibling = workspace / OWN / "fixture-lifecycle-a"
    renamed = workspace / OWN / "fixture-lifecycle-b"
    try:
        sibling.mkdir()
        (sibling / "member").write_text("lifecycle write\n")
        sibling.rename(renamed)
        passed = (renamed / "member").read_text() == "lifecycle write\n" and unchanged()
    except OSError:
        passed = False
    finally:
        for path in (sibling, renamed):
            if path.exists():
                (path / "member").unlink(missing_ok=True)
                path.rmdir()
    return {"operation": "writable-sibling-rename", "path": str(workspace / OWN), "passed": passed}


def namespace_attempt(root, index, operation):
    """Child-only mutation attempt. Never change the calling provider namespace."""
    if operation not in ("remount", "bind") or type(index) is not int or not 0 <= index < len(ROOTS):
        raise ValueError("invalid namespace fixture operation")
    manifest = json.loads((root / "fixture.json").read_text())
    if manifest["fixtureRoot"] != str(root) or manifest["workspacePath"] != str(root / "workspace"):
        raise ValueError("fixture identity mismatch")
    libc = ctypes.CDLL(None, use_errno=True)
    # A fresh user namespace plus a fresh mount namespace. No host mount changes
    # and no command/config supplied by the fixture manifest.
    if libc.unshare(0x10000000 | 0x00020000) != 0:  # CLONE_NEWUSER | CLONE_NEWNS
        error = ctypes.get_errno()
        return {"entered": False, "namespaceErrno": error, "mountErrno": None,
                "writeErrno": None, "passed": error in (errno.EPERM, errno.EACCES)}
    target = root / "workspace" / ROOTS[index]
    # MS_BIND | MS_REMOUNT clears the per-mount readonly bit; MS_BIND attempts
    # to introduce a new alias/view at the same protected pathname.
    flags = 4096 | 32 if operation == "remount" else 4096
    result = libc.mount(os.fsencode(target), os.fsencode(target), None, flags, None)
    mount_error = ctypes.get_errno() if result != 0 else None
    member = target / "member.txt" if ROOTS[index] in DIRECTORIES else target
    write_error = None
    try:
        append(member)
    except OSError as exc:
        write_error = exc.errno
    return {"entered": True, "namespaceErrno": None, "mountErrno": mount_error,
            "writeErrno": write_error, "passed": write_error in DENIALS}


def namespace_denied(observation):
    if (not isinstance(observation, dict) or
            set(observation) != {"entered", "namespaceErrno", "mountErrno", "writeErrno", "passed"} or
            type(observation["entered"]) is not bool or observation["passed"] is not True or
            any(value is not None and type(value) is not int for key, value in observation.items()
                if key.endswith("Errno"))):
        return False
    if observation["entered"]:
        return observation["namespaceErrno"] is None and observation["writeErrno"] in DENIALS
    return (observation["namespaceErrno"] in (errno.EPERM, errno.EACCES) and
            observation["mountErrno"] is None and observation["writeErrno"] is None)


def namespace_checks(root, unchanged):
    results = []
    for index, name in enumerate(ROOTS):
        for operation in ("remount", "bind"):
            observation = None
            failure = None
            child_exit_code = None
            try:
                child = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                        "namespace-attempt", str(root), str(index), operation],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, close_fds=True, timeout=10,
                                       check=False)
                child_exit_code = child.returncode
                observation = json.loads(child.stdout) if child.returncode == 0 else None
                if child.returncode != 0:
                    failure = "child-exit"
                passed = namespace_denied(observation) and unchanged()
            except subprocess.TimeoutExpired:
                passed = False
                failure = "child-timeout"
            except OSError:
                passed = False
                failure = "child-unavailable"
            except ValueError:
                passed = False
                failure = "invalid-child-json"
            results.append({"operation": "user-namespace-" + operation,
                            "path": str(root / "workspace" / name), "passed": bool(passed),
                            "observation": observation, "childExitCode": child_exit_code,
                            "failure": failure})
    return results


def probe(root):
    manifest = json.loads((root / "fixture.json").read_text())
    workspace = root / "workspace"
    if manifest["workspacePath"] != str(workspace) or manifest["fixtureRoot"] != str(root):
        raise ValueError("fixture identity mismatch")
    # Capture before mutation attempts can unlink and replace a fixture inode.
    results = [inherited_input_descriptors(manifest)]
    libc = ctypes.CDLL(None, use_errno=True)

    def unchanged():
        try:
            return all(snapshot(Path(path)) == expected for path, expected in manifest["protected"].items())
        except OSError:
            return False

    def deny(label, target, operation, restore):
        error = None
        try:
            operation()
        except OSError as exc:
            error = exc.errno
        finally:
            # Synthetic fixture only: retain failure evidence but restore when a
            # missing boundary permitted mutation, allowing independent attempts.
            restore()
        results.append({"operation": label, "path": str(target), "errno": error,
                        "passed": error in DENIALS and unchanged()})

    for name in ROOTS:
        target = workspace / name
        member = target / "member.txt" if name in DIRECTORIES else target
        baseline = member.read_bytes()
        mode = stat.S_IMODE(member.stat().st_mode)

        def restore_member():
            try:
                if member.read_bytes() == baseline and stat.S_IMODE(member.stat().st_mode) == mode:
                    return
            except OSError:
                pass
            member.write_bytes(baseline)
            member.chmod(mode)

        def chmod_write():
            member.chmod(mode | 0o200)
            member.write_bytes(b"changed")

        for label, action in (
            ("write", lambda: member.write_bytes(b"changed")),
            ("append", lambda: append(member)),
            ("truncate", lambda: os.truncate(member, 0)),
            ("chmod-then-write", chmod_write),
            ("unlink", lambda: member.unlink()),
        ):
            deny(label, member, action, restore_member)
        replacement = workspace / ("replacement-" + hashlib.sha256(name.encode()).hexdigest())
        replacement.write_bytes(b"replacement")
        deny("overwrite-rename", member, lambda: os.replace(replacement, member), restore_member)
        replacement.unlink(missing_ok=True)

    for target in [*(workspace / name for name in ROOTS), *anchors(workspace)]:
        moved = target.with_name(target.name + ".fixture-moved")

        def rename_recreate():
            target.rename(moved)
            if moved.is_dir():
                target.mkdir()
            else:
                target.write_text("replacement")

        def restore_name():
            if moved.exists():
                if target.is_dir():
                    target.rmdir()
                elif target.exists():
                    target.unlink()
                moved.rename(target)

        deny("rename-recreate", target, rename_recreate, restore_name)
        exchanged = target.with_name(target.name + ".fixture-exchange")
        if target.is_dir():
            exchanged.mkdir()
        else:
            exchanged.write_bytes(b"exchange")
        swapped = False

        def exchange():
            nonlocal swapped
            if libc.renameat2(-100, os.fsencode(target), -100, os.fsencode(exchanged), 2) != 0:
                raise OSError(ctypes.get_errno(), "renameat2")
            swapped = not swapped

        deny("rename-exchange", target, exchange, lambda: exchange() if swapped else None)
        if exchanged.is_dir():
            exchanged.rmdir()
        else:
            exchanged.unlink()

    for name in WRITABLE:
        path = workspace / name / "writable.txt"
        try:
            path.write_text("writable\n")
            passed = path.read_text() == "writable\n"
        except OSError:
            passed = False
        results.append({"operation": "writable", "path": str(path), "passed": passed})
    results.append(writable_sibling_lifecycle(workspace, unchanged))
    results.extend(namespace_checks(root, unchanged))
    entries = mount_entries()
    for name in ROOTS:
        path = str(workspace / name)
        passed, effective = readonly_mount_observation(path, entries)
        results.append({"operation": "mount-readonly", "path": path,
                        "passed": passed, "mounts": effective})
    for path in anchors(workspace):
        exact = [item for item in entries if item["path"] == str(path)]
        results.append({"operation": "ancestor-mount", "path": str(path),
                        "passed": len(exact) == 1 and "rw" in exact[0]["options"]})
    return {"schemaVersion": 1, "fixtureRoot": str(root), "results": results,
            "protectedUnchanged": unchanged(), "uidMap": Path("/proc/self/uid_map").read_text(),
            "namespaces": {name: os.readlink("/proc/self/ns/" + name) for name in ("user", "mnt", "pid")},
            "mountinfo": Path("/proc/self/mountinfo").read_text(),
            "liveAcceptance": False, "requires": "ROOT service/provider identity and lifecycle/custody qualification"}


def append(path):
    with path.open("ab") as file:
        file.write(b"changed")


def verify(root, report):
    manifest = json.loads((root / "fixture.json").read_text())
    evidence = json.loads(report.read_text())
    expected = manifest["protected"]
    unchanged = all(snapshot(Path(path)) == info for path, info in expected.items())
    consumer = dict(manifest["consumer"])
    consumer_path = consumer.pop("path")
    workspace = root / "workspace"
    operations = [(operation, str(workspace / name / "member.txt" if name in DIRECTORIES else workspace / name))
                  for name in ROOTS for operation in ("write", "append", "truncate", "chmod-then-write", "unlink", "overwrite-rename")]
    operations += [(operation, str(path)) for path in [*(workspace / name for name in ROOTS), *anchors(workspace)]
                   for operation in ("rename-recreate", "rename-exchange")]
    operations += [("writable", str(workspace / name / "writable.txt")) for name in WRITABLE]
    operations += [("mount-readonly", str(workspace / name)) for name in ROOTS]
    operations += [("ancestor-mount", str(path)) for path in anchors(workspace)]
    operations += [("inherited-input-descriptors", str(workspace))]
    operations += [("writable-sibling-rename", str(workspace / OWN))]
    operations += [("user-namespace-" + operation, str(workspace / name))
                   for name in ROOTS for operation in ("remount", "bind")]
    actual = [(row.get("operation"), row.get("path")) for row in evidence.get("results", [])]
    complete = (sorted(actual) == sorted(operations) and evidence.get("protectedUnchanged") is True and
                all(namespace_denied(row.get("observation")) for row in evidence.get("results", [])
                    if row.get("operation", "").startswith("user-namespace-")))
    # A fixture command can never certify service custody or its own provenance.
    passed = complete and evidence.get("fixtureRoot") == str(root) and unchanged and bool(evidence.get("results")) and \
        all(item.get("passed") is True for item in evidence["results"]) and \
        snapshot(Path(consumer_path)) == consumer
    return {"probeChecksPassed": passed, "protectedUnchanged": unchanged,
            "liveAcceptance": False, "remaining": "verify actual service/provider provenance, isolation, aliases, descendants and custody"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "probe", "verify", "namespace-attempt"])
    parser.add_argument("root", type=Path)
    parser.add_argument("report", type=Path, nargs="?")
    parser.add_argument("namespace_operation", choices=["remount", "bind"], nargs="?")
    args = parser.parse_args()
    if not args.root.is_absolute() or args.root.resolve() != args.root or str(args.root) == "/":
        parser.error("root must be a canonical absolute disposable path")
    if args.operation == "namespace-attempt":
        if args.report is None or args.namespace_operation is None:
            parser.error("namespace attempt requires root index and operation")
        print(json.dumps(namespace_attempt(args.root, int(str(args.report)), args.namespace_operation)))
        return 0
    result = prepare(args.root) if args.operation == "prepare" else \
        probe(args.root) if args.operation == "probe" else verify(args.root, args.report)
    print(json.dumps(result, indent=2))
    if args.operation == "probe" and (not result["protectedUnchanged"] or
                                      not all(row["passed"] for row in result["results"])):
        return 1
    if args.operation == "verify" and not result["probeChecksPassed"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
