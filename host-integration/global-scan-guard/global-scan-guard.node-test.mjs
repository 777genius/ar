import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const sliceInstaller = join(
  integrationDir,
  "install-subscription-runtime-hosted-slice",
);
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
let baseEnv;

beforeEach(async () => {
  disposableDir = await mkdtemp(join(disposableParent, "subscription-runtime-scan-guard-test-"));
  fakeFind = await writeExecutable("find.real", delegatedExecutable());
  fakeRg = await writeExecutable("rg.real", delegatedExecutable());
  fakeGrep = await writeExecutable("grep.real", delegatedExecutable());
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

function launcherEnv(overrides = {}) {
  return {
    ...process.env,
    SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_SOURCE: fakeFind,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_SOURCE: fakeRg,
    SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_SOURCE: fakeGrep,
    ...overrides,
  };
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

  it("blocks a broad find root after the option terminator", async () => {
    await expectBlocked("find", ["--", "/", "-type", "f"], "/");
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

describe("hosted Codex global scan launch", () => {
  it("installs the reviewed slice with a generated all-device drop-in", async () => {
    const repositoryRoot = join(disposableDir, "repository");
    const generatorDir = join(
      repositoryRoot,
      "dist/provider-codex/app-server/adapters",
    );
    const unitDir = join(disposableDir, "systemd");
    const systemctlLog = join(disposableDir, "systemctl.log");
    await mkdir(generatorDir, { recursive: true });
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(generatorDir, "print-hosted-aggregate-io-drop-in.js"),
      'process.stdout.write("[Slice]\\nIOReadBandwidthMax=/ 120M\\nIOReadIOPSMax=/ 8000\\nIOWriteBandwidthMax=/ 60M\\nIOWriteIOPSMax=/ 4000\\n");\n',
    );
    const fakeUnshare = await writeExecutable("unshare", "#!/bin/sh\nexit 0\n");
    const fakeSetpriv = await writeExecutable("setpriv", "#!/bin/sh\nexit 0\n");
    const fakeSystemctl = await writeExecutable(
      "systemctl",
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    );

    await execFile(sliceInstaller, [], {
      env: {
        ...process.env,
        SUBSCRIPTION_RUNTIME_REPOSITORY_ROOT: repositoryRoot,
        SUBSCRIPTION_RUNTIME_SYSTEMD_UNIT_DIR: unitDir,
        SUBSCRIPTION_RUNTIME_SYSTEMCTL_PATH: fakeSystemctl,
        SUBSCRIPTION_RUNTIME_UNSHARE_PATH: fakeUnshare,
        SUBSCRIPTION_RUNTIME_SETPRIV_PATH: fakeSetpriv,
      },
    });

    assert.match(
      await readFile(join(unitDir, "subscription-runtime-hosted.slice"), "utf8"),
      /CPUQuota=500%/,
    );
    assert.equal(
      await readFile(
        join(
          unitDir,
          "subscription-runtime-hosted.slice.d/20-io-limits.conf",
        ),
        "utf8",
      ),
      "[Slice]\nIOReadBandwidthMax=/ 120M\nIOReadIOPSMax=/ 8000\nIOWriteBandwidthMax=/ 60M\nIOWriteIOPSMax=/ 4000\n",
    );
    assert.equal(
      await readFile(systemctlLog, "utf8"),
      "daemon-reload\nstart subscription-runtime-hosted.slice\nis-active --quiet subscription-runtime-hosted.slice\n",
    );
  });

  it("does not nest the Codex provider sandbox inside another mount namespace", async () => {
    const source = await readFile(launcher, "utf8");

    assert.doesNotMatch(source, /bwrap|--ro-bind|--bind \/ \//);
    assert.match(source, /export PATH="\$\{integration_dir\}\/bin:\$\{PATH\}"/);
    assert.match(source, /readonly-test-supervisor\.mjs" legacy -- "\$@"/);
  });

  it("refuses launcher use outside the new hosted Codex sandbox scope", async () => {
    const outsideHostedEnv = { ...process.env };
    delete outsideHostedEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND;
    await assert.rejects(execFile(launcher, ["/bin/true"], { env: outsideHostedEnv }), { code: 64 });
    await assert.rejects(execFile(hostLauncher, ["/bin/true"], { env: outsideHostedEnv }), { code: 64 });
    await assert.rejects(execFile(guardedCodex, ["--version"], { env: outsideHostedEnv }), { code: 64 });
  });

  it("preserves the PATH scan guard inside the contained provider namespace", async () => {
    const scan = await writeExecutable("scan", "#!/bin/sh\nexec rg --files /\n");
    // This suite runs both on a developer host and inside an existing hosted
    // namespace. The latter may run a nested shim; the former must be denied.
    const nested = process.getuid?.() === 65532 && process.getgid?.() === 65532 &&
      (await readFile("/proc/self/uid_map", "utf8")).trim().replace(/\s+/g, " ") === "65532 0 1";
    await assert.rejects(
      execFile(launcher, [scan], { env: launcherEnv() }),
      (error) => {
        assert.equal(error.code, nested ? 64 : 70);
        assert.match(error.stderr, nested
          ? /subscription_runtime_global_scan_blocked tool=rg root=\//
          : /hosted_custody_launch_denied/);
        assert.equal(error.stdout, "");
        return true;
      },
    );
  });

  it("does not let --codex-binary codex bypass the common host fence", async () => {
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
    await assert.rejects(execFile(hostLauncher, [
      fakeHost,
      "--provider",
      "codex",
      "--codex-binary",
      "codex",
    ], {
      env: launcherEnv({
        SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE: fakeCodex,
      }),
    }), error => {
      assert.equal(error.code, 70);
      assert.match(error.stderr, /hosted_custody_launch_denied/);
      assert.equal(error.stdout, "");
      return true;
    });
  });

  it("rejects an unadmitted app-server before consuming its protocol input", async () => {
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
        env: launcherEnv({
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE: fakeCodex,
        }),
      },
      '{"method":"initialize"}\n',
    );

    assert.equal(result.code, 70, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /hosted_custody_launch_denied/);
  });

  it("fails closed when an executable prerequisite is unavailable", async () => {
    await assert.rejects(
      execFile(launcher, ["/bin/true"], {
        env: launcherEnv({
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
      execFile(hostLauncher, [process.execPath], {
        env: launcherEnv(),
      }),
      (error) => {
        assert.equal(error.code, 70);
        assert.match(error.stderr, /subscription_runtime_global_scan_guard_codex_source_unavailable/);
        return true;
      },
    );
  });

  it("fails closed when a wrapper is configured as its own real executable", async () => {
    await assert.rejects(
      execFile(launcher, ["/bin/true"], {
        env: launcherEnv({
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_SOURCE: join(integrationDir, "bin/rg"),
        }),
      }),
      (error) => {
        assert.equal(error.code, 70);
        assert.match(error.stderr, /subscription_runtime_global_scan_guard_recursive_source/);
        return true;
      },
    );
  });
});
