import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { materializeCodexEffectiveSeed, readCodexEffectiveSeed } from "../codex-effective-seed";
import { verifyOriginalOrdinarySeedPublication } from "../hosted-ordinary-seed-publication";
import { codexAuthJsonAt } from "./file-backend-codex-worker-test-support";

// Genuine encrypted journal/CAS using fresh synthetic TEST files. None of this
// creates a Root operation, guest namespace, reservation or positive Usable.
const original = codexAuthJsonAt("SYNTHETIC-original", "2026-10-11T00:00:00Z");
const rotated = codexAuthJsonAt("SYNTHETIC-rotated", "2026-10-11T00:01:00Z");
describe("ordinary owner official seed publication", () => {
  it("publishes rotation and reads it through the original logical source before releasing recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordinary-seed-TEST-")), path = join(root,"auth.json");
    try {
      await writeFile(path,original,{mode:0o600});const use=await materializeCodexEffectiveSeed(path);
      try {
        await verifyOriginalOrdinarySeedPublication(use.seed,rotated);
        expect((await readCodexEffectiveSeed(path)).bytes).toBe(rotated);
        expect(await readFile(path,"utf8")).toBe(original);
        expect((await stat(use.home)).isDirectory()).toBe(true);
        await use.finish(false);await expect(stat(use.home)).rejects.toMatchObject({code:"ENOENT"});
      } finally { await rm(use.home,{recursive:true,force:true}); }
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  // Old finish(true) ignores CAS false and removes this only recovery home.
  it("refuses a changed login authorization and retains the original recovery plus unrelated seed", async () => {
    const root=await mkdtemp(join(tmpdir(),"ordinary-seed-refusal-TEST-")),path=join(root,"auth.json"),foreign=join(root,"foreign-auth.json");
    try {
      await writeFile(path,original,{mode:0o600});await writeFile(foreign,original,{mode:0o600});const use=await materializeCodexEffectiveSeed(path);
      try {
        const replacement=JSON.parse(original);replacement.tokens.refresh_token="SYNTHETIC-foreign-authorization";
        await writeFile(path,JSON.stringify(replacement),{mode:0o600});
        await expect(verifyOriginalOrdinarySeedPublication(use.seed,rotated)).rejects.toThrow("ordinary_launcher_qualification_held");
        expect((await stat(use.home)).isDirectory()).toBe(true);expect(await readFile(use.authJsonPath,"utf8")).toBe(original);
        expect(await readFile(foreign,"utf8")).toBe(original);expect((await readCodexEffectiveSeed(foreign)).bytes).toBe(original);
      } finally { await rm(use.home,{recursive:true,force:true}); }
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it("authenticates unchanged bytes by original readback and never calls unchanged publication a changed refresh", async () => {
    const root=await mkdtemp(join(tmpdir(),"ordinary-seed-unchanged-TEST-")),path=join(root,"auth.json");
    try {
      await writeFile(path,original,{mode:0o600});const use=await materializeCodexEffectiveSeed(path);
      try { await verifyOriginalOrdinarySeedPublication(use.seed,original);expect((await stat(use.home)).isDirectory()).toBe(true); }
      finally { await rm(use.home,{recursive:true,force:true}); }
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
