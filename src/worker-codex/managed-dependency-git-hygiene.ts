/** Pure command hygiene shared by managed Git and source preparation without
 * initializing authority adapters to obtain flags or an environment. */
export const managedDependencyGitFlags: readonly string[] = Object.freeze([
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=",
]);

export function managedDependencyGitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/", TMPDIR: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}
