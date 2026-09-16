import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
} from "../codex-goal-jobs";
import {
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
} from "../application/project-control/codex-goal-project-pre-start-admission";

const roots: string[] = [];

export async function cleanupProjectPreStartAdmissionFixtures(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

export async function prepareBuiltin(
  fixture: Awaited<ReturnType<typeof createBuiltinFixture>>,
  overrides: Record<string, unknown>,
) {
  const contract = (overrides.contract ?? fixture.contract) as Record<string, unknown>;
  const state = overrides.state ?? {
    ...fixture.state,
    records: fixture.state.records.map((record) => ({
      ...record,
      ...Object.fromEntries(Object.keys(record).map((field) => [
        field,
        field in contract ? contract[field] : record[field as keyof typeof record],
      ])),
      status: "queued",
      supersededBy: null,
      supersededFrom: null,
    })),
  };
  const plan = fixture.plan({ ...overrides, contract, state });
  return prepareProjectPreStartAdmission({
    plan,
    manifest: { ...fixture.manifest, projectPreStartAdmission: plan.descriptor },
    scope: fixture.scope,
  });
}

export async function createBuiltinFixture() {
  const base = await createFixture();
  await mkdir(join(base.workspacePath, "sandbox"));
  await writeFile(join(base.workspacePath, "controller.md"), "controller\n");
  await writeFile(join(base.workspacePath, "lane.md"), "lane\n");
  execFileSync("git", ["add", "controller.md", "lane.md"], { cwd: base.workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: packets"], {
    cwd: base.workspacePath,
  });
  const phaseStartSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: base.workspacePath,
    encoding: "utf8",
  }).trim();
  const contract = withWorkKey({
    kind: "worker-launch",
    format: 1,
    ...base.contract,
    canonicalSha: phaseStartSha,
    baseSha: phaseStartSha,
    phaseStartSha,
    packetRevision: "phase-01-s0-r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    ownedPaths: ["src/example.ts"],
    mandatoryDocs: ["README.md", "controller.md", "lane.md"],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [{
      id: "focused",
      cwd: "scripts",
      command: "node --check contract-validator.mjs",
    }],
    executionPolicy: {
      mode: "sandbox-only",
      sandboxRoot: join(base.workspacePath, "sandbox"),
      forbiddenRealProjects: [join(base.root, "forbidden-project")],
    },
  });
  const stateIdentityFields = [
    "workKey",
    "jobId",
    "workerId",
    "phaseId",
    "laneId",
    "baseSha",
    "phaseStartSha",
    "packetRevision",
    "controllerPacket",
    "lanePacket",
    "inputPatchHash",
    "reviewKind",
    "revision",
    "retryCount",
    "supersedes",
  ] as const;
  const stateRecord = Object.fromEntries(
    stateIdentityFields.map((field) => [field, contract[field]]),
  );
  const state = {
    schemaVersion: 1,
    maxRetries: 2,
    maxInFlight: 1,
    records: [{ ...stateRecord, status: "queued", supersededBy: null, supersededFrom: null }],
  };
  const scope: ProjectAccessScope = {
    projectId: "project",
    deniedRoots: [join(base.root, "denied")],
    preStartAdmission: {
      required: true,
      mode: "serial-builtin",
    },
  };
  return {
    ...base,
    contract,
    state,
    scope,
    plan(overrides: Record<string, unknown> = {}) {
      return planProjectPreStartAdmission({
        value: {
          mode: "serial-builtin",
          contract,
          state,
          ...overrides,
        },
        confirmed: true,
        scope,
        manifest: base.manifest,
      })!;
    },
  };
}

export function withWorkKey<T extends Record<string, unknown>>(
  contract: T,
): T & { workKey: string } {
  const workKey = sha256(Buffer.from(JSON.stringify({
    kind: contract.kind,
    format: contract.format,
    phaseId: contract.phaseId,
    laneId: contract.laneId,
    baseSha: contract.baseSha,
    phaseStartSha: contract.phaseStartSha,
    packetRevision: contract.packetRevision,
    inputPatchHash: contract.inputPatchHash,
    reviewKind: contract.reviewKind,
    revision: contract.revision,
  })));
  return { ...contract, workKey };
}

export function withOwnershipBoundWorkKey<T extends Record<string, unknown>>(
  contract: T,
): T & { workKey: string } {
  const workKey = sha256(Buffer.from(JSON.stringify({
    kind: contract.kind,
    format: contract.format,
    phaseId: contract.phaseId,
    laneId: contract.laneId,
    baseSha: contract.baseSha,
    phaseStartSha: contract.phaseStartSha,
    packetRevision: contract.packetRevision,
    inputPatchHash: contract.inputPatchHash,
    reviewKind: contract.reviewKind,
    ownedPaths: contract.ownedPaths,
    revision: contract.revision,
    merge: contract.merge,
  })));
  return { ...contract, workKey };
}

export function declarativeContract(
  contract: Record<string, unknown>,
): Record<string, unknown> {
  const computed = new Set([
    "jobId",
    "workerId",
    "registryStatus",
    "jobRoot",
    "workspaceRoot",
    "promptPath",
    "workKey",
    "revision",
    "retryCount",
    "supersedes",
  ]);
  return Object.fromEntries(
    Object.entries(contract).filter(([field]) => !computed.has(field)),
  );
}

export async function createFixture(
  options: { readonly admissionValidatorBody?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "project-pre-start-admission-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "jobs", "project-worker");
  await mkdir(join(workspacePath, "scripts"), { recursive: true });
  await mkdir(jobRootDir, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspacePath,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: fixture"], {
    cwd: workspacePath,
  });

  const contractValidatorPath = join(
    workspacePath,
    "scripts",
    "contract-validator.mjs",
  );
  const admissionValidatorPath = join(
    workspacePath,
    "scripts",
    "admission-validator.mjs",
  );
  await writeFile(
    contractValidatorPath,
    `
import { readFileSync } from "node:fs";
const path = process.argv[process.argv.indexOf("--contract") + 1];
JSON.parse(readFileSync(path, "utf8"));
`,
  );
  await writeFile(
    admissionValidatorPath,
    options.admissionValidatorBody ??
      `
import { readFileSync } from "node:fs";
const contract = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--contract") + 1], "utf8"));
const state = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--state") + 1], "utf8"));
if (state.records.filter((record) => record.workKey === contract.workKey).length !== 1) process.exit(2);
`,
  );
  execFileSync("git", ["add", "scripts"], { cwd: workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: validators"], {
    cwd: workspacePath,
  });
  const workspaceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
  }).trim();
  const contractValidatorSha = sha256(await readFile(contractValidatorPath));
  const admissionValidatorSha = sha256(await readFile(admissionValidatorPath));
  const promptPath = join(jobRootDir, "prompt.md");
  await writeFile(promptPath, "bounded prompt\n");
  const manifest: CodexGoalJobManifestInput = {
    jobId: "project-worker",
    jobRootDir,
    workspacePath,
    promptPath,
    taskId: "project-worker",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    networkAccess: NetworkAccessMode.Restricted,
  };
  const storedManifest: CodexGoalJobManifest = {
    ...manifest,
    schemaVersion: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const contract = {
    jobId: manifest.jobId,
    workerId: "worker-1",
    jobRoot: jobRootDir,
    workspaceRoot: workspacePath,
    promptPath,
    registryStatus: "queued",
    workKey: "a".repeat(64),
    phaseId: "phase-01",
    laneId: "p1-s0",
    baseSha: "b".repeat(40),
    phaseStartSha: workspaceHead,
    packetRevision: "r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    inputPatchHash: sha256(Buffer.alloc(0)),
    reviewKind: "implementation",
    revision: 0,
    retryCount: 0,
    supersedes: null,
  };
  const state = {
    schemaVersion: 1,
    maxRetries: 0,
    maxInFlight: 1,
    records: [{ ...contract, status: "queued", registryStatus: undefined }],
  };
  const scope: ProjectAccessScope = {
    projectId: "project",
    preStartAdmission: {
      required: true,
      mode: "serial",
      validatorBundle: [
        {
          path: "scripts/contract-validator.mjs",
          sha256: contractValidatorSha,
        },
        {
          path: "scripts/admission-validator.mjs",
          sha256: admissionValidatorSha,
        },
      ],
    },
  };
  return {
    root,
    workspacePath,
    contractValidatorPath,
    contractValidatorSha,
    admissionValidatorSha,
    manifest,
    storedManifest,
    contract,
    state,
    scope,
    plan(overrides: Record<string, unknown> = {}, selectedScope = scope) {
      return planProjectPreStartAdmission({
        value: {
          contractValidatorPath: "scripts/contract-validator.mjs",
          admissionValidatorPath: "scripts/admission-validator.mjs",
          contract,
          state,
          ...overrides,
        },
        confirmed: true,
        scope: selectedScope,
        manifest,
      })!;
    },
  };
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
