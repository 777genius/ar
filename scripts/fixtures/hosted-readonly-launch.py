#!/usr/bin/env python3
"""ROOT-only disposable qualification launcher; never enrolls or grants authority.

Run only later on the authorized dedicated TEST host, after ROOT has created,
reviewed, granted, enrolled and recovered a synthetic job configured to execute
hosted-readonly-inputs.py probe ROOT through the actual provider command sandbox.
The provider task must save its probe JSON to workspace/probe.json. This launcher
calls the existing production host entrypoint using the independently installed
exact inventory command. It does not synthesize systemd properties or authority.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
from pathlib import Path
import stat
import signal
import threading
import subprocess
import sys

AUTHORITY = Path("/var/lib/subscription-runtime-host-policy")
POLICIES = Path("/run/user/0/subscription-runtime-host-policy/codex-readonly")
spec = importlib.util.spec_from_file_location("readonly_probe", Path(__file__).with_name("hosted-readonly-inputs.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def private_json(path, *, with_digest=False):
    for directory in [path.parent, *path.parent.parents]:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("qualification authority ancestry invalid")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or
                before.st_mode & 0o077 or not 0 < before.st_size <= 65536):
            raise ValueError("qualification authority file invalid")
        data = os.read(fd, 65537)
        after = os.fstat(fd)
        if len(data) != before.st_size or (before.st_size, before.st_ctime_ns) != (after.st_size, after.st_ctime_ns):
            raise ValueError("qualification authority changed")
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate qualification authority field")
                value[key] = item
            return value
        value = json.loads(data, object_pairs_hook=unique)
        return (value, hashlib.sha256(data).hexdigest()) if with_digest else value
    finally:
        os.close(fd)


def activation_binding(runtime, epoch):
    """Fixture preflight only; production admission remains the authority."""
    for name in ("host-activation.next", "ordinary-origins.next", "readonly-epoch.next"):
        try:
            (AUTHORITY / name).lstat()
        except FileNotFoundError:
            continue
        raise ValueError("qualification activation recovery required")
    installation, installation_sha = private_json(AUTHORITY / "host-installation.json", with_digest=True)
    activation, activation_sha = private_json(AUTHORITY / "host-activation.json", with_digest=True)
    enrollment, enrollment_sha = private_json(AUTHORITY / "readonly-enrollment.json", with_digest=True)
    stage_path = (POLICIES.parent / "codex-readonly-stages" /
                  (hashlib.sha256(str(runtime).encode()).hexdigest() + ".json"))
    stage, stage_sha = private_json(stage_path, with_digest=True)
    inventory, inventory_sha = private_json(AUTHORITY / "readonly-inventory.json", with_digest=True)
    if (set(stage) != {"schemaVersion", "runtimeDirectory", "runtimeSha", "runtimeManifestSha256"} or
            stage["schemaVersion"] != 1 or inventory["schemaVersion"] != 2 or
            inventory["hostId"] != installation["hostId"] or
            inventory_sha != installation["inventorySha256"] or
            any(stage[key] != installation[key] for key in
                ("runtimeDirectory", "runtimeSha", "runtimeManifestSha256"))):
        raise ValueError("qualification stage or inventory binding mismatch")
    if (installation["schemaVersion"] != 1 or activation["schemaVersion"] != 1 or
            activation["phase"] != "EXCLUSIVE" or
            activation["installationId"] != installation["installationId"] or
            activation["exclusiveEnrollmentSha256"] != enrollment_sha or
            installation["runtimeDirectory"] != str(runtime) or
            installation["hostId"] != epoch["hostId"] or
            any(activation[key] != epoch[key] for key in ("hostId", "bootId", "supervisorId")) or
            any(installation[key] != epoch["identity"][key] for key in ("runtimeSha", "runtimeManifestSha256")) or
            enrollment["identity"] != epoch["identity"] or
            enrollment["generation"] != 1 or enrollment["phase"] != "closed" or enrollment["revoked"] is not False or
            enrollment["reservations"] or enrollment["outerRuntime"] is not None or
            any(row["state"] != "terminal" for row in activation["ordinaryStarts"])):
        raise ValueError("genuine exclusive disposable installation required")
    return {"installationSha256": installation_sha, "activationSha256": activation_sha,
            "enrollmentSha256": enrollment_sha, "activationGeneration": activation["generation"],
            "stageSha256": stage_sha, "inventorySha256": inventory_sha}


def host_operator():
    if sys.platform != "linux" or os.getuid() != 0 or os.getgid() != 0:
        raise ValueError("qualification requires initial host root")
    for kind in ("uid", "gid"):
        if Path(f"/proc/self/{kind}_map").read_text().split() != ["0", "0", "4294967295"]:
            raise ValueError("qualification requires initial host identity")
    for kind in ("user", "mnt", "pid"):
        if os.readlink(f"/proc/self/ns/{kind}") != os.readlink(f"/proc/1/ns/{kind}"):
            raise ValueError("qualification requires initial host namespaces")


def run_reviewed(command, cwd, timeout=300, cancel_after=None, inherited_fds=()):
    if (not math.isfinite(timeout) or not 0 < timeout <= 3600 or
            (cancel_after is not None and
             (not math.isfinite(cancel_after) or not 0 < cancel_after < timeout))):
        raise ValueError("bounded qualification timing required")
    # Hosted admission requires pipe stdio; DEVNULL is intentionally rejected
    # by production. Drain concurrently with bounded buffers, retaining only
    # hashes/counts, never potentially sensitive provider output or credentials.
    child = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, close_fds=True, pass_fds=inherited_fds)
    child.stdin.close()
    summaries = [{}, {}]
    def drain(stream, record):
        digest, count = hashlib.sha256(), 0
        try:
            with stream:
                while chunk := stream.read(65536):
                    digest.update(chunk); count += len(chunk)
            record.update(sha256=digest.hexdigest(), bytes=count)
        except OSError:
            record.update(error="output-observation-failed")
    threads = [threading.Thread(target=drain, args=(stream, record), daemon=True)
               for stream, record in zip((child.stdout, child.stderr), summaries)]
    for thread in threads:
        thread.start()
    forwarded = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    previous = {number: signal.getsignal(number) for number in forwarded}
    cancellation = []
    def cancel(number, _frame):
        cancellation.append(number)
        try:
            child.send_signal(number)
        except ProcessLookupError:
            pass
    timed_out, proxy_killed, status = False, False, None
    try:
        for number in forwarded:
            signal.signal(number, cancel)
        try:
            status = child.wait(timeout=cancel_after if cancel_after is not None else timeout)
        except subprocess.TimeoutExpired:
            # Exercise production cancellation; this is never terminal proof.
            timed_out = cancel_after is None
            cancel(signal.SIGTERM, None)
            try:
                status = child.wait(timeout=timeout - cancel_after if cancel_after is not None else 10)
            except subprocess.TimeoutExpired:
                timed_out = True
                proxy_killed = True
                child.kill()
                try:
                    status = child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        for thread, record in zip(threads, summaries):
            thread.join(timeout=1)
            if thread.is_alive():
                # A descendant retaining pipe FDs must not hang the driver or
                # disappear from evidence. Do not close a reader from this thread.
                record.update(error="output-pipe-still-open")
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    return {"exitCode": status, "stdout": dict(summaries[0]), "stderr": dict(summaries[1]),
            "timedOut": timed_out, "cancellationRequested": bool(cancellation),
            "proxyKillRequested": proxy_killed, "terminalCustodyProven": False}


def validate_fixture_paths(root, manifest):
    workspace = root / "workspace"
    expected = [str(workspace / name) for name in probe.ROOTS]
    if (manifest["readonlyPaths"] != expected or
            manifest["anchors"] != [str(path) for path in probe.anchors(workspace)] or
            manifest["consumer"]["path"] != str(workspace / probe.WRITABLE[0])):
        raise ValueError("fixed disposable fixture projection required")
    for name in manifest["protected"]:
        path = Path(name)
        if not path.is_relative_to(workspace) or str(path) != name or ".." in path.parts:
            raise ValueError("protected path outside disposable fixture")
        # Never snapshot through a replaced ancestor into unrelated host inputs.
        for parent in [path.parent, *path.parent.parents]:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError("disposable fixture ancestor replaced")


def withhold_source(root, index):
    if index is None:
        return None
    if type(index) is not int or not 0 <= index < len(probe.ROOTS):
        raise ValueError("fixed missing source index required")
    source = root / "workspace" / probe.ROOTS[index]
    # Preserve the original until ROOT independently proves all queued starts
    # and descendants terminal. Restoring on proxy exit could race a late start.
    holding = root / "missing-source-held"
    holding.mkdir(mode=0o700)
    saved = holding / "source"
    source.rename(saved)
    for directory in (source.parent, holding, root):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return saved


def observe_terminal_units(initial):
    """Read-only ROOT observation; never reconciles epochs or invents receipts."""
    current = private_json(AUTHORITY / "readonly-epoch.json")
    if (current["identity"] != initial["identity"] or
            any(current[key] != initial[key] for key in ("hostId", "bootId", "supervisorId", "generation"))):
        raise ValueError("qualification enrollment or launch generation changed")
    records = [*current["reservations"]]
    if current["outerRuntime"] is not None:
        records.append(current["outerRuntime"])
    if len(records) > 1024:
        raise ValueError("qualification reservation bound exceeded")
    unit_pattern = r"subscription-runtime-(?:hosted|outer)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service"
    units = [record["unit"] for record in records]
    if len(set(units)) != len(units) or any(not re.fullmatch(unit_pattern, name) for name in units):
        raise ValueError("qualification reservation identity invalid")
    def systemctl(args):
        result = subprocess.run(["/usr/bin/systemctl", *args], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=10, check=False)
        if len(result.stdout) > 65536:
            raise ValueError("qualification observation oversized")
        return result.returncode, result.stdout.decode("utf8", errors="strict")
    status, jobs = systemctl(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"])
    if status != 0:
        raise ValueError("qualification manager unavailable")
    queued = set()
    for line in jobs.splitlines():
        fields = line.split()
        if len(fields) < 4 or not fields[0].isdigit():
            raise ValueError("qualification queue observation invalid")
        queued.add(fields[1])
    observed = []
    for name in units:
        status, output = systemctl(["show", "--property=Id,LoadState,MainPID,ControlGroup,ActiveState", "--", name])
        values = {}
        for line in output.splitlines():
            key, separator, value = line.partition("=")
            if not separator or key in values:
                raise ValueError("qualification unit observation invalid")
            values[key] = value
        absent = status in (0, 4) and values.get("LoadState") == "not-found"
        if absent and (values.get("MainPID", "0") != "0" or values.get("ControlGroup", "") != "" or
                       values.get("Id", name) != name):
            raise ValueError("qualification absent unit contradictory")
        group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + name
        if not absent and (status != 0 or values.get("Id") != name or
                           values.get("ControlGroup") not in ("", group) or
                           not values.get("MainPID", "").isdigit()):
            raise ValueError("qualification unit observation ambiguous")
        try:
            events = Path("/sys/fs/cgroup" + group + "/cgroup.events").read_text()
            rows = [line for line in events.splitlines() if line.startswith("populated ")]
            if rows not in (["populated 0"], ["populated 1"]):
                raise ValueError("qualification descendant observation invalid")
            empty = rows == ["populated 0"]
        except FileNotFoundError:
            empty = True
        observed.append({"unit": name, "managerAbsent": absent, "queued": name in queued,
                         "descendantsEmpty": empty,
                         "observedTerminal": name not in queued and empty and (absent or values["MainPID"] == "0")})
    return {"generation": current["generation"], "phase": current["phase"], "units": observed,
            "terminalCustodyProven": False,
            "limitation": "Point-in-time manager/cgroup observations do not fence creators or queued future submissions"}


def create_writable_alias(root):
    source = root / "workspace" / probe.ROOTS[2]
    consumer = root / "workspace" / probe.WRITABLE[0]
    if not stat.S_ISDIR(consumer.lstat().st_mode) or not stat.S_ISREG(source.lstat().st_mode):
        raise ValueError("fixed alias fixture layout required")
    alias = consumer / "readonly-negative-alias"
    # No replacement or cleanup: retain this additional writable name until
    # ROOT proves no delayed process can still use it. Production must reject it.
    os.link(source, alias, follow_symlinks=False)
    fd = os.open(consumer, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return alias


def frozen_slice_command(operation):
    result = subprocess.run(["/usr/bin/systemctl", operation, "subscription-runtime-hosted.slice"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=10, check=False)
    if result.returncode != 0:
        raise ValueError("qualification slice operation incomplete")


def freeze_empty_hosted_slice(epoch):
    group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice"
    if (epoch["outerRuntime"] is not None and epoch["outerRuntime"]["state"] != "terminal") or any(
            row["state"] != "terminal" for row in epoch["reservations"]):
        raise ValueError("qualification cannot freeze outstanding custody")
    caller = Path("/proc/self/cgroup").read_text().strip()
    if caller == "0::" + group or caller.startswith("0::" + group + "/"):
        raise ValueError("qualification driver must remain outside frozen slice")
    events = Path("/sys/fs/cgroup" + group + "/cgroup.events").read_text().splitlines()
    if ([line for line in events if line.startswith("populated ")] != ["populated 0"] or
            [line for line in events if line.startswith("frozen ")] != ["frozen 0"]):
        raise ValueError("qualification requires existing empty unfrozen slice")
    frozen_slice_command("freeze")
    events = Path("/sys/fs/cgroup" + group + "/cgroup.events").read_text().splitlines()
    if [line for line in events if line.startswith("frozen ")] != ["frozen 1"]:
        raise ValueError("qualification slice freezing unconfirmed; ROOT reconciliation required")


def thaw_closed_hosted_slice(initial):
    current = private_json(AUTHORITY / "readonly-epoch.json")
    if (current["identity"] != initial["identity"] or
            any(current[key] != initial[key] for key in ("hostId", "bootId", "supervisorId", "generation")) or
            current["phase"] != "closed"):
        raise ValueError("qualification slice retained frozen; ROOT must close and reconcile custody")
    # CLOSED must be durable before frozen bootstrap processes can run again.
    # Thaw is not terminal proof; existing reservations and observations remain.
    frozen_slice_command("thaw")


def launch(root, runtime, timeout=300, cancel_after=None, missing_source=None, retain_input_fd=False, writable_alias=False, freeze_slice=False):
    host_operator()
    if sum((retain_input_fd, writable_alias, freeze_slice, missing_source is not None)) > 1:
        raise ValueError("use a fresh fixture for each negative case")
    if freeze_slice and (cancel_after is None or not 0 < cancel_after < timeout <= 3600):
        raise ValueError("delayed start requires bounded scheduled cancellation")
    for path in (root, runtime):
        if not path.is_absolute() or path.resolve() != path or path == Path("/"):
            raise ValueError("canonical disposable fixture and reviewed runtime required")
    manifest = private_json(root / "fixture.json")
    workspace = root / "workspace"
    if manifest["fixtureRoot"] != str(root) or manifest["workspacePath"] != str(workspace):
        raise ValueError("disposable fixture identity mismatch")
    validate_fixture_paths(root, manifest)
    if missing_source is not None and (type(missing_source) is not int or not 0 <= missing_source < len(probe.ROOTS)):
        raise ValueError("fixed missing source index required")
    epoch = private_json(AUTHORITY / "readonly-epoch.json")
    identity = epoch["identity"]
    if (epoch["phase"] != "ready" or epoch["revoked"] is not False or
            identity["workspacePath"] != str(workspace) or
            not identity["jobRootDir"].startswith(str(root) + "/") or
            epoch["requirement"] != "test_managed_qualification"):
        raise ValueError("genuine ready disposable enrollment required")
    activation = activation_binding(runtime, epoch)
    policy = private_json(POLICIES / (hashlib.sha256(identity["jobId"].encode()).hexdigest() + ".json"))
    if (policy["readonlyPaths"] != manifest["readonlyPaths"] or
            any(policy[key] != identity[key] for key in ("jobId", "jobRootDir", "workspacePath", "runtimeSha",
                                                        "runtimeManifestSha256", "issuerDeploymentDigest"))):
        raise ValueError("disposable policy projection mismatch")
    inventory, inventory_sha = private_json(AUTHORITY / "readonly-inventory.json", with_digest=True)
    if inventory_sha != activation["inventorySha256"]:
        raise ValueError("qualification inventory changed before command selection")
    command = inventory["runtimeLaunch"]
    # Production admission revalidates the entire inventory, review, stage and
    # grant. These checks only prevent the test driver selecting another fixture.
    if (set(command) != {"command", "args", "cwd"} or not isinstance(command["command"], str) or
            not Path(command["command"]).is_absolute() or not isinstance(command["args"], list) or
            not all(isinstance(arg, str) and "\0" not in arg for arg in command["args"]) or
            command["cwd"] != str(workspace)):
        raise ValueError("reviewed runtime launch mismatch")
    report = workspace / "probe.json"
    if report.exists() or report.is_symlink():
        raise ValueError("stale probe evidence refused")
    evidence = root / "launch-evidence.json"
    # Create before any process submission; even a crash cannot silently reuse
    # this fixture. ROOT retains the pending evidence instead of retrying here.
    with evidence.open("x", encoding="utf8") as output:
        os.chmod(evidence, 0o600)
        before = Path("/proc/self/mountinfo").read_bytes()
        snapshots = {path: probe.snapshot(Path(path)) for path in manifest["protected"]}
        pending = {"schemaVersion": 1, "fixtureRoot": str(root), "generation": epoch["generation"], "activationBinding": activation,
                   "state": "submission-pending", "retainedInputDescriptor": retain_input_fd, "writableAlias": writable_alias, "freezeHostedSlice": freeze_slice, "missingSourceIndex": missing_source, "timeoutSeconds": timeout, "cancelAfterSeconds": cancel_after, "liveAcceptance": False}
        output.write(json.dumps(pending) + "\n"); output.flush(); os.fsync(output.fileno())
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        launcher = runtime / "host-integration/global-scan-guard/launch-hosted-subscription-runtime-job"
        alias = create_writable_alias(root) if writable_alias else None
        held = withhold_source(root, missing_source)
        retained_fd = None
        if freeze_slice:
            freeze_empty_hosted_slice(epoch)
        try:
            if retain_input_fd:
                # A fixed synthetic regular file; never an operator-supplied path.
                retained_fd = os.open(workspace / probe.ROOTS[2], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
                if not stat.S_ISREG(os.fstat(retained_fd).st_mode):
                    raise ValueError("fixed descriptor fixture requires regular input")
            result = run_reviewed([str(launcher), command["command"], *command["args"]], command["cwd"],
                                  timeout=timeout, cancel_after=cancel_after,
                                  inherited_fds=() if retained_fd is None else (retained_fd,))
        finally:
            if retained_fd is not None:
                os.close(retained_fd)
            if freeze_slice:
                thaw_closed_hosted_slice(epoch)
        after = Path("/proc/self/mountinfo").read_bytes()
        try:
            verified = probe.verify(root, report)
        except (OSError, ValueError, KeyError, TypeError):
            verified = {"probeChecksPassed": False, "reason": "probe-evidence-unavailable-or-invalid", "liveAcceptance": False}
        try:
            unchanged = all(probe.snapshot(Path(path)) == value for path, value in snapshots.items())
        except OSError:
            unchanged = False
        held_unchanged = None
        if held is not None:
            source = root / "workspace" / probe.ROOTS[missing_source]
            try:
                held_unchanged = all(probe.snapshot(held / Path(path).relative_to(source)) == value
                                     for path, value in snapshots.items() if Path(path).is_relative_to(source))
            except OSError:
                held_unchanged = False
        try:
            terminal_observation = observe_terminal_units(epoch)
        except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            terminal_observation = {"error": "terminal-observation-incomplete", "terminalCustodyProven": False}
        alias_unchanged = None
        if alias is not None:
            try:
                original = snapshots[str(workspace / probe.ROOTS[2])]
                actual = probe.snapshot(alias)
                alias_unchanged = all(actual[key] == original[key] for key in ("dev", "ino", "mode", "sha256"))
            except (OSError, KeyError):
                alias_unchanged = False
        record = {**pending, "aliasBytesAndIdentityUnchanged": alias_unchanged, "terminalObservation": terminal_observation, "missingSourceHeldUnchanged": held_unchanged, "state": "outer-process-returned", "exitCode": result["exitCode"], "outputDigests": {key: result[key] for key in ("stdout", "stderr")},
                  "lifecycle": {key: result[key] for key in ("timedOut", "cancellationRequested", "proxyKillRequested", "terminalCustodyProven")},
                  "hostMountViewUnchanged": before == after,
                  "hostProtectedUnchanged": unchanged,
                  "probe": verified, "liveAcceptance": False,
                  "remaining": "ROOT must verify actual provider provenance, sibling views, service/descendant terminal custody, aliases, failures and reboot"}
        # Append, preserving the pre-submission witness and all returned facts.
        output.write(json.dumps(record) + "\n"); output.flush(); os.fsync(output.fileno())
        return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--timeout", type=float, default=300, help="bounded process wait, seconds (maximum 3600)")
    parser.add_argument("--cancel-after", type=float, help="send SIGTERM to production wrapper after this many seconds")
    parser.add_argument("--missing-source", type=int, choices=range(len(probe.ROOTS)), help="withhold one fixed synthetic root until ROOT reconciliation; never implies accepted denial")
    parser.add_argument("--retain-input-fd", action="store_true", help="inherit a writable descriptor to the fixed synthetic README; negative evidence only")
    parser.add_argument("--writable-alias", action="store_true", help="retain a hardlink from the fixed synthetic README into its writable consumer; negative evidence only")
    parser.add_argument("--freeze-hosted-slice", action="store_true", help="delay outer startup in an existing empty dedicated slice; requires --cancel-after and durable closure before thaw")
    args = parser.parse_args()
    try:
        result = launch(args.root, args.runtime, args.timeout, args.cancel_after, args.missing_source, args.retain_input_fd, args.writable_alias, args.freeze_hosted_slice)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        print("readonly_qualification_incomplete", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0 if (not result["freezeHostedSlice"] and not result["writableAlias"] and not result["retainedInputDescriptor"] and result["missingSourceIndex"] is None and result["exitCode"] == 0 and not result["lifecycle"]["timedOut"] and not result["lifecycle"]["cancellationRequested"] and
                 all("error" not in item for item in result["outputDigests"].values()) and result["hostMountViewUnchanged"] and
                 result["hostProtectedUnchanged"] and result["probe"]["probeChecksPassed"] and
                 bool(result["terminalObservation"].get("units")) and
                 all(row["observedTerminal"] for row in result["terminalObservation"]["units"])) else 1


if __name__ == "__main__":
    sys.exit(main())
