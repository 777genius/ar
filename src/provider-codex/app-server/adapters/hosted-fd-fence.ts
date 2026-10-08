import { isHostedActivationFenceBusy } from "./hosted-process-activation";

/** Retry only the identity classified at atomic mutex acquisition. Callback
 * failures never turn into Busy, and no fence survives this asynchronous wait. */
export async function retryHostedFenceAcquisition<T>(action: () => T, timeoutMs: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("hosted_fd_setup_expired");
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (true) {
    if (process.hrtime.bigint() >= deadline) throw new Error("hosted_fd_setup_expired");
    try { return action(); }
    catch (error) {
      if (!isHostedActivationFenceBusy(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
