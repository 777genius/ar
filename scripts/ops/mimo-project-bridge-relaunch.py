#!/usr/bin/env python3
"""Relaunch a MimoProject bridge job under a new job id with safe plan staging."""

import argparse
import json
import os
import stat
import subprocess
import sys
import time

BRIDGE_CLI = [
    "/usr/local/bin/node",
    os.environ.get(
        "BRIDGE_CLI",
        "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js",
    ),
]
STATE_ROOT = "/srv/worker-state/mimo-projects"
WORKSPACES_ROOT = "/srv/workers/mimo-projects"


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def call(req, tag):
    p = subprocess.run(BRIDGE_CLI, input=json.dumps(req), capture_output=True, text=True)
    out = p.stdout.strip()
    print("%s %s rc=%d %s" % (stamp(), tag, p.returncode, out[:800]), flush=True)
    if p.stderr.strip():
        sys.stderr.write(p.stderr)
    try:
        return json.loads(out)
    except Exception:
        return None


def obs_of(r):
    if not isinstance(r, dict):
        return {}
    v = r.get("result")
    return v if isinstance(v, dict) else {}


def result_ok(res):
    if not isinstance(res, dict) or res.get("ok") is not True or res.get("error"):
        return False
    inner = res.get("result")
    if isinstance(inner, dict) and inner.get("ok") is False:
        return False
    return True


def poll(req, phase, max_polls):
    """Submit req, then resubmit the same request every 5 s until it settles.

    A `running` observation is the bridge's owned operation unit, not launch
    confirmation. Only a settled observation with an ok result returns True.
    """
    label = phase.upper()
    job = req["jobId"]
    r = call(req, phase)
    seen_running = False
    for _ in range(max_polls):
        obs = obs_of(r)
        st = obs.get("state")
        if st == "settled":
            res = obs.get("result") or {}
            if result_ok(res):
                print("%s %s_SETTLED_OK %s" % (stamp(), label, job), flush=True)
                return True
            print("%s %s_SETTLED_FAIL %s %s" % (stamp(), label, job, json.dumps(obs)[:600]), flush=True)
            return False
        if st == "running" and not seen_running:
            seen_running = True
            print("%s %s_UNIT_RUNNING(not-launch) %s unit=%s" % (stamp(), label, job, obs.get("unit")), flush=True)
        if r is not None and not obs:
            print("%s %s_BAD_RESPONSE %s" % (stamp(), label, json.dumps(r)[:600]), flush=True)
            return False
        time.sleep(5)
        r = call(req, phase + "-poll")
    print("%s %s_POLL_TIMEOUT %s" % (stamp(), label, job), flush=True)
    return False


def workspace_relative(value):
    """argparse type: a relative path that stays inside the job workspace."""
    parts = os.path.normpath(value).split(os.sep)
    if os.path.isabs(value) or parts[0] in (".", ".."):
        raise argparse.ArgumentTypeError("must be a relative path inside the job workspace: %r" % value)
    return parts


def stage_plan(ws, dest_parts, data):
    """Write data to ws/<dest_parts> without following any symlink inside ws.

    This runs as root while the launched worker can already modify its
    workspace, so every component is opened relative to its parent with
    O_NOFOLLOW and only a regular file is written.
    """
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(ws, dir_flags)
    try:
        for name in dest_parts[:-1]:
            try:
                os.mkdir(name, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(name, dir_flags, dir_fd=fd)
            os.close(fd)
            fd = child
        out = os.open(dest_parts[-1], os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o666, dir_fd=fd)
        with os.fdopen(out, "wb") as f:
            if not stat.S_ISREG(os.fstat(out).st_mode):
                raise OSError("plan destination is not a regular file")
            f.truncate(0)
            f.write(data)
    finally:
        os.close(fd)


def strip_appledouble(ws):
    for root, _dirs, files, dirfd in os.fwalk(ws):
        for name in files:
            if name.startswith("._"):
                try:
                    os.unlink(name, dir_fd=dirfd)
                except OSError as exc:
                    print("%s STRIP_FAILED %s/%s %s" % (stamp(), root, name, exc), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("source_job")
    ap.add_argument("new_job")
    ap.add_argument("--workstream", required=True)
    ap.add_argument("--plan-src", required=True)
    ap.add_argument("--plan-dest", required=True, type=workspace_relative)
    ap.add_argument("--machine-id", default=os.environ.get("MACHINE_ID"))
    args = ap.parse_args()

    machine_id = args.machine_id
    if not machine_id:
        with open("/etc/machine-id") as f:
            machine_id = f.read().strip()

    opdir = "%s/%s/%s/mimo-bridge-operations" % (STATE_ROOT, args.project, args.workstream)
    ws = "%s/%s/%s/workspaces/%s" % (WORKSPACES_ROOT, args.project, args.workstream, args.new_job)
    plan_dest = os.path.join(ws, *args.plan_dest)

    # Preflight before any bridge effect: a refusal here submits nothing (exit 2).
    req_path = "%s/%s.create.request.json" % (opdir, args.source_job)
    print("%s SRC_REQUEST %s exists=%s" % (stamp(), req_path, os.path.exists(req_path)), flush=True)
    try:
        with open(req_path) as f:
            create_req = dict(json.load(f))
        with open(args.plan_src, "rb") as f:
            plan = f.read()
    except (OSError, TypeError, ValueError) as exc:
        ap.error("cannot read source request or --plan-src: %s" % exc)
    identity = tuple(create_req.get(k) for k in ("operation", "projectId", "workstreamId", "machineId"))
    if identity != ("create", args.project, args.workstream, machine_id):
        ap.error("source request %s does not match create/%s/%s on machine %s" % (identity, args.project, args.workstream, machine_id))
    create_req["jobId"] = args.new_job

    if not poll(create_req, "create", 180):
        print("%s EXIT create-not-ok %s" % (stamp(), args.new_job), flush=True)
        sys.exit(3)

    start_req = {
        "jobId": args.new_job,
        "kind": "MimoProject",
        "machineId": machine_id,
        "operation": "start",
        "projectId": args.project,
        "schemaVersion": 1,
        "workstreamId": args.workstream,
    }
    launched = poll(start_req, "start", 120)

    result_path = "%s/%s.start.result.json" % (opdir, args.new_job)
    try:
        with open(result_path) as f:
            raw = f.read()
    except Exception:
        raw = None
    print("%s START_RESULT_FILE %s %s" % (stamp(), result_path, (raw or "MISSING")[:600]), flush=True)
    file_ok = False
    if raw:
        try:
            file_ok = result_ok(json.loads(raw))
        except Exception:
            file_ok = False

    staged = False
    if launched and file_ok:
        try:
            stage_plan(ws, args.plan_dest, plan)
        except OSError as exc:
            print("%s STAGE_FAILED %s %s" % (stamp(), plan_dest, exc), flush=True)
        else:
            strip_appledouble(ws)
            staged = True
            print("%s STAGED %s (%d bytes)" % (stamp(), plan_dest, len(plan)), flush=True)
    else:
        print("%s NOT_STAGING launched=%s file_ok=%s" % (stamp(), launched, file_ok), flush=True)

    print("%s EXIT launched=%s staged=%s file_ok=%s job=%s" % (stamp(), launched, staged, file_ok, args.new_job), flush=True)
    sys.exit(0 if (launched and staged) else 4)


if __name__ == "__main__":
    main()
