# Disposable ordinary custody canary

Run only on the explicitly authorized test host, as root, with external storage.
The wrapper provisions a fresh Debian guest and never binds host policy, jobs,
credentials, sockets, projects, or databases. It runs with its own PID 1,
machine-id, cgroup namespace and private network, but without UID remapping so
the existing initial-user-namespace check remains meaningful inside the guest.

Prepare a sanitized root-owned artifact directory containing only `dist`,
`package.json`, and optional self-contained `node_modules`. No symlinks are
accepted. Build it from the specified exact commit before invoking this harness;
the wrapper verifies supplied tree digest before and after copying but does not
independently prove build provenance. The Node executable must be a root-owned
Linux binary compatible with Debian bookworm and the artifact's engine range.

```sh
node --test host-integration/custody-canary/run.node-test.mjs
node --input-type=module -e 'import {treeDigest} from "./host-integration/custody-canary/run.mjs"; console.log(treeDigest(process.argv[1]))' /mnt/external/canary-artifact
sudo node host-integration/custody-canary/run.mjs --external-root /mnt/external/canaries --runtime /mnt/external/canary-artifact --node /usr/local/bin/node --sha EXACT_40_HEX_COMMIT --manifest-sha256 EXACT_64_HEX_TREE_DIGEST
```

This is an ordinary custody CLI-process canary, **not provider or job E2E**.
The synthetic identity launches the real `codex-goal-cli --help` through the real
hosted runtime dispatcher. It checks installation/artifact binding, real ordinary
start/completion receipt, and refusal of the production kernel's `operatorSession()`
in an independent service cgroup. The probe uses a distinct exit status for that
specific refusal; import failures and unexpected admission do not count as passing.
It calls the production install/enroll/resume APIs without test hooks.
No claim of passing live evidence is made until a successful guest result exists.

The guest powers itself off. The wrapper retains the uniquely named guest and
result for inspection even on success. On timeout or uncertain shutdown it stops
and preserves everything; it never submits a replacement or blindly kills a unit.
There is intentionally no automatic storage deletion. Before removing the exact
printed directory, independently verify its ownership.json, absence of any live
nspawn process using that directory and empty guest cgroup. Never delete a parent
storage directory. Provisioning needs debootstrap/network; guest execution has no
external network. A minimal-systemd incompatibility fails closed and retains logs
at `rootfs/canary/guest.log`.
