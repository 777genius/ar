import { readFileSync } from "node:fs";
import { hostedMemoryTopologyMountPoint, type HostedMemoryTopologyIdentity } from "../core/host-infrastructure/host-retention-operation";
import {
  INITIAL_CGROUP_NAMESPACE_INO, assertRootOffersMemory, observeHostMemoryTopology, readHierarchyMountProof, unifiedCgroupPath,
} from "../worker-local/linux-memory-availability";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";

/**
 * Live observation of the complete host memory hierarchy, used at exactly two points of the retention operation: the
 * OUTSIDE operator observes and records it when it funds the operation, and the supervised operation observes it again
 * and must find the identical identities. It is not an issuer of anything by itself and publishes nothing.
 *
 * It records identities and the fixed mapping only, never a limit, usage or headroom. It proves the initial host
 * context directly: the kernel-fixed initial cgroup-namespace inode (never "self equals visible PID 1" and never the
 * constant alone), exactly one unmasked cgroup2 mount at the fixed mapping (no nested mount, no ancestor overmount, no
 * competing row), a unified hierarchy only (v1/hybrid refuse) with the memory controller at the root.
 */
export function collectHostedMemoryTopology(): HostedMemoryTopologyIdentity {
  assertReadonlyHostOperator();
  const roots = { cgroupRoot: hostedMemoryTopologyMountPoint };
  unifiedCgroupPath(readFileSync("/proc/self/cgroup", "utf8"));
  const live = observeHostMemoryTopology(roots);
  if (BigInt(live.topology.cgroupNamespace.ino) !== INITIAL_CGROUP_NAMESPACE_INO) throw new Error("hosted_memory_topology_not_initial_namespace");
  readHierarchyMountProof(roots);
  assertRootOffersMemory(hostedMemoryTopologyMountPoint);
  return Object.freeze({ mountPoint: hostedMemoryTopologyMountPoint,
    cgroupNamespace: live.topology.cgroupNamespace, hierarchyRoot: live.topology.hierarchyRoot });
}
