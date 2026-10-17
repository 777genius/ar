/** Fixed factual execution recipe. These constants confer no entry or grant. */
export const originalFullPeerRuntime = "/opt/subscription-runtime-dependency-os-TEST";
export const originalFullPeerNode = originalFullPeerRuntime + "/toolchain/bin/node";
export const originalFullPeerProgram = originalFullPeerRuntime + "/scripts/dependency-retention-os-test/current-full-peer-query.js";
export const originalFullPeerLoader = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";
export const originalFullPeerReady = "TEST_peer_query_ready\n";
export const originalFullPeerArguments = Object.freeze([
  "--inhibit-cache", "--glibc-hwcaps-mask", "", "--library-path", "/usr/lib/x86_64-linux-gnu", "/usr/bin/ss",
  "-H", "-n", "-A", "unix_stream", "state", "established", "src", "unix:",
]);
export function originalFullPeerEnvironment(): Readonly<Record<"PATH" | "LANG" | "LC_ALL" | "SYSTEMD_COLORS", string>> {
  return Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" });
}
