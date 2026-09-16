#!/usr/bin/env python3
"""Later ROOT qualification: hold a writable synthetic input in a separate unit.

Run in a dedicated subscription-runtime-qualification-sibling-UUID.service,
excluded from the trusted finite inventory. Never enroll this unit. Readiness is
only a witness that this process holds the descriptor, not admission authority.
"""
import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import threading

spec = importlib.util.spec_from_file_location("readonly_launcher", Path(__file__).with_name("hosted-readonly-launch.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def private_alias(root, source):
    consumer = root / "workspace" / launcher.probe.WRITABLE[0]
    if not stat.S_ISDIR(consumer.lstat().st_mode):
        raise ValueError("fixed alternate-mount consumer required")
    target = consumer / "readonly-negative-mount"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    before = os.readlink("/proc/self/ns/mnt")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(0x00020000) != 0:  # CLONE_NEWNS
        raise ValueError("qualification mount namespace unavailable")
    if os.readlink("/proc/self/ns/mnt") == before:
        raise ValueError("qualification mount namespace unchanged")
    # Remove propagation before any bind. A failure leaves no bind and ends the
    # process; private namespace mounts disappear with its final descendant.
    if libc.mount(None, b"/", None, 0x4000 | 0x40000, None) != 0:  # MS_REC | MS_PRIVATE
        raise ValueError("qualification mount propagation unavailable")
    if libc.mount(os.fsencode(source), os.fsencode(target), None, 0x1000, None) != 0:  # MS_BIND
        raise ValueError("qualification alternate bind unavailable")
    original, alias = source.stat(), target.stat()
    if (original.st_dev, original.st_ino) != (alias.st_dev, alias.st_ino):
        raise ValueError("qualification alternate bind identity mismatch")
    return target


def hold(root, alternate_mount=False):
    launcher.host_operator()
    if not root.is_absolute() or root.resolve() != root or root == Path("/"):
        raise ValueError("canonical disposable fixture required")
    manifest = launcher.private_json(root / "fixture.json")
    if manifest["fixtureRoot"] != str(root) or manifest["workspacePath"] != str(root / "workspace"):
        raise ValueError("disposable identity mismatch")
    launcher.validate_fixture_paths(root, manifest)
    group = Path("/proc/self/cgroup").read_text().strip()
    pattern = r"0::/(?:[A-Za-z0-9_.@+-]+/)*subscription-runtime-qualification-sibling-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service"
    if not re.fullmatch(pattern, group):
        raise ValueError("separate qualification sibling unit required")
    source = root / "workspace" / launcher.probe.ROOTS[2]
    baseline = manifest["protected"][str(source)]
    if launcher.probe.snapshot(source) != baseline:
        raise ValueError("synthetic sibling input changed")
    stopped = threading.Event()
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    previous = {number: signal.getsignal(number) for number in signals}
    opened = private_alias(root, source) if alternate_mount else source
    fd = os.open(opened, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_dev, info.st_ino) != (baseline["dev"], baseline["ino"]):
            raise ValueError("synthetic sibling descriptor mismatch")
        for number in signals:
            signal.signal(number, lambda _number, _frame: stopped.set())
        with (root / "sibling-evidence.jsonl").open("x", encoding="utf8") as output:
            os.fchmod(output.fileno(), 0o600)
            witness = {"state": "writable-descriptor-held", "pid": os.getpid(), "cgroup": group,
                       "dev": info.st_dev, "ino": info.st_ino, "alternateMount": alternate_mount,
                       "mountNamespace": os.readlink("/proc/self/ns/mnt"), "liveAcceptance": False}
            output.write(json.dumps(witness) + "\n"); output.flush(); os.fsync(output.fileno())
            # A bounded hold permits ROOT to exercise production admission while
            # the unreviewed sibling has concrete write capability. No input write.
            stopped.wait(300)
            output.write(json.dumps({"state": "hold-ended", "liveAcceptance": False}) + "\n")
            output.flush(); os.fsync(output.fileno())
    finally:
        os.close(fd)
        for number, handler in previous.items():
            signal.signal(number, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--alternate-mount", action="store_true", help="hold a writable bind alias in this sibling's new private mount namespace")
    args = parser.parse_args()
    try:
        hold(args.root, args.alternate_mount)
    except (OSError, ValueError, KeyError, TypeError):
        print("readonly_sibling_qualification_incomplete")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
