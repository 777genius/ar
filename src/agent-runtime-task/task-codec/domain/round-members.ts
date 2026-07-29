import type { AgentRuntimeTaskRoundMemberIdentity } from "./agent-runtime-task-contracts";

export type AgentRuntimeTaskRoundIndependenceFailure =
  | "same-provider-model"
  | "same-independence-group";

export type AgentRuntimeTaskRoundIndependenceResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly failure: AgentRuntimeTaskRoundIndependenceFailure;
      readonly safeMessage: string;
    };

export function compareAgentRuntimeTaskRoundMembers(
  member: AgentRuntimeTaskRoundMemberIdentity,
  other: AgentRuntimeTaskRoundMemberIdentity,
): AgentRuntimeTaskRoundIndependenceResult {
  if (providerModelKey(member) === providerModelKey(other)) {
    return {
      ok: false,
      failure: "same-provider-model",
      safeMessage: "Round members must use distinct provider/model identities.",
    };
  }
  if (normalized(member.independenceGroup) === normalized(other.independenceGroup)) {
    return {
      ok: false,
      failure: "same-independence-group",
      safeMessage: "Round members must use distinct independence groups.",
    };
  }
  return { ok: true };
}

export function assertAgentRuntimeTaskRoundMembersIndependent(
  member: AgentRuntimeTaskRoundMemberIdentity,
  other: AgentRuntimeTaskRoundMemberIdentity,
): void {
  const result = compareAgentRuntimeTaskRoundMembers(member, other);
  if (!result.ok) throw new Error(result.safeMessage);
}

export function agentRuntimeTaskRoundMemberFingerprint(
  member: AgentRuntimeTaskRoundMemberIdentity,
): string {
  return [
    member.id,
    member.adapterId,
    member.agentType,
    member.provider,
    member.model,
    member.independenceGroup,
  ].map(fingerprintSegment).join("|");
}

function providerModelKey(member: AgentRuntimeTaskRoundMemberIdentity): string {
  return `${normalized(member.provider)}:${normalized(member.model)}`;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function fingerprintSegment(value: string): string {
  const text = normalized(value);
  return `${text.length}:${text}`;
}
