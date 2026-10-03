import { z } from "zod";

/** A host administrator's assertion, never inferred from missing runtime files. */
export const controllerHistoricalAttestationSchema = z.object({
  operatorIdentity: z.string().trim().min(1).max(256),
  assertedAt: z.string().datetime(),
  controllerJobId: z.string().min(1),
  controllerCreatedAt: z.string().datetime(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  registryRootDir: z.string().min(1),
  jobRootDir: z.string().min(1),
  sourceWorkspacePath: z.string().min(1),
  destinationWorkspacePath: z.string().min(1),
  confirmation: z.literal("I attest complete never-run controller history through this relocation maintenance fence"),
  historyCompleteFromCreationThroughThisMaintenanceFence: z.literal(true),
  noControllerProviderOrWorkerExecution: z.literal(true),
  coversDefaultCustomDirectAndAlternateHostLaunches: z.literal(true),
  coversStateMovementAndDeletion: z.literal(true),
  distinguishesBrokerChildWorkersFromControllerExecution: z.literal(true),
  evidence: z.array(z.object({
    reference: z.string().trim().min(1).max(2048),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(64),
}).strict();
export type ControllerHistoricalAttestation = z.infer<typeof controllerHistoricalAttestationSchema>;
