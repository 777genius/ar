import { z } from "zod";
import { validNarrowWorkerOwnedPaths } from "./application/project-control/worker-launch-ownership";
import { workerLaunchAdmissionSchema } from "./application/project-control/worker-launch-spec";
import { genericMimoAdmission, hasPinnedRequiredCheck, hostedMimoCommitIdentity } from "./hosted-mimo-project-admission";
import { assertHostedMimoWorkstreamDeclaration, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { configuredRepository, parseHostedMimoPreparationPlan } from "./hosted-mimo-project-bridge-prepare";
import { parseMimoProjectClientRoutes } from "./mimo-project-bridge-client";

const lineId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const absolute = z.string().regex(/^\/[^\u0000-\u001f]*$/);
const timeout = z.number().int().min(1000).max(86400000);
const peak = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** The short project card. Host constants are explicit input because a pure renderer cannot read the host.
 * The timeouts and the disk peak have no defaults: they must come from the runbook or a measurement. */
const cardSchema = z.object({
  projectId: z.string().regex(lineId), workstreamId: z.string().regex(lineId).optional(),
  repositoryUrl: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/).refine(branch => !branch.includes("..")),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  sandboxSubdir: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(path => path.split("/").every(part => part !== "." && part !== "..")),
  ownedPaths: z.array(z.string()).refine(validNarrowWorkerOwnedPaths, { message: "must be unique relative files or trailing-slash directories without globs or control characters" }),
  packet: z.enum(["AGENTS.md", "README.md"]).optional(), jobIdPrefix: z.string().optional(),
  taskTimeoutMs: timeout, appServerStartupTimeoutMs: timeout, operationTimeoutMs: timeout,
  diskPeak: z.object({ scratch: peak, durable: peak }).strict(),
  host: z.object({ alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/), machineId: z.string().regex(/^[a-f0-9]{32}$/),
    socketDir: absolute, authRootDir: absolute, codexBinaryPath: absolute }).strict(),
}).strict();

export type MimoAttachmentDefault = Readonly<{ field: string; value: unknown; reason: string }>;
export type MimoAttachmentRendering = Readonly<{
  workstreamYaml: Readonly<{ path: string; content: string }>;
  preparationPlan: Readonly<{ path: string; content: string }>;
  localRoute: Readonly<{ content: string }>;
  snapshot: Readonly<{ path: string; commands: readonly string[] }>;
  nextCommands: readonly string[];
  diskPeak: Readonly<{ scratchBytes: number; durableBytes: number; check: string }>;
  derivedDefaults: readonly MimoAttachmentDefault[];
}>;
export class MimoAttachmentCardError extends Error {
  constructor(readonly issues: readonly string[]) { super("mimo_project_bridge_render_card_invalid"); }
}

const defaults = { workstreamId: "main", packet: "AGENTS.md", repositoryKey: "source" } as const;
const bridgeCli = "node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js";
const clientCli = "node <runtime>/dist/worker-codex/mimo-project-client-cli.js";
const sh = (path: string) => `'${path}'`;

/** Pure: turns a card into the files an operator reviews and installs by hand. Nothing is read or written. */
export function renderMimoAttachment(input: unknown): MimoAttachmentRendering {
  const parsed = cardSchema.safeParse(input);
  if (!parsed.success) throw new MimoAttachmentCardError(parsed.error.issues.map(issue => `${issue.path.join(".") || "card"}: ${issue.message}`));
  const card = parsed.data, applied: MimoAttachmentDefault[] = [];
  const fallback = <T>(field: string, value: T | undefined, standard: T, reason: string): T => {
    if (value !== undefined) return value;
    applied.push({ field, value: standard, reason }); return standard;
  };
  const projectId = card.projectId;
  const workstreamId = fallback("workstreamId", card.workstreamId, defaults.workstreamId, "one workstream per project and branch line");
  const packet = fallback("packet", card.packet, defaults.packet, "generic admission packet");
  const workerJobPrefix = fallback("jobIdPrefix", card.jobIdPrefix, `${projectId}-${workstreamId}-job-`, "must not prefix the controller job id");
  const controllerJobId = `${projectId}-${workstreamId}-controller`, repositoryKey = defaults.repositoryKey;
  applied.push({ field: "repositoryKey", value: repositoryKey, reason: "key of the single repository entry in the workstream YAML" },
    { field: "controllerJobId", value: controllerJobId, reason: "derived from project and workstream" },
    { field: "commitIdentity", value: `${hostedMimoCommitIdentity.name} <${hostedMimoCommitIdentity.email}>`, reason: "the only identity preparation accepts" },
    { field: "service_tier", value: "default", reason: "required by the platform-infra workstream contract" },
    { field: "heavy_lock_path", value: "/run/lock/hosted-v1-heavy.lock", reason: "inert for runtime; removal owned by platform-infra" });
  if (controllerJobId.startsWith(workerJobPrefix) || workerJobPrefix.startsWith(controllerJobId))
    throw new MimoAttachmentCardError(["jobIdPrefix: overlaps the controller job id " + controllerJobId]);

  const state = `/srv/worker-state/mimo-projects/${projectId}/${workstreamId}`, scratch = `/srv/workers/mimo-projects/${projectId}/${workstreamId}`;
  const snapshotRoot = "/srv/workers/mimo-project-snapshots", snapshotPath = `${snapshotRoot}/${projectId}/${workstreamId}/source`;
  const admission = genericMimoAdmission({ sourceCommit: card.commit, packet, ownedPaths: card.ownedPaths, sandboxSubdir: card.sandboxSubdir, scratchRoot: scratch });
  const binding = { schemaVersion: 1, projectId, workstreamId, machineId: card.host.machineId, routingEnabled: true,
    stateRoot: state, scratchRoot: scratch, registryRootDir: `${state}/registry`, controllerJobId, sourceWorkspacePath: `${scratch}/source`,
    sourceCommit: card.commit, sourceRef: "origin/" + card.branch, codexBinaryPath: card.host.codexBinaryPath,
    taskTimeoutMs: card.taskTimeoutMs, appServerStartupTimeoutMs: card.appServerStartupTimeoutMs, operationTimeoutMs: card.operationTimeoutMs, admission };
  const plan = { schemaVersion: 1, binding, sourceSnapshotPath: snapshotPath, repositoryKey, repositoryUrl: card.repositoryUrl, workerJobPrefix,
    authRootDir: card.host.authRootDir, commitIdentity: { ...hostedMimoCommitIdentity } };
  const routeFile = { schemaVersion: 1, routes: [{ projectId, workstreamId, host: card.host.alias, machineId: card.host.machineId, socketDir: card.host.socketDir }] };
  const yaml = [
    "---", "schema_version: 1", `project_id: ${JSON.stringify(projectId)}`, `workstream_id: ${JSON.stringify(workstreamId)}`,
    'service_tier: "default"', "routing_enabled: true", 'heavy_lock_path: "/run/lock/hosted-v1-heavy.lock"',
    `state_root: ${JSON.stringify(`/srv/worker-state/jobs/${projectId}/${workstreamId}`)}`,
    `quarantine_root: ${JSON.stringify(`/srv/worker-state/quarantine/${projectId}/${workstreamId}`)}`,
    `scratch_root: ${JSON.stringify(`/srv/workers/jobs/${projectId}/${workstreamId}`)}`,
    "repositories:", `  ${repositoryKey}:`, `    branch: ${JSON.stringify(card.branch)}`, `    exact_head: ${JSON.stringify(card.commit)}`,
    `    url: ${JSON.stringify(card.repositoryUrl)}`, ""].join("\n");

  // The same parsers the bridge, preparation and the local client use, applied to exactly what is printed.
  try {
    const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1, operation: MimoProjectBridgeOperation.Status,
      jobId: "preparation-validation", machineId: binding.machineId, projectId, workstreamId });
    const checked = parseHostedMimoProjectBinding(binding, request);
    parseHostedMimoPreparationPlan(plan);
    assertHostedMimoWorkstreamDeclaration(checked, yaml);
    const repository = configuredRepository(yaml, repositoryKey);
    if (repository.url !== card.repositoryUrl || repository.branch !== card.branch || repository.exact_head !== card.commit) throw new Error("repository");
    parseMimoProjectClientRoutes(routeFile);
    if (hasPinnedRequiredCheck(workerLaunchAdmissionSchema.parse(admission).contract.requiredChecks)) throw new Error("pinned");
  } catch (error) {
    throw new MimoAttachmentCardError([error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") : (error as Error).message]);
  }

  const staging = `/home/<operator>/mimo-staging/${projectId}.${workstreamId}`;
  const planPath = `/etc/subscription-runtime/reviewed-mimo-preparation-${projectId}.${workstreamId}.json`;
  const yamlPath = `/etc/subscription-runtime/projects/${projectId}.d/${workstreamId}.yml`, yamlDirectory = `/etc/subscription-runtime/projects/${projectId}.d`;
  const parents = [snapshotRoot, `${snapshotRoot}/${projectId}`, `${snapshotRoot}/${projectId}/${workstreamId}`];
  return {
    workstreamYaml: { path: yamlPath, content: yaml },
    preparationPlan: { path: planPath, content: JSON.stringify(plan, null, 2) + "\n" },
    localRoute: { content: JSON.stringify(routeFile, null, 2) + "\n" },
    snapshot: { path: snapshotPath, commands: [
      "# unprivileged: stage the exact reviewed commit; the branch ref must equal it",
      "umask 022",
      `git clone --no-hardlinks --branch ${card.branch} -- ${card.repositoryUrl} ${sh(staging)}`,
      `git -C ${sh(staging)} checkout --detach ${card.commit}`,
      `git -C ${sh(staging)} update-ref refs/remotes/origin/${card.branch} ${card.commit}`,
      `git -C ${sh(staging)} status --porcelain   # must print nothing`,
      "# root: create only the missing parents (existing ones keep their mode), then install a root-owned copy nobody else can write",
      "umask 022",
      ...parents.map(parent => `[ -d ${sh(parent)} ] || install -d -m 0755 -o root -g root ${sh(parent)}`),
      `[ ! -e ${sh(snapshotPath)} ] && cp -a ${sh(staging)} ${sh(snapshotPath)} && chown -R root:root ${sh(snapshotPath)} && chmod -R go-w ${sh(snapshotPath)}`] },
    nextCommands: [
      `# root: save workstreamYaml.content and preparationPlan.content to files, then install them without overwriting anything.`,
      `# The workstream id is one namespace per project across platform-infra inventory and runtime-rendered lines; an existing file means stop.`,
      `[ -d ${sh(yamlDirectory)} ] || install -d -m 0750 -o root -g root ${sh(yamlDirectory)}`,
      `[ ! -e ${sh(yamlPath)} ] && install -m 0640 -o root -g root <saved yaml> ${sh(yamlPath)}`,
      `[ ! -e ${sh(planPath)} ] && install -m 0600 -o root -g root <saved plan> ${sh(planPath)}`,
      `${bridgeCli} --prepare-project ${planPath}`,
      `# operator machine: save localRoute.content to a file, then`,
      `${clientCli} --configure-route <absolute path of that file>`],
    diskPeak: { scratchBytes: card.diskPeak.scratch, durableBytes: card.diskPeak.durable,
      check: "Before each Start, free space on the scratch filesystem and on the filesystem holding /srv/worker-state must be at least the scratch free-space floor (5 GiB, or the capacity floor of scratch-temp.json) plus this peak plus the unused declared peaks of the line's non-terminal jobs (rule B). Checked by hand; no capacity.json is rendered." },
    derivedDefaults: applied,
  };
}
