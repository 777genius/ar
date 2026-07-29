import type {
  AgentRuntimeTaskContext,
  AgentRuntimeTaskRoundContext,
  AgentRuntimeTaskRoundMemberIdentity,
} from "../domain/agent-runtime-task-contracts";
import {
  assertOnlyKeys,
  nonEmptyStringAt,
  objectAt,
  positiveIntegerAt,
  stringAt,
} from "./agent-runtime-task-validation";

export function optionalContextField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly context?: AgentRuntimeTaskContext } {
  return input[key] === undefined ? {} : { context: parseContext(input[key], path) };
}

function parseContext(value: unknown, path: string): AgentRuntimeTaskContext {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    ["application", "purpose", "correlationId", "metadata", "round"],
    path,
  );
  return {
    ...optionalStringField(input, "application", `${path}.application`),
    ...optionalStringField(input, "purpose", `${path}.purpose`),
    ...optionalStringField(input, "correlationId", `${path}.correlationId`),
    ...optionalMetadataField(input, "metadata", `${path}.metadata`),
    ...optionalRoundContextField(input, "round", `${path}.round`),
  };
}

function parseRoundContext(
  value: unknown,
  path: string,
): AgentRuntimeTaskRoundContext {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    ["roundId", "roundIndex", "totalRounds", "member", "adversaryOf"],
    path,
  );
  return {
    ...optionalStringField(input, "roundId", `${path}.roundId`),
    ...optionalPositiveIntegerField(input, "roundIndex", `${path}.roundIndex`),
    ...optionalPositiveIntegerField(input, "totalRounds", `${path}.totalRounds`),
    member: parseRoundMemberIdentity(input.member, `${path}.member`),
    ...optionalRoundMemberIdentityField(
      input,
      "adversaryOf",
      `${path}.adversaryOf`,
    ),
  };
}

function parseRoundMemberIdentity(
  value: unknown,
  path: string,
): AgentRuntimeTaskRoundMemberIdentity {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    ["id", "adapterId", "agentType", "provider", "model", "independenceGroup", "label"],
    path,
  );
  return {
    id: nonEmptyStringAt(input.id, `${path}.id`),
    adapterId: nonEmptyStringAt(input.adapterId, `${path}.adapterId`),
    agentType: nonEmptyStringAt(input.agentType, `${path}.agentType`),
    provider: nonEmptyStringAt(input.provider, `${path}.provider`),
    model: nonEmptyStringAt(input.model, `${path}.model`),
    independenceGroup: nonEmptyStringAt(
      input.independenceGroup,
      `${path}.independenceGroup`,
    ),
    ...optionalStringField(input, "label", `${path}.label`),
  };
}

function optionalRoundContextField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly round?: AgentRuntimeTaskRoundContext } {
  return input[key] === undefined ? {} : { round: parseRoundContext(input[key], path) };
}

function optionalRoundMemberIdentityField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly adversaryOf?: AgentRuntimeTaskRoundMemberIdentity } {
  return input[key] === undefined
    ? {}
    : { adversaryOf: parseRoundMemberIdentity(input[key], path) };
}

function optionalMetadataField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly metadata?: Readonly<Record<string, string>> } {
  if (input[key] === undefined) return {};
  const metadata = objectAt(input[key], path);
  const parsed: Record<string, string> = {};
  for (const [metadataKey, metadataValue] of Object.entries(metadata)) {
    parsed[metadataKey] = stringAt(metadataValue, `${path}.${metadataKey}`);
  }
  return { metadata: parsed };
}

function optionalStringField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: string } {
  return input[key] === undefined ? {} : { [key]: stringAt(input[key], path) };
}

function optionalPositiveIntegerField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: number } {
  return input[key] === undefined
    ? {}
    : { [key]: positiveIntegerAt(input[key], path) };
}
