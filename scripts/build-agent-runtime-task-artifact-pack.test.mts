import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildNpmEnvironment, resolveNpmPackTarball } from "./build-agent-runtime-task-artifact.mjs";

const unsafeFilename = /npm pack returned an unsafe artifact filename/u;

test("clean npm builds retain proxy routing and additional trusted CAs without inheriting configuration or secrets", () => {
  const parentEnvironment = {
    PATH: "/usr/bin",
    HOME: "/parent/home",
    TMPDIR: "/parent/tmp",
    LANG: "C.UTF-8",
    HTTP_PROXY: "http://upper-http.example:8080",
    http_proxy: "http://lower-http.example:8080",
    HTTPS_PROXY: "http://upper-https.example:8080",
    https_proxy: "http://lower-https.example:8080",
    NO_PROXY: "upper.example",
    no_proxy: "lower.example",
    NODE_EXTRA_CA_CERTS: "/trusted/transport-ca.pem",
    NPM_TOKEN: "synthetic-npm-secret",
    NODE_AUTH_TOKEN: "synthetic-auth-secret",
    OPENAI_API_KEY: "synthetic-provider-secret",
    npm_config_registry: "https://untrusted.example",
    NPM_CONFIG_REGISTRY: "https://untrusted-upper.example",
    npm_config_userconfig: "/parent/npmrc",
    NPM_CONFIG_USERCONFIG: "/parent/upper-npmrc",
    npm_config_cache: "/parent/cache",
    npm_config_ignore_scripts: "false",
    NODE_OPTIONS: "--require=/parent/injected.cjs",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    npm_config_strict_ssl: "false",
    NPM_CONFIG_STRICT_SSL: "false",
    npm_config_cafile: "/parent/npm-ca.pem",
    SSL_CERT_FILE: "/parent/openssl-ca.pem",
  };
  assert.deepEqual(buildNpmEnvironment("/clean/build", "/clean/home", "/clean/tmp", parentEnvironment), {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    HTTP_PROXY: "http://upper-http.example:8080",
    http_proxy: "http://lower-http.example:8080",
    HTTPS_PROXY: "http://upper-https.example:8080",
    https_proxy: "http://lower-https.example:8080",
    NO_PROXY: "upper.example",
    no_proxy: "lower.example",
    NODE_EXTRA_CA_CERTS: "/trusted/transport-ca.pem",
    HOME: "/clean/home",
    TMPDIR: "/clean/tmp",
    npm_config_audit: "false",
    npm_config_cache: "/clean/build/npm-cache",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: "/dev/null",
  });
});

test("clean npm transport forwarding preserves an empty no-proxy value and omits unset values", () => {
  const environment = buildNpmEnvironment("/clean/build", "/clean/home", "/clean/tmp", { NO_PROXY: "" });
  assert.equal(environment.NO_PROXY, "");
  for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"]) {
    assert.equal(Object.hasOwn(environment, key), false, key);
  }
});

test("production artifact caller forwards only the isolated transport environment to every npm subprocess", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "artifact-npm-caller-"));
  try {
    const repository = join(scratch, "repository"), bin = join(scratch, "bin");
    const home = join(scratch, "home"), temporary = join(scratch, "tmp");
    for (const directory of [join(repository, "scripts"), bin, home, temporary]) await mkdir(directory, { recursive: true });
    // Copy the current production module so real clean-Git checks can run in
    // a tiny committed repository even while the working checkout is dirty.
    const builder = join(repository, "scripts", "build-agent-runtime-task-artifact.mjs");
    await writeFile(builder, await readFile(new URL("./build-agent-runtime-task-artifact.mjs", import.meta.url)));
    await writeFile(join(repository, "package.json"), '{"name":"artifact-caller-fixture","version":"1.0.0"}\n');
    const captures = join(scratch, "npm-environments.jsonl"), caFile = join(scratch, "transport-ca.pem");
    await writeFile(caFile, "");
    // Only npm is substituted. Real child processes record their received
    // environments; real git/archive/tar and all payload assertions still run.
    await writeFile(join(bin, "npm"), `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(captures)}, JSON.stringify({ args, cwd: process.cwd(), environment: process.env }) + "\\n");
if (args[0] === "pack") {
  const packageRoot = join(process.env.TMPDIR, "fixture-payload", "package");
  const files = {
    "package.json": '{"name":"artifact-caller-fixture","version":"1.0.0"}',
    "dist/worker-local/agent-runtime-task-runner-cli.js": "// synthetic caller-test entrypoint\\n",
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json": '{"version":"0.3.237","claudeCodeVersion":"2.1.237"}',
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json": '{"version":"0.3.237"}',
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(packageRoot, name)), { recursive: true });
    writeFileSync(join(packageRoot, name), bytes);
  }
  const filename = "artifact-caller-fixture.tgz";
  const destination = args[args.indexOf("--pack-destination") + 1];
  const packed = spawnSync("tar", ["-czf", join(destination, filename), "-C", dirname(packageRoot), "package"], { encoding: "utf8" });
  if (packed.error || packed.status !== 0) throw new Error(packed.error?.message ?? packed.stderr);
  process.stdout.write(JSON.stringify([{ filename }]));
}
`, { mode: 0o755 });
    const baseEnvironment = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, TMPDIR: temporary, LANG: "C" };
    const run = (command: string, args: string[], cwd = repository) => {
      const result = spawnSync(command, args, { cwd, env: baseEnvironment, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    run("git", ["init", "--quiet"]);
    run("git", ["add", "package.json", "scripts"]);
    run("git", ["-c", "user.name=Artifact Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    const sourceGitSha = run("git", ["rev-parse", "HEAD"]).trim();
    const sourceGitTree = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
    const transport = { HTTP_PROXY: "http://upper-http.example:8080", http_proxy: "http://lower-http.example:8080",
      HTTPS_PROXY: "http://upper-https.example:8080", https_proxy: "http://lower-https.example:8080",
      NO_PROXY: "upper.example", no_proxy: "", NODE_EXTRA_CA_CERTS: caFile };
    const ambient = { ...transport, NPM_TOKEN: "synthetic-npm-secret", NODE_AUTH_TOKEN: "synthetic-auth-secret",
      OPENAI_API_KEY: "synthetic-provider-secret", npm_config_registry: "https://untrusted.example",
      npm_config_userconfig: "/parent/npmrc", npm_config_cache: "/parent/cache", npm_config_ignore_scripts: "false",
      NODE_OPTIONS: "--require=/parent/injected.cjs", NODE_TLS_REJECT_UNAUTHORIZED: "0", npm_config_strict_ssl: "false" };
    const outputPath = join(scratch, "artifact");
    const report = JSON.parse(run(process.execPath, ["--input-type=module", "-e", `
      import { buildAgentRuntimeTaskArtifact } from ${JSON.stringify(pathToFileURL(builder).href)};
      Object.assign(process.env, ${JSON.stringify(ambient)});
      process.stdout.write(JSON.stringify(await buildAgentRuntimeTaskArtifact({ outputPath: ${JSON.stringify(outputPath)} })));
    `])) as { sourceGitSha: string; sourceGitTree: string; sizeBytes: number };
    assert.equal(report.sourceGitSha, sourceGitSha);
    assert.equal(report.sourceGitTree, sourceGitTree);
    assert.equal((await readFile(outputPath)).length, report.sizeBytes);
    const received = (await readFile(captures, "utf8")).trim().split("\n").map(line =>
      JSON.parse(line) as { args: string[]; cwd: string; environment: Record<string, string> });
    assert.deepEqual(received.map(row => row.args.slice(0, row.args[0] === "run" ? 2 : 1)), [["ci"], ["run", "build"], ["pack"]]);
    const buildRoot = dirname(received[0]!.cwd);
    for (const row of received) {
      assert.equal(row.cwd, join(buildRoot, "source"));
      assert.deepEqual(row.environment, { PATH: baseEnvironment.PATH, LANG: "C", ...transport,
        HOME: join(buildRoot, "home"), TMPDIR: join(buildRoot, "tmp"), npm_config_audit: "false",
        npm_config_cache: join(buildRoot, "npm-cache"), npm_config_fund: "false", npm_config_ignore_scripts: "true",
        npm_config_userconfig: "/dev/null" });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

async function withPackRoot(run: (packRoot: string, scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "issue333-pack-test-"));
  try {
    const packRoot = join(scratch, "pack");
    await mkdir(packRoot);
    await run(packRoot, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("legacy and keyed reports resolve the same canonical artifact", async () => {
  await withPackRoot(async (packRoot) => {
    const filename = "public-test-1.0.0.tgz";
    await writeFile(join(packRoot, filename), "test payload");
    const expected = await realpath(join(packRoot, filename));
    for (const report of [[{ filename }], { "public-test": { filename } },
      { "@public/test": { filename } }]) {
      assert.equal(await resolveNpmPackTarball(packRoot, JSON.stringify(report)), expected);
    }
  });
});

test("rejects non-JSON, malformed reports and zero or multiple packages", async () => {
  await withPackRoot(async (packRoot) => {
    await assert.rejects(resolveNpmPackTarball(packRoot, "not JSON"), /non-JSON/u);
    const valid = { filename: "test.tgz" };
    const malformed: unknown[] = [null, true, 12, "test.tgz", [], {}, [null], [false],
      ["test.tgz"], [[]], [{}], [valid, valid], { one: valid, two: valid },
      { one: null }, { one: false }, { one: 12 }, { one: "test.tgz" },
      { one: [] }, { one: [valid] }, { one: {} }, { one: { report: valid } },
      { "": valid }, { " ": valid }, valid];
    for (const report of malformed) {
      await assert.rejects(resolveNpmPackTarball(packRoot, JSON.stringify(report)), unsafeFilename,
        JSON.stringify(report));
    }
  });
});

test("rejects invalid and unsafe filenames in both report formats", async () => {
  await withPackRoot(async (packRoot) => {
    const filenames: unknown[] = [null, false, 12, [], {}, "", " ", ".", "..",
      "/absolute.tgz", "../escape.tgz", "sub/file.tgz", "sub\\file.tgz",
      "..\\escape.tgz", "C:\\absolute.tgz", "C:/absolute.tgz", "nul\0.tgz"];
    for (const filename of filenames) {
      for (const report of [[{ filename }], { one: { filename } }]) {
        await assert.rejects(resolveNpmPackTarball(packRoot, JSON.stringify(report)), unsafeFilename,
          JSON.stringify(report));
      }
    }
  });
});

test("safe basename cannot escape through a real symlink or destination prefix sibling", async () => {
  await withPackRoot(async (packRoot, scratch) => {
    const sibling = join(scratch, "pack-sibling");
    await mkdir(sibling);
    const outside = join(sibling, "outside.tgz");
    await writeFile(outside, "outside payload");
    await symlink(outside, join(packRoot, "safe.tgz"));
    await symlink(packRoot, join(packRoot, "directory.tgz"));
    for (const filename of ["safe.tgz", "directory.tgz"]) {
      for (const report of [[{ filename }], { one: { filename } }]) {
        await assert.rejects(resolveNpmPackTarball(packRoot, JSON.stringify(report)), /escaped its destination/u);
      }
    }
  });
});

test("containment resolves a symlinked pack root canonically and requires an existing file", async () => {
  await withPackRoot(async (packRoot, scratch) => {
    const alias = join(scratch, "alias");
    await symlink(packRoot, alias);
    await writeFile(join(packRoot, "inside.tgz"), "inside payload");
    assert.equal(await resolveNpmPackTarball(alias, '[{"filename":"inside.tgz"}]'),
      await realpath(join(packRoot, "inside.tgz")));
    await assert.rejects(resolveNpmPackTarball(alias, '[{"filename":"missing.tgz"}]'), { code: "ENOENT" });
  });
});

// Provide the untouched stdout and destination from an actual disposable npm pack.
const realReport = process.env.ISSUE333_PACK_REPORT;
const realPackRoot = process.env.ISSUE333_PACK_ROOT;
test("accepts the retained actual npm12.2.0 pack stdout", { skip: !realReport || !realPackRoot }, async () => {
  assert.ok(realReport && realPackRoot);
  const stdout = await readFile(realReport, "utf8");
  assert.equal(await resolveNpmPackTarball(realPackRoot, stdout),
    await realpath(join(realPackRoot, "newtest-issue333-public-pack-test-1.0.0.tgz")));
});
