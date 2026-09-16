#!/usr/bin/env python3
"""Offline fixture regressions; no mount, service, provider or auth operations."""
import importlib.util
import hashlib
import errno
import io
import os
from unittest.mock import Mock
import subprocess
from types import SimpleNamespace
from unittest.mock import patch
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("readonly_fixture", Path(__file__).with_name("hosted-readonly-inputs.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


launch_spec = importlib.util.spec_from_file_location("readonly_launcher", Path(__file__).with_name("hosted-readonly-launch.py"))
launcher = importlib.util.module_from_spec(launch_spec)
launch_spec.loader.exec_module(launcher)

def mount(path, readonly=True):
    return {"path": path, "options": ["ro" if readonly else "rw"]}


class ReadonlyFixtureTests(unittest.TestCase):
    def test_launcher_requires_current_exclusive_installation_and_retains_byte_digests(self):
        identity = {"runtimeSha": "a" * 40, "runtimeManifestSha256": "b" * 64}
        epoch = {"hostId": "host", "bootId": "boot", "supervisorId": "supervisor", "identity": identity}
        installation = {"schemaVersion": 1, "installationId": "installation", "hostId": "host", "runtimeDirectory": "/runtime", "inventorySha256": "inventory-sha", **identity}
        activation = {"schemaVersion": 1, "installationId": "installation", "hostId": "host", "bootId": "boot",
                      "supervisorId": "supervisor", "phase": "EXCLUSIVE", "exclusiveEnrollmentSha256": "birth-sha",
                      "ordinaryStarts": [], "generation": 4}
        birth = {"identity": identity, "generation": 1, "phase": "closed", "revoked": False, "reservations": [], "outerRuntime": None}
        records = {"host-installation.json": (installation, "installation-sha"),
                   "host-activation.json": (activation, "activation-sha"), "readonly-enrollment.json": (birth, "birth-sha"),
                   hashlib.sha256(b"/runtime").hexdigest() + ".json": ({"schemaVersion": 1, "runtimeDirectory": "/runtime", **identity}, "stage-sha"),
                   "readonly-inventory.json": ({"schemaVersion": 2, "hostId": "host"}, "inventory-sha")}
        with patch.object(Path, "lstat", side_effect=FileNotFoundError), \
             patch.object(launcher, "private_json", side_effect=lambda path, **kwargs: records.get(path.name, records[hashlib.sha256(b"/runtime").hexdigest() + ".json"])):
            self.assertEqual(launcher.activation_binding(Path("/runtime"), epoch), {
                "installationSha256": "installation-sha", "activationSha256": "activation-sha",
                "enrollmentSha256": "birth-sha", "activationGeneration": 4,
                "stageSha256": "stage-sha", "inventorySha256": "inventory-sha"})
            for key, value in (("phase", "ORDINARY"), ("installationId", "foreign"), ("bootId", "foreign"),
                               ("exclusiveEnrollmentSha256", "foreign"), ("ordinaryStarts", [{"state": "reserved"}])):
                with self.subTest(key=key), patch.dict(activation, {key: value}):
                    with self.assertRaises(ValueError): launcher.activation_binding(Path("/runtime"), epoch)
            with self.assertRaises(ValueError): launcher.activation_binding(Path("/foreign-runtime"), epoch)
            with patch.dict(installation, {"inventorySha256": "unrelated"}):
                with self.assertRaises(ValueError): launcher.activation_binding(Path("/runtime"), epoch)
            stage = records[hashlib.sha256(b"/runtime").hexdigest() + ".json"][0]
            for key in ("runtimeDirectory", "runtimeSha", "runtimeManifestSha256"):
                with self.subTest(stage=key), patch.dict(stage, {key: "foreign"}):
                    with self.assertRaises(ValueError): launcher.activation_binding(Path("/runtime"), epoch)
        with patch.object(Path, "lstat", return_value=object()), patch.object(launcher, "private_json") as read:
            with self.assertRaises(ValueError): launcher.activation_binding(Path("/runtime"), epoch)
            read.assert_not_called()

    def test_effective_mount_requires_readonly_and_unambiguous_descendants(self):
        cases = [
            ([], False),
            ([mount("/", False)], False),
            ([mount("/", False), mount("/sealed")], True),
            ([mount("/sealed"), mount("/sealed", False)], False),
            ([mount("/sealed"), mount("/sealed")], False),
            ([mount("/sealed"), mount("/sealed/child", False)], False),
            ([mount("/sealed"), mount("/sealed/child")], True),
            ([mount("/sealed"), mount("/sealed/child"), mount("/sealed/child")], False),
            ([mount("/sealed"), mount("/sealed/child"), mount("/sealed/child", False)], False),
            ([mount("/sealed"), mount("/sealed-other", False)], True),
        ]
        for entries, expected in cases:
            with self.subTest(entries=entries):
                self.assertEqual(fixture.readonly_mount_observation("/sealed", entries)[0], expected)

    def test_sibling_directory_can_move_without_changing_consumer_or_inputs(self):
        with tempfile.TemporaryDirectory(prefix="readonly-sibling-regression-") as temporary:
            root = Path(temporary) / "fixture"
            manifest = fixture.prepare(root)
            def unchanged():
                return all(fixture.snapshot(Path(path)) == expected
                           for path, expected in manifest["protected"].items())
            self.assertTrue(fixture.writable_sibling_lifecycle(root / "workspace", unchanged)["passed"])
            self.assertTrue(unchanged())
            consumer = dict(manifest["consumer"])
            path = consumer.pop("path")
            self.assertEqual(fixture.snapshot(Path(path)), consumer)

    def test_namespace_child_failures_are_not_denial_evidence(self):
        root = Path("/synthetic/fixture")
        denied = {"entered": False, "namespaceErrno": errno.EPERM, "mountErrno": None,
                  "writeErrno": None, "passed": True}
        cases = [
            (SimpleNamespace(returncode=0, stdout=json.dumps(denied)), True),
            (SimpleNamespace(returncode=0, stdout=json.dumps({**denied, "namespaceErrno": errno.ENOSYS})), False),
            (SimpleNamespace(returncode=0, stdout=json.dumps({**denied, "namespaceErrno": None})), False),
            (SimpleNamespace(returncode=0, stdout=json.dumps({**denied, "extra": True})), False),
            (SimpleNamespace(returncode=0, stdout=json.dumps({**denied, "entered": 1})), False),
            (SimpleNamespace(returncode=0, stdout=json.dumps({**denied, "entered": True, "namespaceErrno": None,
                                                              "writeErrno": errno.EROFS})), True),
            (SimpleNamespace(returncode=0, stdout=json.dumps({**denied, "entered": True})), False),
            (SimpleNamespace(returncode=1, stdout=json.dumps(denied)), False),
            (SimpleNamespace(returncode=0, stdout="{"), False),
            (FileNotFoundError(), False),
            (subprocess.TimeoutExpired("synthetic-child", 10), False),
        ]
        for response, expected in cases:
            with self.subTest(response=response):
                options = {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
                with patch.object(fixture.subprocess, "run", **options) as run:
                    rows = fixture.namespace_checks(root, lambda: True)
                self.assertEqual(len(rows), 28)
                self.assertTrue(all(row["passed"] == expected for row in rows))
                self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
                self.assertTrue(run.call_args.kwargs["close_fds"])
                self.assertEqual(run.call_args.args[0][-2:], ["13", "bind"])
        with patch.object(fixture.subprocess, "run", return_value=cases[0][0]):
            self.assertTrue(all(not row["passed"] for row in fixture.namespace_checks(root, lambda: False)))

    def test_namespace_attempt_only_mutates_in_a_fresh_child_namespace(self):
        with tempfile.TemporaryDirectory(prefix="readonly-namespace-regression-") as temporary:
            root = Path(temporary) / "fixture"
            fixture.prepare(root)
            with patch.object(fixture.ctypes, "CDLL") as factory, patch.object(fixture, "append") as append:
                libc = factory.return_value
                libc.unshare.return_value = -1
                with patch.object(fixture.ctypes, "get_errno", return_value=errno.EPERM):
                    self.assertTrue(fixture.namespace_attempt(root, 0, "remount")["passed"])
                libc.mount.assert_not_called()
                append.assert_not_called()
                libc.unshare.return_value = 0
                libc.mount.return_value = -1
                append.side_effect = OSError(errno.EROFS, "synthetic readonly")
                self.assertTrue(fixture.namespace_attempt(root, 0, "remount")["passed"])
                self.assertEqual(libc.mount.call_args.args[3], 4096 | 32)
                append.side_effect = None
                self.assertFalse(fixture.namespace_attempt(root, 0, "bind")["passed"])
                self.assertEqual(libc.mount.call_args.args[3], 4096)

    def test_reviewed_launcher_uses_pipes_and_retains_only_output_digests(self):
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b"synthetic-output"), stderr=io.BytesIO(b"synthetic-error"))
        child.wait.return_value = 0
        with patch.object(launcher.subprocess, "Popen", return_value=child) as popen, \
             patch.object(launcher.signal, "signal"), patch.object(launcher.signal, "getsignal", return_value=None):
            result = launcher.run_reviewed(["/synthetic/launcher", "literal argument"], "/synthetic/W")
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["stdout"]["bytes"], 16)
        self.assertNotIn("synthetic-output", json.dumps(result))
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        for name in ("stdin", "stdout", "stderr"):
            self.assertEqual(popen.call_args.kwargs[name], subprocess.PIPE)

    def test_negative_descriptor_reaches_the_production_wrapper_unchanged(self):
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
        child.wait.return_value = 70
        with patch.object(launcher.subprocess, "Popen", return_value=child) as popen, \
             patch.object(launcher.signal, "signal"), patch.object(launcher.signal, "getsignal", return_value=None):
            result = launcher.run_reviewed(["/synthetic/launcher"], "/synthetic/W", inherited_fds=(123,))
        self.assertEqual(popen.call_args.kwargs["pass_fds"], (123,))
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        self.assertFalse(result["terminalCustodyProven"])
        self.assertEqual(result["exitCode"], 70)

    def test_launcher_cancellation_timeout_and_unobserved_proxy_remain_unproven(self):
        for cancel_after, waits, killed, timed_out in (
            (1, [subprocess.TimeoutExpired("synthetic", 1), -15], False, False),
            (None, [subprocess.TimeoutExpired("synthetic", 2), -15], False, True),
            (1, [subprocess.TimeoutExpired("synthetic", 1)] * 3, True, True),
        ):
            with self.subTest(cancel_after=cancel_after, killed=killed):
                child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
                child.wait.side_effect = waits
                with patch.object(launcher.subprocess, "Popen", return_value=child), \
                     patch.object(launcher.signal, "signal"), patch.object(launcher.signal, "getsignal", return_value=None):
                    result = launcher.run_reviewed(["/synthetic/launcher"], "/synthetic/W", timeout=2, cancel_after=cancel_after)
                child.send_signal.assert_called_once_with(launcher.signal.SIGTERM)
                self.assertEqual(child.kill.call_count, int(killed))
                self.assertEqual(result["timedOut"], timed_out)
                self.assertTrue(result["cancellationRequested"])
                self.assertFalse(result["terminalCustodyProven"])
                self.assertEqual(result["exitCode"], None if killed else -15)

    def test_retained_output_descriptor_cannot_become_success_evidence(self):
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
        child.wait.return_value = 0
        thread = Mock()
        thread.is_alive.return_value = True
        with patch.object(launcher.subprocess, "Popen", return_value=child), \
             patch.object(launcher.threading, "Thread", return_value=thread) as create_thread, \
             patch.object(launcher.signal, "signal"), patch.object(launcher.signal, "getsignal", return_value=None):
            result = launcher.run_reviewed(["/synthetic/launcher"], "/synthetic/W")
        self.assertTrue(create_thread.call_args.kwargs["daemon"])
        self.assertEqual(thread.join.call_args.kwargs, {"timeout": 1})
        self.assertEqual(result["stdout"]["error"], "output-pipe-still-open")
        self.assertEqual(result["stderr"]["error"], "output-pipe-still-open")
        self.assertFalse(result["terminalCustodyProven"])

    def test_invalid_timing_never_submits_a_process(self):
        with patch.object(launcher.subprocess, "Popen") as popen:
            for timeout, cancel in ((0, None), (float("nan"), None), (3601, None), (2, 2), (2, -1)):
                with self.assertRaises(ValueError):
                    launcher.run_reviewed(["/synthetic/launcher"], "/synthetic/W", timeout, cancel)
            popen.assert_not_called()

    def test_launch_requires_matching_fresh_disposable_enrollment(self):
        for retain in (False, True):
            with self.subTest(retain_input_fd=retain):
                self.check_launch_requires_matching_fresh_disposable_enrollment(retain)

    def check_launch_requires_matching_fresh_disposable_enrollment(self, retain):
        with tempfile.TemporaryDirectory(prefix="readonly-launch-regression-") as temporary:
            root, runtime = Path(temporary) / "fixture", Path(temporary) / "runtime"
            runtime.mkdir()
            manifest = fixture.prepare(root)
            identity = {"jobId": "fixture-job", "jobRootDir": str(root / "job"),
                        "workspacePath": str(root / "workspace"), "runtimeSha": "a" * 40,
                        "runtimeManifestSha256": "b" * 64, "issuerDeploymentDigest": "c" * 64}
            epoch = {"identity": identity, "phase": "ready", "revoked": False,
                     "requirement": "test_managed_qualification", "generation": 2,
                     "hostId": "host", "bootId": "boot", "supervisorId": "supervisor"}
            installation = {"schemaVersion": 1, "installationId": "installation", "hostId": "host",
                            "runtimeDirectory": str(runtime), "runtimeSha": identity["runtimeSha"],
                            "runtimeManifestSha256": identity["runtimeManifestSha256"], "inventorySha256": "inventory-sha"}
            activation = {"schemaVersion": 1, "installationId": "installation", "hostId": "host", "bootId": "boot",
                          "supervisorId": "supervisor", "phase": "EXCLUSIVE", "exclusiveEnrollmentSha256": "birth-sha",
                          "ordinaryStarts": [], "generation": 4}
            birth = {"identity": identity, "generation": 1, "phase": "closed", "revoked": False, "reservations": [], "outerRuntime": None}
            policy = {**identity, "readonlyPaths": manifest["readonlyPaths"]}
            command = {"command": "/synthetic/node", "args": ["/synthetic/cli"], "cwd": str(root / "workspace")}
            def authority(path, *, with_digest=False):
                if with_digest:
                    return {"host-installation.json": (installation, "installation-sha"),
                            "host-activation.json": (activation, "activation-sha"),
                            "readonly-enrollment.json": (birth, "birth-sha"),
                            hashlib.sha256(str(runtime).encode()).hexdigest() + ".json": (
                                {key: installation[key] for key in ("schemaVersion", "runtimeDirectory", "runtimeSha", "runtimeManifestSha256")}, "stage-sha"),
                            "readonly-inventory.json": ({"schemaVersion": 2, "hostId": "host", "runtimeLaunch": command}, "inventory-sha")}[path.name]
                if path.name == "fixture.json": return manifest
                if path.name == "readonly-epoch.json": return epoch
                if path.name == "readonly-inventory.json": return {"runtimeLaunch": command}
                return policy
            with patch.object(launcher, "AUTHORITY", Path(temporary) / "host"), \
                 patch.object(launcher, "host_operator"), patch.object(launcher, "private_json", side_effect=authority), \
                 patch.object(launcher, "run_reviewed", return_value={"exitCode": 0, "stdout": {}, "stderr": {}, "timedOut": False, "cancellationRequested": False, "proxyKillRequested": False, "terminalCustodyProven": False}) as run, \
                 patch.object(launcher.probe, "verify", side_effect=FileNotFoundError()):
                epoch["revoked"] = True
                with self.assertRaises(ValueError): launcher.launch(root, runtime)
                run.assert_not_called()
                epoch["revoked"] = False
                policy["readonlyPaths"] = []
                with self.assertRaises(ValueError): launcher.launch(root, runtime)
                run.assert_not_called()
                policy["readonlyPaths"] = manifest["readonlyPaths"]
                # Re-reading the command must authenticate the exact bytes
                # observed by preflight, even when each record is private.
                inventory_reads = 0
                def changed_inventory(path, *, with_digest=False):
                    nonlocal inventory_reads
                    value = authority(path, with_digest=with_digest)
                    if path.name == "readonly-inventory.json":
                        inventory_reads += 1
                        if inventory_reads == 2:
                            return (value[0], "changed-inventory-sha")
                    return value
                with patch.object(launcher, "private_json", side_effect=changed_inventory):
                    with self.assertRaisesRegex(ValueError, "inventory changed"):
                        launcher.launch(root, runtime)
                run.assert_not_called()
                self.assertFalse((root / "launch-evidence.json").exists())
                descriptors = []
                def observe(*args, **kwargs):
                    descriptors.extend(kwargs["inherited_fds"])
                    if retain:
                        self.assertEqual(len(descriptors), 1)
                        self.assertEqual(os.fstat(descriptors[0]).st_ino,
                                         (root / "workspace" / fixture.ROOTS[2]).stat().st_ino)
                    else:
                        self.assertEqual(descriptors, [])
                    return run.return_value
                run.side_effect = observe
                result = launcher.launch(root, runtime, retain_input_fd=retain)
                self.assertEqual(result["retainedInputDescriptor"], retain)
                for fd in descriptors:
                    with self.assertRaises(OSError): os.fstat(fd)
                self.assertFalse(result["liveAcceptance"])
                self.assertFalse(result["probe"]["probeChecksPassed"])
                self.assertEqual(run.call_args.args, ([str(runtime / "host-integration/global-scan-guard/launch-hosted-subscription-runtime-job"),
                                                       "/synthetic/node", "/synthetic/cli"], str(root / "workspace")))
                records = [json.loads(line) for line in (root / "launch-evidence.json").read_text().splitlines()]
                self.assertEqual([record["state"] for record in records], ["submission-pending", "outer-process-returned"])
                self.assertTrue(all(record["activationBinding"]["activationSha256"] == "activation-sha" for record in records))
                self.assertTrue(all(record["activationBinding"]["stageSha256"] == "stage-sha" and
                                    record["activationBinding"]["inventorySha256"] == "inventory-sha" for record in records))
                with self.assertRaises(FileExistsError): launcher.launch(root, runtime)
                self.assertEqual(run.call_count, 1)

    def test_terminal_observation_keeps_queue_descendants_and_manager_failures_distinct(self):
        name = "subscription-runtime-outer-12345678-1234-1234-1234-123456789abc.service"
        epoch = {"identity": {"jobId": "synthetic"}, "hostId": "host", "bootId": "boot", "supervisorId": "supervisor", "generation": 2, "phase": "closed",
                 "reservations": [], "outerRuntime": {"unit": name}}
        for queued, populated, status, expected in ((False, 0, 0, True), (True, 0, 0, False),
                                                  (False, 1, 0, False), (False, 0, 4, True)):
            group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + name
            unit = ("LoadState=not-found\n" if status == 4 else
                    f"Id={name}\nLoadState=loaded\nMainPID=0\nControlGroup={group}\nActiveState=inactive\n")
            responses = [SimpleNamespace(returncode=0, stdout=(f"1 {name} start waiting\n" if queued else "").encode()),
                         SimpleNamespace(returncode=status, stdout=unit.encode())]
            with self.subTest(queued=queued, populated=populated, status=status), \
                 patch.object(launcher, "private_json", return_value=epoch), \
                 patch.object(launcher.subprocess, "run", side_effect=responses) as run, \
                 patch.object(Path, "read_text", return_value=f"populated {populated}\n"):
                result = launcher.observe_terminal_units(epoch)
                self.assertEqual(result["units"][0]["observedTerminal"], expected)
                self.assertFalse(result["terminalCustodyProven"])
                self.assertEqual(run.call_args.args[0][-2:], ["--", name])
        with patch.object(launcher, "private_json", return_value=epoch), \
             patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=b"")):
            with self.assertRaises(ValueError): launcher.observe_terminal_units(epoch)
        epoch["outerRuntime"]["unit"] = "unreviewed.service"
        with patch.object(launcher, "private_json", return_value=epoch), patch.object(launcher.subprocess, "run") as run:
            with self.assertRaises(ValueError): launcher.observe_terminal_units(epoch)
            run.assert_not_called()

    def test_terminal_observation_cannot_substitute_a_recovered_or_rebooted_epoch(self):
        initial = {"identity": {"jobId": "synthetic"}, "hostId": "host", "bootId": "boot",
                   "supervisorId": "supervisor", "generation": 2}
        for key in ("hostId", "bootId", "supervisorId", "generation"):
            current = {**initial, key: 3 if key == "generation" else "changed"}
            with self.subTest(key=key), patch.object(launcher, "private_json", return_value=current), \
                 patch.object(launcher.subprocess, "run") as run:
                with self.assertRaises(ValueError): launcher.observe_terminal_units(initial)
                run.assert_not_called()

    def test_sibling_holds_real_writable_fixture_descriptor_in_separate_unit_only(self):
        spec = importlib.util.spec_from_file_location("readonly_sibling", Path(__file__).with_name("hosted-readonly-hostile-sibling.py"))
        sibling = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sibling)
        with tempfile.TemporaryDirectory(prefix="readonly-sibling-") as temporary:
            root = Path(temporary) / "fixture"
            manifest = fixture.prepare(root)
            event = Mock()
            group = "0::/system.slice/subscription-runtime-qualification-sibling-12345678-1234-1234-1234-123456789abc.service"
            def wait(seconds):
                self.assertEqual(seconds, 300)
                record = json.loads((root / "sibling-evidence.jsonl").read_bytes().splitlines()[0])
                self.assertEqual(record["state"], "writable-descriptor-held")
                self.assertEqual(record["ino"], manifest["protected"][str(root / "workspace" / fixture.ROOTS[2])]["ino"])
                self.assertFalse(record["liveAcceptance"])
            event.wait.side_effect = wait
            with patch.object(sibling.launcher, "host_operator"), \
                 patch.object(sibling.launcher, "private_json", return_value=manifest), \
                 patch.object(Path, "read_text", return_value=group), \
                 patch.object(sibling.threading, "Event", return_value=event), \
                 patch.object(sibling.signal, "signal"), patch.object(sibling.signal, "getsignal", return_value=None):
                sibling.hold(root)
                self.assertEqual(event.wait.call_count, 1)
                with self.assertRaises(FileExistsError): sibling.hold(root)
                with patch.object(Path, "read_text", return_value="0::/trusted-supervisor.service"):
                    with self.assertRaises(ValueError): sibling.hold(root)
            for path, original in manifest["protected"].items():
                self.assertEqual(fixture.snapshot(Path(path)), original)

    def test_alternate_mount_requires_new_namespace_and_private_propagation(self):
        spec = importlib.util.spec_from_file_location("readonly_sibling_mount", Path(__file__).with_name("hosted-readonly-hostile-sibling.py"))
        sibling = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sibling)
        for failure in ("unshare", "namespace", "private", "bind", "identity", "none"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix="readonly-alternate-") as temporary:
                root = Path(temporary) / "fixture"
                fixture.prepare(root)
                source = root / "workspace" / fixture.ROOTS[2]
                original = source.stat()
                libc = Mock()
                libc.unshare.return_value = -1 if failure == "unshare" else 0
                libc.mount.side_effect = [-1 if failure == "private" else 0, -1 if failure == "bind" else 0]
                identities = [(root / "workspace" / fixture.WRITABLE[0]).stat(), original,
                              SimpleNamespace(st_dev=-1, st_ino=-1) if failure == "identity" else original]
                with patch.object(sibling.ctypes, "CDLL", return_value=libc), \
                     patch.object(sibling.os, "readlink", side_effect=["mnt:[1]", "mnt:[1]" if failure == "namespace" else "mnt:[2]"]), \
                     patch.object(Path, "stat", side_effect=identities):
                    if failure == "none":
                        self.assertEqual(sibling.private_alias(root, source).name, "readonly-negative-mount")
                    else:
                        with self.assertRaises(ValueError): sibling.private_alias(root, source)
                expected_calls = 0 if failure in ("unshare", "namespace") else 1 if failure == "private" else 2
                self.assertEqual(libc.mount.call_count, expected_calls)
                if expected_calls:
                    self.assertEqual(libc.mount.call_args_list[0].args, (None, b"/", None, 0x4000 | 0x40000, None))

    def test_delayed_start_freezes_only_empty_slice_and_thaws_only_same_closed_epoch(self):
        initial = {"identity": {"jobId": "synthetic"}, "hostId": "host", "bootId": "boot",
                   "supervisorId": "supervisor", "generation": 2, "phase": "ready",
                   "outerRuntime": None, "reservations": []}
        reads = ["0::/trusted.service", "populated 0\nfrozen 0\n", "populated 0\nfrozen 1\n"]
        with patch.object(Path, "read_text", side_effect=reads), \
             patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            launcher.freeze_empty_hosted_slice(initial)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/systemctl", "freeze", "subscription-runtime-hosted.slice"])
        for current in (initial, {**initial, "phase": "closed", "generation": 3}, {**initial, "phase": "closed", "bootId": "new"}):
            with patch.object(launcher, "private_json", return_value=current), patch.object(launcher.subprocess, "run") as run:
                with self.assertRaises(ValueError): launcher.thaw_closed_hosted_slice(initial)
                run.assert_not_called()
        with patch.object(launcher, "private_json", return_value={**initial, "phase": "closed"}), \
             patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            launcher.thaw_closed_hosted_slice(initial)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/systemctl", "thaw", "subscription-runtime-hosted.slice"])
        for events in ("populated 1\nfrozen 0\n", "populated 0\nfrozen 1\n", "populated 0\n"):
            with patch.object(Path, "read_text", side_effect=["0::/trusted.service", events]), \
                 patch.object(launcher.subprocess, "run") as run:
                with self.assertRaises(ValueError): launcher.freeze_empty_hosted_slice(initial)
                run.assert_not_called()
        with patch.object(Path, "read_text") as read, patch.object(launcher.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                launcher.freeze_empty_hosted_slice({**initial, "outerRuntime": {"state": "reserved"}})
            read.assert_not_called()
            run.assert_not_called()

    def test_writable_alias_retains_same_synthetic_inode_without_overwriting(self):
        with tempfile.TemporaryDirectory(prefix="readonly-alias-") as temporary:
            root = Path(temporary) / "fixture"
            fixture.prepare(root)
            source = root / "workspace" / fixture.ROOTS[2]
            before = fixture.snapshot(source)
            alias = launcher.create_writable_alias(root)
            self.assertEqual(alias.stat().st_ino, before["ino"])
            self.assertEqual(alias.stat().st_nlink, 2)
            self.assertEqual(fixture.snapshot(alias)["sha256"], before["sha256"])
            with self.assertRaises(FileExistsError): launcher.create_writable_alias(root)
            self.assertEqual(fixture.snapshot(alias)["sha256"], before["sha256"])
            consumer = root / "workspace" / fixture.WRITABLE[0]
            consumer.rename(root / "saved-consumer")
            consumer.symlink_to(root / "saved-consumer", target_is_directory=True)
            with self.assertRaises(ValueError): launcher.create_writable_alias(root)

    def test_missing_source_preserves_original_until_independent_reconciliation(self):
        for index in range(len(fixture.ROOTS)):
            with self.subTest(index=index), tempfile.TemporaryDirectory(prefix="readonly-missing-") as temporary:
                root = Path(temporary) / "fixture"
                manifest = fixture.prepare(root)
                launcher.validate_fixture_paths(root, manifest)
                source = root / "workspace" / fixture.ROOTS[index]
                before = fixture.snapshot(source)
                saved = launcher.withhold_source(root, index)
                self.assertFalse(source.exists())
                self.assertEqual(fixture.snapshot(saved), before)
                with self.assertRaises(FileExistsError): launcher.withhold_source(root, index)
                self.assertEqual(fixture.snapshot(saved), before)

    def test_fixture_paths_cannot_select_external_or_replaced_ancestors(self):
        with tempfile.TemporaryDirectory(prefix="readonly-paths-") as temporary:
            root = Path(temporary) / "fixture"
            manifest = fixture.prepare(root)
            manifest["protected"][str(root.parent / "unrelated")] = {}
            with self.assertRaises(ValueError): launcher.validate_fixture_paths(root, manifest)
            del manifest["protected"][str(root.parent / "unrelated")]
            parent = root / "workspace/runtime"
            parent.rename(root / "retained-runtime")
            parent.symlink_to(root / "retained-runtime", target_is_directory=True)
            with self.assertRaises(ValueError): launcher.validate_fixture_paths(root, manifest)

    def test_unprotected_fixture_keeps_writable_lifecycle_but_cannot_pass(self):
        with tempfile.TemporaryDirectory(prefix="readonly-fixture-regression-") as temporary:
            root = Path(temporary) / "fixture"
            manifest = fixture.prepare(root)
            with self.assertRaises(FileExistsError):
                fixture.prepare(root)
            with patch.object(fixture, "namespace_checks", return_value=[]):
                evidence = fixture.probe(root)
            self.assertEqual(len(evidence["results"]), 167)
            self.assertFalse(evidence["liveAcceptance"])
            writable = [row for row in evidence["results"] if row["operation"] == "writable"]
            self.assertEqual(len(writable), 9)
            self.assertTrue(all(row["passed"] for row in writable))
            sibling = [row for row in evidence["results"] if row["operation"] == "writable-sibling-rename"]
            self.assertEqual(len(sibling), 1)
            # Earlier unprotected destructive attempts invalidate sealed identities,
            # so the sibling row must preserve that failure even if rename succeeded.
            self.assertFalse(sibling[0]["passed"])
            consumer = dict(manifest["consumer"])
            path = consumer.pop("path")
            self.assertEqual(fixture.snapshot(Path(path)), consumer)
            self.assertFalse((root / "workspace" / fixture.OWN / "fixture-lifecycle-a").exists())
            self.assertFalse((root / "workspace" / fixture.OWN / "fixture-lifecycle-b").exists())
            report = Path(temporary) / "probe.json"
            report.write_text(json.dumps(evidence))
            self.assertFalse(fixture.verify(root, report)["probeChecksPassed"])


if __name__ == "__main__":
    unittest.main()
