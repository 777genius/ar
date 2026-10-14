import type { OriginalPreparationQuiescence } from "../domain/preintent-preparation";
import type { OriginalPreparationCustodyPort } from "../ports/preintent-preparation";

/** Long native/writer joins run outside admission coordination. Both original
 * owners must be discharged; writer completion is not subtree authority. */
export async function joinOriginalPreparation(custody: OriginalPreparationCustodyPort,
  originalWriter: Promise<void>, rereadPartialFiles: () => void): Promise<OriginalPreparationQuiescence | null> {
  custody.requestStop();
  const proof = await custody.join();
  if (!proof) return null;
  custody.authenticateQuiescence(proof);
  await originalWriter;
  rereadPartialFiles();
  custody.authenticateQuiescence(proof);
  return proof;
}
