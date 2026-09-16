export type BlockedGlobalFilesystemScan = {
  readonly tool: "find" | "rg" | "grep";
  readonly root: string;
};

export type UnverifiableGlobalFilesystemScan = {
  readonly expression: string;
};

type ShellToken = {
  readonly value: string;
  readonly dynamicExpansion: boolean;
};

const blockedRoots = new Set([
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
]);

export function blockedGlobalFilesystemScan(
  args: readonly string[],
): BlockedGlobalFilesystemScan | null {
  const tool = executableBaseName(args[0] ?? "");
  if (tool === "find") return blockedFindScan(args.slice(1));
  if (tool === "rg") return blockedRgScan(args.slice(1));
  if (tool === "grep") return blockedGrepScan(args.slice(1));
  return null;
}

export function blockedGlobalFilesystemScanCommand(
  command: string,
): BlockedGlobalFilesystemScan | null {
  for (const vector of shellCommandVectors(command)) {
    const normalized = normalizeCommandVector(vector).map((token) => token.value);
    const blocked = blockedGlobalFilesystemScan(normalized);
    if (blocked !== null) return blocked;
    const nestedShellCommand = shellCommandArgument(normalized);
    if (nestedShellCommand !== null) {
      const nestedBlocked = blockedGlobalFilesystemScanCommand(nestedShellCommand);
      if (nestedBlocked !== null) return nestedBlocked;
    }
  }
  return null;
}

export function unverifiableGlobalFilesystemScanCommand(
  command: string,
): UnverifiableGlobalFilesystemScan | null {
  return unverifiableGlobalFilesystemScanCommandWithEnvironment(command, new Set());
}

function unverifiableGlobalFilesystemScanCommandWithEnvironment(
  command: string,
  inheritedReassignedGuardEnvironment: ReadonlySet<string>,
): UnverifiableGlobalFilesystemScan | null {
  const reassignedGuardEnvironment = new Set(inheritedReassignedGuardEnvironment);
  for (const vector of shellCommandVectors(command)) {
    for (const token of vector) {
      const assignmentName = environmentAssignmentName(token.value);
      if (assignmentName !== null && isGuardExecutableEnvironmentName(assignmentName)) {
        reassignedGuardEnvironment.add(assignmentName);
      }
    }
    const normalized = normalizeCommandVector(vector);
    if (normalized.length === 0) continue;
    const executable = normalized[0]!;
    const guardExecutable = guardExecutableFromEnvironmentReference(executable.value);
    const guardEnvironmentName = guardExecutableEnvironmentReferenceName(executable.value);
    if (
      executable.dynamicExpansion &&
      (guardExecutable === null ||
        (guardEnvironmentName !== null && reassignedGuardEnvironment.has(guardEnvironmentName)))
    ) {
      return { expression: executable.value };
    }

    const values = normalized.map((token) => token.value);
    if (["find", "rg", "grep"].includes(executableBaseName(executable.value))) {
      for (let index = 1; index < normalized.length; index += 1) {
        const candidate = normalized[index]!;
        if (!candidate.dynamicExpansion) continue;
        const probe = values.map((value, probeIndex) => probeIndex === index ? "/" : value);
        if (blockedGlobalFilesystemScan(probe) !== null) {
          return { expression: candidate.value };
        }
      }
    }

    const nestedShellCommand = shellCommandArgument(values);
    if (nestedShellCommand !== null) {
      const nested = unverifiableGlobalFilesystemScanCommandWithEnvironment(
        nestedShellCommand,
        reassignedGuardEnvironment,
      );
      if (nested !== null) return nested;
    }
  }
  return null;
}

function shellCommandVectors(command: string): readonly (readonly ShellToken[])[] {
  const vectors: ShellToken[][] = [[]];
  let token = "";
  let tokenDynamicExpansion = false;
  let quote: "none" | "single" | "double" = "none";
  let escaped = false;

  const finishToken = (): void => {
    if (!token) return;
    vectors.at(-1)!.push({ value: token, dynamicExpansion: tokenDynamicExpansion });
    token = "";
    tokenDynamicExpansion = false;
  };
  const finishCommand = (): void => {
    finishToken();
    if (vectors.at(-1)!.length > 0) vectors.push([]);
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote !== "single" && (character === "$" || character === "`")) {
      tokenDynamicExpansion = true;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? "none" : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? "none" : "double";
      continue;
    }
    if (quote === "none" && (character === "\n" || character === "\r")) {
      finishCommand();
      continue;
    }
    if (quote === "none" && /\s/.test(character)) {
      finishToken();
      continue;
    }
    if (
      quote === "none" &&
      ((character === "(" || character === "{") ? token.length === 0 :
        character === ")" || character === "}")
    ) {
      finishCommand();
      continue;
    }
    if (quote === "none" && (character === ";" || character === "|" || character === "&")) {
      finishCommand();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    token += character;
  }
  finishToken();
  return vectors.filter((vector) => vector.length > 0);
}

function normalizeCommandVector(vector: readonly ShellToken[]): readonly ShellToken[] {
  let index = 0;
  while (isEnvironmentAssignment(vector[index]?.value)) index += 1;
  if (vector[index]?.value === "command" || vector[index]?.value === "exec") index += 1;
  if (vector[index]?.value === "env") {
    index += 1;
    while (
      vector[index]?.value.startsWith("-") ||
      isEnvironmentAssignment(vector[index]?.value)
    ) {
      index += 1;
    }
  }
  return vector.slice(index);
}

function isEnvironmentAssignment(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function environmentAssignmentName(value: string): string | null {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value)?.[1] ?? null;
}

function shellCommandArgument(vector: readonly string[]): string | null {
  const executable = executableBaseName(vector[0] ?? "");
  if (!["bash", "dash", "sh", "zsh"].includes(executable)) return null;
  const optionIndex = vector.findIndex((value, index) =>
    index > 0 && /^-[^-]*c/.test(value)
  );
  return optionIndex < 0 ? null : vector[optionIndex + 1] ?? null;
}

function blockedFindScan(args: readonly string[]): BlockedGlobalFilesystemScan | null {
  let consumeNext = false;
  let optionsFinished = false;
  for (const rawArg of args) {
    const arg = unquote(rawArg);
    if (consumeNext) {
      consumeNext = false;
      continue;
    }
    if (!optionsFinished && arg === "--") {
      optionsFinished = true;
      continue;
    }
    if (!optionsFinished && (arg === "-H" || arg === "-L" || arg === "-P")) continue;
    if (!optionsFinished && arg === "-D") {
      consumeNext = true;
      continue;
    }
    if (!optionsFinished && (arg.startsWith("-D") || /^-O\d*$/.test(arg))) continue;
    if (!optionsFinished && (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")" || arg === ",")) {
      break;
    }
    if (isBlockedRoot(arg)) return { tool: "find", root: rawArg };
  }
  return null;
}

function blockedRgScan(args: readonly string[]): BlockedGlobalFilesystemScan | null {
  const operands: string[] = [];
  let consumeNext = false;
  let filesMode = false;
  let explicitPattern = false;
  let optionsFinished = false;

  for (const rawArg of args) {
    const arg = unquote(rawArg);
    if (consumeNext) {
      consumeNext = false;
      continue;
    }
    if (!optionsFinished) {
      if (arg === "--") {
        optionsFinished = true;
        continue;
      }
      if (arg === "--files") {
        filesMode = true;
        continue;
      }
      if (["-e", "-f", "--regexp", "--file"].includes(arg)) {
        explicitPattern = true;
        consumeNext = true;
        continue;
      }
      if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) {
        explicitPattern = true;
        continue;
      }
      if (arg.startsWith("--") && arg.includes("=")) continue;
      if (arg.startsWith("-")) {
        const parsed = parseRgShortOption(arg);
        explicitPattern ||= parsed.explicitPattern;
        consumeNext = parsed.consumeNext;
        continue;
      }
    }
    operands.push(rawArg);
  }

  const firstPathIndex = filesMode || explicitPattern ? 0 : 1;
  for (const rawOperand of operands.slice(firstPathIndex)) {
    if (isBlockedRoot(unquote(rawOperand))) return { tool: "rg", root: rawOperand };
  }
  return null;
}

function parseRgShortOption(arg: string): {
  readonly consumeNext: boolean;
  readonly explicitPattern: boolean;
} {
  const valueOptions = new Set(["A", "B", "C", "d", "E", "M", "g", "j", "m", "r", "t", "T"]);
  const cluster = arg.slice(1);
  for (let index = 0; index < cluster.length; index += 1) {
    const option = cluster[index] as string;
    if (option === "e" || option === "f") {
      return { consumeNext: index === cluster.length - 1, explicitPattern: true };
    }
    if (valueOptions.has(option)) {
      return { consumeNext: index === cluster.length - 1, explicitPattern: false };
    }
  }
  return { consumeNext: false, explicitPattern: false };
}

function blockedGrepScan(args: readonly string[]): BlockedGlobalFilesystemScan | null {
  const operands: string[] = [];
  let consumeNext: "none" | "pattern" | "directories" | "value" = "none";
  let explicitPattern = false;
  let recursive = false;
  let optionsFinished = false;

  for (const rawArg of args) {
    const arg = unquote(rawArg);
    if (consumeNext !== "none") {
      if (consumeNext === "directories" && arg === "recurse") recursive = true;
      consumeNext = "none";
      continue;
    }
    if (!optionsFinished) {
      if (arg === "--") {
        optionsFinished = true;
        continue;
      }
      if (["-r", "-R", "--recursive", "--dereference-recursive"].includes(arg)) {
        recursive = true;
        continue;
      }
      if (["-e", "-f", "--regexp", "--file"].includes(arg)) {
        explicitPattern = true;
        consumeNext = "pattern";
        continue;
      }
      if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) {
        explicitPattern = true;
        continue;
      }
      if (arg === "--directories") {
        consumeNext = "directories";
        continue;
      }
      if (arg === "--directories=recurse") {
        recursive = true;
        continue;
      }
      if (arg.startsWith("--") && arg.includes("=")) continue;
      if (arg.startsWith("-")) {
        const parsed = parseGrepShortOption(arg);
        explicitPattern ||= parsed.explicitPattern;
        recursive ||= parsed.recursive;
        consumeNext = parsed.consumeNext;
        continue;
      }
    }
    operands.push(rawArg);
  }

  if (!recursive) return null;
  const firstPathIndex = explicitPattern ? 0 : 1;
  for (const rawOperand of operands.slice(firstPathIndex)) {
    if (isBlockedRoot(unquote(rawOperand))) return { tool: "grep", root: rawOperand };
  }
  return null;
}

function parseGrepShortOption(arg: string): {
  readonly consumeNext: "none" | "pattern" | "directories" | "value";
  readonly explicitPattern: boolean;
  readonly recursive: boolean;
} {
  let recursive = false;
  const cluster = arg.slice(1);
  for (let index = 0; index < cluster.length; index += 1) {
    const option = cluster[index] as string;
    if (option === "r" || option === "R") recursive = true;
    if (option === "e" || option === "f") {
      return {
        consumeNext: index === cluster.length - 1 ? "pattern" : "none",
        explicitPattern: true,
        recursive,
      };
    }
    if (option === "d") {
      const value = cluster.slice(index + 1);
      return {
        consumeNext: value ? "none" : "directories",
        explicitPattern: false,
        recursive: recursive || value === "recurse",
      };
    }
    if (["A", "B", "C", "D", "m"].includes(option)) {
      return {
        consumeNext: index === cluster.length - 1 ? "value" : "none",
        explicitPattern: false,
        recursive,
      };
    }
  }
  return { consumeNext: "none", explicitPattern: false, recursive };
}

function isBlockedRoot(value: string): boolean {
  if (!value.startsWith("/")) return false;
  const normalized = normalizeAbsolutePath(value);
  if (blockedRoots.has(normalized)) return true;
  const parts = normalized.split("/").filter(Boolean);
  return parts.length === 2 && (parts[0] === "mnt" || parts[0] === "media");
}

function normalizeAbsolutePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function executableBaseName(value: string): string {
  const guardExecutable = guardExecutableFromEnvironmentReference(value);
  if (guardExecutable !== null) return guardExecutable;
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? value;
}

function guardExecutableFromEnvironmentReference(
  value: string,
): "find" | "rg" | "grep" | null {
  const match = /^\$SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_(FIND|RG|GREP)_REAL$/.exec(
    value,
  ) ?? /^\$\{SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_(FIND|RG|GREP)_REAL(?::?\?[^}]*)?\}$/.exec(
    value,
  );
  if (match === null) return null;
  return match[1]!.toLowerCase() as "find" | "rg" | "grep";
}

function guardExecutableEnvironmentReferenceName(value: string): string | null {
  return /^\$\{?(SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_(?:FIND|RG|GREP)_REAL)/
    .exec(value)?.[1] ?? null;
}

function isGuardExecutableEnvironmentName(value: string): boolean {
  return /^SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_(?:FIND|RG|GREP)_REAL$/.test(value);
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === "'" && last === "'") || (first === '"' && last === '"')
    ? value.slice(1, -1)
    : value;
}
