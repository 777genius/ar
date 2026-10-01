import { HostedControllerToolName as Tool, HostedControllerResultStatus as Status, HostedControllerError as ErrorCode,
  parseHostedControllerToolCall, type HostedControllerDynamicToolAdapter, type HostedControllerDynamicToolCall,
  type HostedControllerToolResult } from "@vioxen/subscription-runtime/provider-codex";
import { KeyedChildProfile } from "../../worker-core/project-control/domain/keyed-child-launch";
import { KeyedChildLaunchApplication } from "../../worker-core/project-control/application/keyed-child-launch";
import { HostedControllerOriginCapability } from "../hosted-controller-origin-binding";
import { assertRetainedKeyedAuthority, RetainedKeyedAuthority } from "./retained-authority";

const retainedToolAdapters = new WeakSet<object>();
/** The actual dispatcher retains this capability-bound adapter; boolean
 * verification alone still returns disabled and cannot call application code. */
export class HostedControllerKeyedToolAdapter implements HostedControllerDynamicToolAdapter {
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly application: KeyedChildLaunchApplication) {
    if (!(retained instanceof RetainedKeyedAuthority)) throw new Error("keyed_authority_required");
    assertRetainedKeyedAuthority(retained);
    application.assertAuthority(retained.authority, retained.seed.authorityDigest);
    retainedToolAdapters.add(this); Object.freeze(this);
  }
  assertBoundTo(origin: HostedControllerOriginCapability): void {
    origin.assertCurrent(); this.retained.assertCurrent();
    if (JSON.stringify(origin.origin) !== JSON.stringify(this.retained.origin.origin) ||
        origin.grantDigest !== this.retained.origin.grantDigest) throw new Error("keyed_foreign_origin");
  }
  async dispatch(input: HostedControllerDynamicToolCall, signal: AbortSignal): Promise<HostedControllerToolResult> {
    try {
      assertHostedControllerKeyedToolAdapter(this);
      this.retained.assertCurrent();
      const call = parseHostedControllerToolCall(input.tool, input.arguments);
      if (!call) return { status: Status.Rejected, error: ErrorCode.Denied };
      const args = call.arguments;
      switch (call.tool) {
        case Tool.Launch: return { status: Status.Accepted, view: await this.application.launch({ key: args.key!, task: args.task!,
          profile: args.profile === "read-only" ? KeyedChildProfile.ReadOnly : KeyedChildProfile.IsolatedWrite }, signal) };
        case Tool.Observe: return { status: Status.Observed, view: await this.application.observe(args.handle!) };
        case Tool.Stop: return { status: Status.StopRequested, view: await this.application.stop(args.handle!) };
      }
    } catch (error) {
      // Match only finite domain codes. Never transmit an exception/path/account.
      const message = error instanceof Error ? error.message : "";
      return { status: Status.Rejected, error: message === "key conflict" ? ErrorCode.Conflict :
        message === "occupied" ? ErrorCode.Occupied : ErrorCode.Denied };
    }
  }
}

export function assertHostedControllerKeyedToolAdapter(value: HostedControllerKeyedToolAdapter): void {
  if (!retainedToolAdapters.has(value)) throw new Error("keyed_tool_capability_required");
}
