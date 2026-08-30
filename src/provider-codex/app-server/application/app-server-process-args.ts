export function codexAppServerProcessArgs(input: {
  readonly bypassHookTrust?: boolean;
}): readonly string[] {
  return [
    ...(input.bypassHookTrust === true
      ? ["--dangerously-bypass-hook-trust"]
      : []),
    "app-server",
    "--listen",
    "stdio://",
  ];
}
