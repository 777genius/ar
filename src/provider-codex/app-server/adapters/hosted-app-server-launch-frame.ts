export type HostedAppServerLaunchFrame = {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export function encodeHostedAppServerLaunchFrame(
  frame: HostedAppServerLaunchFrame,
): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeHostedAppServerLaunchFrame(
  value: string,
): HostedAppServerLaunchFrame {
  const parsed = JSON.parse(value) as Partial<HostedAppServerLaunchFrame>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.command !== "string" ||
    parsed.command.length === 0 ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((item) => typeof item === "string") ||
    typeof parsed.cwd !== "string" ||
    parsed.cwd.length === 0 ||
    parsed.env === null ||
    typeof parsed.env !== "object" ||
    Array.isArray(parsed.env) ||
    !Object.entries(parsed.env).every(
      ([key, item]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string",
    )
  ) {
    throw new Error("hosted_app_server_launch_frame_invalid");
  }
  return parsed as HostedAppServerLaunchFrame;
}
