export function isProjectInstructionPath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean).map((value) =>
    value.toLowerCase()
  );
  const basename = segments.at(-1);
  if (!basename) return false;
  if ([
    "agents.md",
    "agents.override.md",
    "skill.md",
    "claude.md",
    "gemini.md",
    ".cursorrules",
    "copilot-instructions.md",
  ].includes(basename)) return true;
  return segments.some((segment, index) =>
    segment === ".codex" ||
    (segment === ".claude" && segments[index + 1] === "rules") ||
    (segment === ".cursor" && segments[index + 1] === "rules") ||
    (segment === ".agents" && segments[index + 1] === "skills")
  );
}
