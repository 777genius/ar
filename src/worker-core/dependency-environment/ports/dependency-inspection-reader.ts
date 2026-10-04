import type { DependencyInspectionInput } from "../domain/dependency-inspection";
import type { DependencyWorkspaceIdentity } from "../domain/dependency-receipt";

// Adapter reads protected receipt, physical identity, authenticated owner and trusted profile facts.
// This snapshot does not reserve a workspace. Execution must acquire a real final admission permit.
export interface DependencyInspectionReader {
  readInspection(workspace: DependencyWorkspaceIdentity): Promise<DependencyInspectionInput>;
}
