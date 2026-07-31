#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  retireTerminalProjectWorktree,
  type TerminalWorktreeRetirementPermit,
  type TerminalWorktreeRetirementResult,
} from "./application/project-control/codex-goal-terminal-worktree-retirement";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const permitSchema = z
  .object({
    schemaVersion: z.literal(1),
    registryRootDir: z.string().min(1),
    controllerJobId: z.string().min(1),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    expectedWorkspacePath: z.string().min(1),
    expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    expectedBranch: z.string().min(1).nullable(),
    expectedGitStatusSha256: sha256Schema,
    expectedGitCommonDir: z.string().min(1),
    expectedReclaimedBytes: z.number().int().nonnegative().safe(),
  })
  .strict();

export type TerminalWorktreeRetirementCliIo = {
  readonly cwd: () => string;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
};

export type TerminalWorktreeRetirementCliDependencies = {
  readonly execute?: (input: {
    readonly permit: TerminalWorktreeRetirementPermit;
    readonly permitSha256: string;
    readonly confirm: boolean;
  }) => Promise<TerminalWorktreeRetirementResult>;
};

export async function runTerminalWorktreeRetirementCli(
  argv = process.argv.slice(2),
  io: TerminalWorktreeRetirementCliIo = defaultIo,
  dependencies: TerminalWorktreeRetirementCliDependencies = {},
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const permitPath = isAbsolute(args.permitFile)
      ? args.permitFile
      : resolve(io.cwd(), args.permitFile);
    const permitHandle = await open(
      permitPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new Error("terminal_worktree_retirement_permit_open_failed");
    });
    let permitBytes: Buffer;
    try {
      const status = await permitHandle.stat();
      if (!status.isFile()) {
        throw new Error(
          "terminal_worktree_retirement_permit_regular_file_required",
        );
      }
      if (status.size > 64 * 1024) {
        throw new Error("terminal_worktree_retirement_permit_too_large");
      }
      if (dependencies.execute === undefined) {
        assertTerminalWorktreeRetirementPermitFileSecurity(status);
      }
      permitBytes = await permitHandle.readFile();
      if (permitBytes.length !== status.size) {
        throw new Error("terminal_worktree_retirement_permit_size_changed");
      }
    } finally {
      await permitHandle.close();
    }
    const permit = permitSchema.parse(
      JSON.parse(permitBytes.toString("utf8")),
    ) as TerminalWorktreeRetirementPermit;
    const permitSha256 = createHash("sha256").update(permitBytes).digest("hex");
    const execute = dependencies.execute ?? retireTerminalProjectWorktree;
    const result = await execute({
      permit,
      permitSha256,
      confirm: args.confirm,
    });
    io.writeStdout(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          mode: args.confirm ? "confirm" : "preview",
          ...result,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    io.writeStderr(`${safeError(error)}\n`);
    return 1;
  }
}

export function assertTerminalWorktreeRetirementPermitFileSecurity(
  status: {
    readonly uid: number | bigint;
    readonly mode: number | bigint;
  },
  effectiveUid = process.geteuid?.(),
): void {
  if (effectiveUid !== 0) {
    throw new Error("terminal_worktree_retirement_root_required");
  }
  if (Number(status.uid) !== 0) {
    throw new Error("terminal_worktree_retirement_permit_owner_invalid");
  }
  if ((Number(status.mode) & 0o777) !== 0o600) {
    throw new Error("terminal_worktree_retirement_permit_mode_invalid");
  }
}

function parseArgs(argv: readonly string[]): {
  readonly permitFile: string;
  readonly confirm: boolean;
} {
  let permitFile: string | undefined;
  let confirm = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--permit-file") {
      if (permitFile !== undefined || !argv[index + 1]) {
        throw new Error("terminal_worktree_retirement_permit_file_required");
      }
      permitFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--confirm" && !confirm) {
      confirm = true;
      continue;
    }
    throw new Error("terminal_worktree_retirement_argument_invalid");
  }
  if (!permitFile) {
    throw new Error("terminal_worktree_retirement_permit_file_required");
  }
  return { permitFile, confirm };
}

function safeError(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return "terminal_worktree_retirement_permit_invalid";
  }
  if (
    error instanceof Error &&
    /^(terminal_worktree_retirement|project_control_retire)_[a-z0-9_:,-]+$/.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "terminal_worktree_retirement_failed";
}

const defaultIo: TerminalWorktreeRetirementCliIo = {
  cwd: () => process.cwd(),
  writeStdout: (chunk) => process.stdout.write(chunk),
  writeStderr: (chunk) => process.stderr.write(chunk),
};

if (await isMainModule()) {
  process.exitCode = await runTerminalWorktreeRetirementCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
