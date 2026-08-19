import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
const { LocalProjectControlEvidenceCustody } = await import(
  // @ts-expect-error Direct Node transform-types execution requires this suffix.
  "../project-control-evidence-custody-local-adapter.ts"
);

const root = required("CUSTODY_FIXTURE_ROOT");
const operation = required("CUSTODY_FIXTURE_OPERATION");
const crashPoint = process.env.CUSTODY_FIXTURE_CRASH_POINT;
const bytes = Buffer.from("durable publication bytes\n");
const sourcePath = operation === "copy"
  ? required("CUSTODY_FIXTURE_SOURCE")
  : undefined;
const expected = sourcePath === undefined ? bytes : await readFile(sourcePath);
const proofPath = process.env.CUSTODY_FIXTURE_PROOF_PATH;
if (process.env.CUSTODY_FIXTURE_HANG === "1") {
  setInterval(() => undefined, 1_000);
  await new Promise<never>(() => undefined);
}
const custody = new LocalProjectControlEvidenceCustody(async (point, path) => {
  if (point === "after_publish_before_directory_fsync") {
    const temporaryNames = (await readdir(dirname(path))).filter((name) =>
      name.startsWith(".custody-publish-") && name.endsWith(".tmp")
    );
    if (temporaryNames.length === 0) throw new Error("temporary_binding_unproven");
    const [publishedStat, temporaryStats, publishedBytes] = await Promise.all([
      stat(path),
      Promise.all(temporaryNames.map(async (name) =>
        await stat(`${dirname(path)}/${name}`)
      )),
      readFile(path),
    ]);
    const boundTemps = temporaryStats.filter((temporaryStat) =>
      publishedStat.dev === temporaryStat.dev &&
      publishedStat.ino === temporaryStat.ino
    );
    if (boundTemps.length !== 1 ||
      sha(publishedBytes) !== sha(expected)) {
      throw new Error("published_binding_unproven");
    }
  }
  if (point === "after_ancestor_parent_fsync" && proofPath) {
    await appendFile(proofPath, `${path}\n`);
  }
  if (point === crashPoint) process.kill(process.pid, "SIGKILL");
});

if (operation === "bytes") {
  await custody.publishImmutableBytes({
    root,
    directories: ["one", "two"],
    fileName: "evidence.bin",
    bytes,
    expectedSha256: sha(bytes),
  });
} else if (operation === "copy") {
  await custody.copyImmutableFile({
    sourcePath: sourcePath!,
    expectedSha256: sha(expected),
    expectedLength: expected.length,
    maxBytes: 1024 * 1024,
    root,
    directories: ["copy", "nested"],
    fileName: "copy.bin",
  });
} else {
  throw new Error("unknown fixture operation");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
