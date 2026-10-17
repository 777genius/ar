/** Deadline mechanics only. A resolved Promise never supplies actual wait,
 * invocation, manager or terminal authority; original map checks all of them. */
export enum HostedManagedProviderWaitDeadline { Release = 35000, SessionRefresh = 300000 }
export async function awaitPrivateManagedProviderClose(wait: Promise<void>, deadline: HostedManagedProviderWaitDeadline): Promise<void> {
  if (deadline !== HostedManagedProviderWaitDeadline.Release && deadline !== HostedManagedProviderWaitDeadline.SessionRefresh)
    throw new Error("hosted_dependency_provider_wait_deadline_invalid");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([wait,new Promise<never>((_resolve,reject) => {
    timeout = setTimeout(() => reject(new Error("hosted_dependency_provider_drain_timeout")),deadline);
  })]); } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
