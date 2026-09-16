export function executionProfileCompatibility(input: {
  readonly reasoningEffort?: unknown;
  readonly serviceTier?: unknown;
}): Readonly<Record<string, unknown>> {
  return {
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: input.reasoningEffort }),
    ...(input.serviceTier === undefined
      ? {}
      : { serviceTier: input.serviceTier }),
  };
}
