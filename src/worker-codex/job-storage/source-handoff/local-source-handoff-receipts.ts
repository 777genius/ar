import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SourceHandoffFailure as Failure, sourceHandoffFail, type SourceHandoffDirectory,
  type SourceHandoffReceipt, type SourceHandoffReceiptStore } from "./source-handoff-contracts";
import { assertSourceHandoffDirectory, sourceHandoffId, withSourceHandoffFile } from "./source-handoff-filesystem";
import { validateSourceHandoffReceipt } from "./local-source-handoff";

/** Existing host owner supplies an anchored private control root. Bounded
 * hashes/ids only; no source paths, file inventory, session or credential bytes.
 * Native fence spans all calls; this store is not standalone write authority. */
export class LocalSourceHandoffReceiptStore implements SourceHandoffReceiptStore {
  private readonly root: SourceHandoffDirectory;
  constructor(root: SourceHandoffDirectory) { this.root = Object.freeze({ ...root }); }
  async publish(receiptInput: SourceHandoffReceipt): Promise<void> {
    const receipt = Object.freeze({ ...receiptInput });
    validateSourceHandoffReceipt(receipt);
    const bytes = Buffer.from(JSON.stringify(receipt));
    if (bytes.length > 16 * 1024) sourceHandoffFail(Failure.Bounds);
    await assertSourceHandoffDirectory(this.root);
    const temporary = join(this.root.path, `.${receipt.handoffId}.${randomBytes(12).toString("hex")}.pending`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if ((await file.stat()).dev !== this.root.device) sourceHandoffFail(Failure.Destination);
      await file.writeFile(bytes); await file.sync();
      await assertSourceHandoffDirectory(this.root);
      try { await link(temporary, join(this.root.path, `${receipt.handoffId}.receipt`)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || JSON.stringify(await this.read(receipt.handoffId)) !== JSON.stringify(receipt)) sourceHandoffFail(Failure.Destination);
      }
    } finally { await file.close(); await unlink(temporary).catch(() => undefined); }
    const directory = await open(this.root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async read(handoffId: string): Promise<SourceHandoffReceipt | undefined> {
    sourceHandoffId(handoffId); await assertSourceHandoffDirectory(this.root);
    try {
      return await withSourceHandoffFile(join(this.root.path, `${handoffId}.receipt`), this.root.device, async (file, stat) => {
        if (stat.uid !== this.root.uid || (stat.mode & 0o077) || stat.size > 16 * 1024) sourceHandoffFail(Failure.Destination);
        const value = JSON.parse(await file.readFile("utf8")) as SourceHandoffReceipt;
        validateSourceHandoffReceipt(value);
        if (value.handoffId !== handoffId) sourceHandoffFail(Failure.Invalid);
        return Object.freeze(value);
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
