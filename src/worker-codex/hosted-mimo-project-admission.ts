/** A check command that embeds a commit SHA (40 hex, any case, so also the start of a longer digest) or a 64-hex digest.
 * A reusable line cannot be moved with such a check, so preparation and advance share this one definition.
 * A command that merely contains an unrelated 40-hex literal is also refused; rewrite the command without the literal. */
export function hasPinnedRequiredCheck(checks: readonly { readonly command: string }[]): boolean {
  return checks.some(check => /[a-f0-9]{40}/i.test(check.command));
}

export type GenericMimoAdmissionInput = Readonly<{
  sourceCommit: string; packet: string; ownedPaths: readonly string[]; sandboxSubdir: string; scratchRoot: string;
}>;
/** The reusable line template; `docs/hosted-mimo-project-workers.md#generic-admission-template` is its owner. */
export function genericMimoAdmission(input: GenericMimoAdmissionInput) {
  return { mode: "serial-builtin", contract: {
    kind: "worker-launch", format: 1,
    canonicalSha: input.sourceCommit, baseSha: input.sourceCommit, phaseStartSha: input.sourceCommit,
    packetRevision: "generic-r1", controllerPacket: input.packet, lanePacket: input.packet,
    phaseId: "phase-01", laneId: "generic", inputPatchHash: null, reviewKind: "implementation",
    ownedPaths: [...input.ownedPaths], mandatoryDocs: [input.packet], mandatoryScripts: [], mandatoryFixtures: [],
    requiredChecks: [{ id: "tree", cwd: input.sandboxSubdir, command: "git status --short" }],
    executionPolicy: { mode: "sandbox-only", sandboxRoot: `${input.scratchRoot}/source/${input.sandboxSubdir}`, forbiddenRealProjects: ["/srv/workers/jobs"] },
  } } as const;
}

/** The only commit identity preparation accepts and the renderer emits. */
export const hostedMimoCommitIdentity = Object.freeze({ name: "iliya", email: "iliyazelenkog@gmail.com" });
