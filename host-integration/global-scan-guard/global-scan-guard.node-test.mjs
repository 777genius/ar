import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const integrationDir = fileURLToPath(new URL(".", import.meta.url));
const wrapper = join(integrationDir, "subscription-runtime-global-scan-guard");
const launcher = join(integrationDir, "launch-hosted-codex-job");
const hostLauncher = join(integrationDir, "launch-hosted-subscription-runtime-job");
const guardedCodex = join(integrationDir, "codex-bin/codex");
const blockedRoots = [
  "/",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/dev",
  "/etc",
  "/proc",
  "/sys",
  "/run",
  "/usr",
  "/opt",
  "/srv",
  "/snap",
  "/var",
  "/var/data",
  "/var/lib",
  "/var/cache",
  "/var/tmp",
  "/tmp",
  "/root",
  "/home",
  "/mnt",
  "/media",
];
const directMountRoots = ["/mnt/volume_ams3_123", "/media/attached-disk"];
const disposableParent = process.env.SUBSCRIPTION_RUNTIME_TEST_TMPDIR ?? tmpdir();

let disposableDir;
let fakeFind;
let fakeRg;
let fakeGrep;
let findTarget;
let rgTarget;
let grepTarget;
let baseEnv;

beforeEach(async () => {
  disposableDir = await mkdtemp(join(disposableParent, "subscription-runtime-scan-guard-test-"));
  fakeFind = await writeExecutable("find.real", delegatedExecutable());
  fakeRg = await writeExecutable("rg.real", delegatedExecutable());
  fakeGrep = await writeExecutable("grep.real", delegatedExecutable());
  findTarget = await writeTarget("find.target");
  rgTarget = await writeTarget("rg.target");
  grepTarget = await writeTarget("grep.target");
  baseEnv = {
    ...process.env,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_WRAPPER: wrapper,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_REAL: fakeFind,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL: fakeRg,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_REAL: fakeGrep,
  };
});

afterEach(async () => {
  await rm(disposableDir, { recursive: true, force: true });
});

async function writeExecutable(name, contents) {
  const path = join(disposableDir, name);
  await writeFile(path, contents, { mode: 0o755 });
  return path;
}

async function writeTarget(name) {
  const path = join(disposableDir, name);
  await writeFile(path, "mount target\n");
  return path;
}

function delegatedExecutable() {
  return "#!/bin/sh\nprintf 'delegated:%s\\n' \"$*\"\n";
}

async function runGuard(tool, args) {
  return execFile(join(integrationDir, "bin", tool), args, { env: baseEnv });
}

async function expectBlocked(tool, args, root) {
  await assert.rejects(runGuard(tool, args), (error) => {
    assert.equal(error.code, 64);
    assert.match(error.stderr, /subscription_runtime_global_scan_blocked/);
    assert.match(error.stderr, new RegExp(`tool=${tool}(?: |$)`));
    assert.ok(error.stderr.includes(`root=${root} `));
    assert.match(error.stderr, /remediation=search an assigned workspace\/job descendant/);
    assert.match(error.stderr, /exit_code=64/);
    return true;
  });
}

async function expectDelegated(tool, args) {
  assert.match((await runGuard(tool, args)).stdout, /^delegated:/);
}

function launcherEnv(fakeBwrap, overrides = {}) {
  return {
    ...process.env,
    SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_BWRAP: fakeBwrap,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_SOURCE: fakeFind,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_SOURCE: fakeRg,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_SOURCE: fakeGrep,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_TARGET: findTarget,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_TARGET: rgTarget,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_TARGET: grepTarget,
    ...overrides,
  };
}

function readMountPlan(stdout) {
  const args = stdout.trim().split("\n");
  const mounts = args.flatMap((value, index) =>
    value === "--ro-bind" ? [[args[index + 1], args[index + 2]]] : [],
  );
  return { args, mounts };
}

function spawnWithInput(command, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        pid: child.pid,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

describe("hosted Codex global scan argument guards", () => {
  for (const root of blockedRoots) {
    it(`blocks find rooted at ${root}`, async () => {
      await expectBlocked("find", [root, "-name", "needle"], root);
    });

    it(`blocks rg rooted at ${root}`, async () => {
      await expectBlocked("rg", ["needle", root], root);
      await expectBlocked("rg", ["--files", root], root);
    });

    it(`blocks recursive grep rooted at ${root}`, async () => {
      await expectBlocked("grep", ["-r", "needle", root], root);
      await expectBlocked("grep", ["-R", "needle", root], root);
      await expectBlocked("grep", ["--recursive", "needle", root], root);
    });
  }

  for (const root of directMountRoots) {
    it(`blocks find rooted at direct mount root ${root}`, async () => {
      await expectBlocked("find", [root, "-name", "needle"], root);
    });

    it(`blocks rg rooted at direct mount root ${root}`, async () => {
      await expectBlocked("rg", ["needle", root], root);
      await expectBlocked("rg", ["--files", root], root);
    });

    it(`blocks recursive grep rooted at direct mount root ${root}`, async () => {
      await expectBlocked("grep", ["-r", "needle", root], root);
      await expectBlocked("grep", ["--recursive", "needle", root], root);
    });
  }

  it("blocks any broad find root in a multi-root invocation", async () => {
    await expectBlocked("find", [join(disposableDir, "job"), "/usr", "-type", "f"], "/usr");
  });

  it("blocks equivalent roots with lexical separators", async () => {
    await expectBlocked("find", ["/tmp///", "-type", "f"], "/tmp///");
    await expectBlocked("rg", ["needle", "/var/data/"], "/var/data/");
    await expectBlocked("find", ["/tmp/job/..", "-type", "f"], "/tmp/job/..");
    await expectBlocked("rg", ["needle", "/usr/./"], "/usr/./");
    await expectBlocked("grep", ["-r", "needle", "/opt/./"], "/opt/./");
    await expectBlocked("find", ["/mnt/volume/jobs/..", "-type", "f"], "/mnt/volume/jobs/..");
    await expectBlocked("rg", ["needle", "/media/./disk//"], "/media/./disk//");
    await expectBlocked("grep", ["-r", "needle", "/mnt/volume/./"], "/mnt/volume/./");
  });

  it("parses recursive grep flags in clusters and around operands", async () => {
    await expectBlocked("grep", ["-rni", "needle", "/tmp"], "/tmp");
    await expectBlocked("grep", ["-inR", "needle", "/root"], "/root");
    await expectBlocked("grep", ["-rne", "needle", "/home"], "/home");
    await expectBlocked("grep", ["needle", "/opt", "-r"], "/opt");
    await expectBlocked("grep", ["--regexp=needle", "--recursive", "/usr"], "/usr");
    await expectBlocked("grep", ["-r", "needle", "--", "/var/data"], "/var/data");
    await expectBlocked("grep", ["--dereference-recursive", "needle", "/tmp"], "/tmp");
    await expectBlocked("grep", ["--directories", "recurse", "needle", "/tmp"], "/tmp");
    await expectBlocked("grep", ["-drecurse", "needle", "/tmp"], "/tmp");
  });

  it("allows descendants and ordinary current-directory searches", async () => {
    await expectDelegated("find", ["/tmp/job-123", "-type", "f"]);
    await expectDelegated("find", [".", "-type", "f"]);
    await expectDelegated("rg", ["needle", "/var/data/jobs/123"]);
    await expectDelegated("rg", ["needle"]);
    await expectDelegated("grep", ["-r", "needle", "/tmp/job-123"]);
    await expectDelegated("grep", ["-r", "needle", "."]);
    await expectDelegated("find", ["/mnt/volume_ams3_123/jobs/task", "-type", "f"]);
    await expectDelegated("rg", ["needle", "/media/attached-disk/jobs/task"]);
    await expectDelegated("grep", ["-r", "needle", "/mnt/volume_ams3_123/jobs/task"]);
  });

  it("does not confuse find or rg patterns and option values with roots", async () => {
    await expectDelegated("find", [".", "-path", "/tmp"]);
    await expectDelegated("rg", ["/tmp"]);
    await expectDelegated("rg", ["-e", "/tmp", "."]);
    await expectDelegated("rg", ["--glob", "/tmp", "needle", "."]);
    await expectDelegated("rg", ["-ug/tmp", "needle", "."]);
    await expectDelegated("rg", ["--hostname-bin", "/tmp", "needle", "."]);
    await expectDelegated("find", [".", "-path", "/mnt/volume_ams3_123"]);
    await expectDelegated("rg", ["/mnt/volume_ams3_123"]);
    await expectDelegated("rg", ["-e", "/media/attached-disk", "."]);
  });

  it("parses explicit rg patterns inside short option clusters", async () => {
    await expectBlocked("rg", ["-uefoo", "/tmp"], "/tmp");
    await expectBlocked("rg", ["-nfe", "/usr"], "/usr");
    await expectBlocked("rg", ["-Ue", "needle", "/opt"], "/opt");
    await expectBlocked("rg", ["/tmp", "-e", "needle", "."], "/tmp");
    await expectBlocked("rg", ["/root", "--files"], "/root");
  });

  it("allows benign grep patterns, option values, ordinary files, and descendants", async () => {
    await expectDelegated("grep", ["-r", "/tmp"]);
    await expectDelegated("grep", ["-r", "--", "/tmp"]);
    await expectDelegated("grep", ["-r", "/tmp", "."]);
    await expectDelegated("grep", ["-r", "-e", "/tmp", "."]);
    await expectDelegated("grep", ["-r", "-f", "/tmp", "."]);
    await expectDelegated("grep", ["-r", "--include", "/tmp", "needle", "."]);
    await expectDelegated("grep", ["-r", "--exclude-dir=/tmp", "needle", "."]);
    await expectDelegated("grep", ["-er", "/tmp"]);
    await expectDelegated("grep", ["needle", "/tmp"]);
    await expectDelegated("grep", ["-r", "needle", "/tmp/ordinary-file"]);
    await expectDelegated("grep", ["-d", "skip", "needle", "/tmp"]);
    await expectDelegated("grep", ["-r", "/mnt/volume_ams3_123"]);
    await expectDelegated("grep", ["-r", "-e", "/media/attached-disk", "."]);
  });
});

describe("hosted Codex global scan namespace launch", () => {
  it("keeps the production mount-target defaults canonical", async () => {
    const source = await readFile(launcher, "utf8");

    assert.match(source, /readonly find_target="\$\{SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_TARGET:-\/usr\/bin\/find\}"/);
    assert.match(source, /readonly rg_target="\$\{SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_TARGET:-\/usr\/bin\/rg\}"/);
    assert.match(source, /readonly grep_target="\$\{SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_TARGET:-\/usr\/bin\/grep\}"/);
  });

  it("refuses launcher use outside the new hosted Codex sandbox scope", async () => {
    await assert.rejects(execFile(launcher, ["/bin/true"], { env: process.env }), { code: 64 });
    await assert.rejects(execFile(hostLauncher, ["/bin/true"], { env: process.env }), { code: 64 });
    await assert.rejects(execFile(guardedCodex, ["--version"], { env: process.env }), { code: 64 });
  });

  it("builds a namespace plan that intercepts PATH and all absolute executables", async () => {
    const fakeBwrap = await writeExecutable("bwrap", "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    const result = await execFile(launcher, ["/opt/codex/bin/codex", "app-server"], {
      env: launcherEnv(fakeBwrap),
    });
    const { args, mounts } = readMountPlan(result.stdout);

    assert.ok(mounts.some((pair) => pair[0] === join(integrationDir, "bin/find") && pair[1] === findTarget));
    assert.ok(mounts.some((pair) => pair[0] === join(integrationDir, "bin/rg") && pair[1] === rgTarget));
    assert.ok(mounts.some((pair) => pair[0] === join(integrationDir, "bin/grep") && pair[1] === grepTarget));
    assert.ok(mounts.some((pair) => pair[0] === fakeFind && pair[1] === join(integrationDir, "private/find.real")));
    assert.ok(mounts.some((pair) => pair[0] === fakeRg && pair[1] === join(integrationDir, "private/rg.real")));
    assert.ok(mounts.some((pair) => pair[0] === fakeGrep && pair[1] === join(integrationDir, "private/grep.real")));
    assert.ok(args.includes(join(integrationDir, "bin") + ":" + process.env.PATH));
    assert.ok(args.includes("--die-with-parent"));
    assert.ok(!args.includes("--new-session"));
    assert.deepEqual(args.slice(-3), ["--", "/opt/codex/bin/codex", "app-server"]);
  });

  it("copies a same-file source and target before overlaying the target with the guard", async () => {
    const fakeBwrap = await writeExecutable("bwrap", "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    const result = await execFile(launcher, ["/bin/true"], {
      env: launcherEnv(fakeBwrap, {
        SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_TARGET: fakeFind,
      }),
    });
    const { args } = readMountPlan(result.stdout);
    const privateMountIndex = args.findIndex((argument, index) =>
      argument === "--ro-bind"
      && args[index + 1] === fakeFind
      && args[index + 2] === join(integrationDir, "private/find.real")
    );
    const guardMountIndex = args.findIndex((argument, index) =>
      argument === "--ro-bind"
      && args[index + 1] === join(integrationDir, "bin/find")
      && args[index + 2] === fakeFind
    );

    assert.ok(privateMountIndex >= 0, "the real executable is mounted at its private path");
    assert.ok(guardMountIndex >= 0, "the guard is mounted over the original target");
    assert.ok(privateMountIndex < guardMountIndex, "the private real mount precedes the guard overlay");
  });

  it("routes an explicit --codex-binary codex through the guarded entrypoint", async () => {
    const fakeBwrap = await writeExecutable("bwrap", "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    const fakeCodex = await writeExecutable("codex.real", delegatedExecutable());
    const fakeHost = await writeExecutable("subscription-runtime-host", `#!/bin/sh
codex_binary=codex
while [ "$#" -gt 0 ]; do
  if [ "$1" = --codex-binary ]; then
    codex_binary=$2
    shift 2
  else
    shift
  fi
done
exec "$codex_binary" app-server --listen stdio://
`);
    const result = await execFile(hostLauncher, [
      fakeHost,
      "--provider",
      "codex",
      "--codex-binary",
      "codex",
    ], {
      env: launcherEnv(fakeBwrap, {
        SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE: fakeCodex,
      }),
    });
    const { args } = readMountPlan(result.stdout);
    assert.deepEqual(args.slice(-5), ["--", fakeCodex, "app-server", "--listen", "stdio://"]);
  });

  it("preserves app-server stdio and the direct process identity", async () => {
    const fakeBwrap = await writeExecutable("bwrap", `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
[ "$#" -gt 0 ] && shift
exec "$@"
`);
    const fakeCodex = await writeExecutable("codex.real", `#!/bin/sh
IFS= read -r request
printf 'pid=%s args=%s request=%s\\n' "$$" "$*" "$request"
`);
    const fakeHost = await writeExecutable("subscription-runtime-host", `#!/bin/sh
exec codex app-server --listen stdio://
`);
    const result = await spawnWithInput(
      hostLauncher,
      [fakeHost, "--provider", "codex", "--codex-binary", "codex"],
      {
        detached: true,
        env: launcherEnv(fakeBwrap, {
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE: fakeCodex,
        }),
      },
      '{"method":"initialize"}\n',
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, new RegExp(`^pid=${result.pid} `));
    assert.match(result.stdout, /args=app-server --listen stdio:\/\//);
    assert.match(result.stdout, /request=\{"method":"initialize"\}/);
  });

  it("fails closed when a namespace prerequisite is unavailable", async () => {
    const fakeBwrap = await writeExecutable("bwrap", "#!/bin/sh\nexit 99\n");
    await assert.rejects(
      execFile(launcher, ["/bin/true"], {
        env: launcherEnv(fakeBwrap, {
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_SOURCE: join(disposableDir, "missing-grep"),
        }),
      }),
      (error) => {
        assert.equal(error.code, 70);
        assert.match(error.stderr, /subscription_runtime_global_scan_guard_prerequisite_missing/);
        return true;
      },
    );
    await assert.rejects(
      execFile(hostLauncher, ["/bin/true"], {
        env: launcherEnv(fakeBwrap),
      }),
      (error) => {
        assert.equal(error.code, 70);
        assert.match(error.stderr, /subscription_runtime_global_scan_guard_codex_source_unavailable/);
        return true;
      },
    );
  });

  it("fails closed for missing, non-file, non-absolute, or recursive mount targets", async () => {
    const fakeBwrap = await writeExecutable("bwrap", "#!/bin/sh\nexit 99\n");
    for (const target of [join(disposableDir, "missing-target"), disposableDir, "relative-target"]) {
      await assert.rejects(
        execFile(launcher, ["/bin/true"], {
          env: launcherEnv(fakeBwrap, {
            SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_TARGET: target,
          }),
        }),
        (error) => {
          assert.equal(error.code, 70);
          assert.match(error.stderr, /subscription_runtime_global_scan_guard_mount_target_missing/);
          return true;
        },
      );
    }

    await assert.rejects(
      execFile(launcher, ["/bin/true"], {
        env: launcherEnv(fakeBwrap, {
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_TARGET: join(integrationDir, "bin/rg"),
        }),
      }),
      (error) => {
        assert.equal(error.code, 70);
        assert.match(error.stderr, /subscription_runtime_global_scan_guard_recursive_target/);
        return true;
      },
    );
  });
});
