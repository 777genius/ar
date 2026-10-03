import type { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";

/** Absolute wall plus elapsed monotonic bound. Long deadlines are chunked only
 * for Node's timer range; no callback renews the immutable authority. */
export function watchChildDeadline(budget: ChildExecutionBudget, expired: (error: unknown) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const arm = () => {
    if (disposed) return;
    try {
      timer = setTimeout(arm, Math.min(2147483647, budget.remainingMs()));
      timer.unref();
    } catch (error) { disposed = true; expired(error); }
  };
  arm();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}
