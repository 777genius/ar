import { detectSecretLikeContent } from "@vioxen/subscription-runtime/worker-core";

type TextLine = {
  readonly patchLine: number;
  readonly content: string;
  readonly oldLine?: number;
  readonly newLine?: number;
};
export type PatchSection = {
  readonly startLine: number;
  oldPath: string | undefined;
  newPath: string | undefined;
  readonly text: TextLine[];
  binaryLine?: number;
};
export type PatchCoverage = {
  readonly lines: readonly string[];
  readonly sections: readonly PatchSection[];
  readonly copySources: readonly string[];
};

/** Parse boundaries only. Recognition never grants a fixture exception. */
export function parsePatchCoverage(
  patch: string,
  safePath: (path: string) => string,
): PatchCoverage {
  const lines = patch.split("\n");
  const sections: PatchSection[] = [];
  const copySources = new Set<string>();
  let section: PatchSection | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;
  let binary = false;
  let previous: TextLine | undefined;
  const filePath = (raw: string): string | undefined => {
    const decoded = decodeGitPath(raw.split("\t")[0] ?? "");
    if (decoded === "/dev/null") return undefined;
    return stripPatchPrefix(decoded, safePath);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "\\ No newline at end of file") {
      if (previous === undefined) invalid();
      // The content is recorded without LF; its source-side terminator is checked below.
      previous = undefined;
      continue;
    }
    if (oldRemaining !== 0 || newRemaining !== 0) {
      if (section === undefined) invalid();
      const prefix = line[0];
      if (prefix !== " " && prefix !== "+" && prefix !== "-") invalid();
      const takesOld = prefix !== "+";
      const takesNew = prefix !== "-";
      if ((takesOld && oldRemaining === 0) || (takesNew && newRemaining === 0)) invalid();
      const entry: TextLine = {
        patchLine: index, content: line.slice(1),
        ...(takesOld ? { oldLine: oldLine++ } : {}),
        ...(takesNew ? { newLine: newLine++ } : {}),
      };
      oldRemaining -= Number(takesOld);
      newRemaining -= Number(takesNew);
      section.text.push(entry);
      previous = entry;
      continue;
    }
    previous = undefined;
    if (line.startsWith("diff --git ")) {
      const paths = diffPaths(line.slice(11), safePath);
      section = { startLine: index, oldPath: paths?.[0], newPath: paths?.[1], text: [] };
      sections.push(section);
      binary = false;
    } else if (line.startsWith("--- ") && !binary) {
      // Traditional unified patches have no diff --git introducer.
      if (section === undefined || section.text.length > 0) {
        section = { startLine: index, oldPath: undefined, newPath: undefined, text: [] };
        sections.push(section);
      }
      section.oldPath = filePath(line.slice(4));
      const next = lines[++index];
      if (!next?.startsWith("+++ ")) invalid();
      section.newPath = filePath(next.slice(4));
    } else if (line.startsWith("@@ ")) {
      if (section === undefined || binary) invalid();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (match === null) invalid();
      oldLine = Number(match[1]);
      oldRemaining = Number(match[2] ?? 1);
      newLine = Number(match[3]);
      newRemaining = Number(match[4] ?? 1);
      if (![oldLine, oldRemaining, newLine, newRemaining].every(Number.isSafeInteger) ||
        oldRemaining + newRemaining === 0) invalid();
    } else if (line.startsWith("copy from ") || line.startsWith("rename from ")) {
      if (section === undefined || binary || section.text.length > 0) invalid();
      section.oldPath = safePath(decodeGitPath(line.slice(line.indexOf("from ") + 5)));
      if (line.startsWith("copy from ")) copySources.add(section.oldPath);
    } else if (line.startsWith("copy to ") || line.startsWith("rename to ")) {
      if (section === undefined || binary || section.text.length > 0) invalid();
      section.newPath = safePath(decodeGitPath(line.slice(line.indexOf("to ") + 3)));
    } else if (line === "GIT binary patch") {
      if (section === undefined || section.text.length > 0 || binary) invalid();
      section.binaryLine = index;
      binary = true;
    } else if (!binary && line !== "" &&
      !/^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?|(?:old mode|new mode|new file mode|deleted file mode) [0-7]{6}|(?:similarity|dissimilarity) index [0-9]+%)$/.test(line)) {
      invalid();
    }
  }
  if (oldRemaining !== 0 || newRemaining !== 0 || sections.length === 0) invalid();
  return { lines, sections, copySources: [...copySources] };
}

/** Only a byte-identical line at its checked blob position leaves raw scanning. */
export function assertTextAndEnvelopeCoverage(
  coverage: PatchCoverage,
  base: ReadonlyMap<string, Buffer>,
  post: ReadonlyMap<string, Buffer>,
  binaryPayloadLines: ReadonlySet<number>,
  intermediates: ReadonlyMap<number, ReadonlyMap<string, Buffer>> = new Map(),
): void {
  const envelope = [...coverage.lines];
  const coveredLines = new Set<number>();
  const cache = new Map<Buffer, readonly string[]>();
  const bound = (path: string | undefined, number: number | undefined,
    content: string, blobs: ReadonlyMap<string, Buffer>, patchLine: number): boolean => {
    if (path === undefined || number === undefined) return false;
    const bytes = blobs.get(path);
    if (bytes === undefined) return false;
    let lines = cache.get(bytes);
    if (lines === undefined) {
      lines = bytes.toString("utf8").split("\n");
      cache.set(bytes, lines);
    }
    const noNewline = coverage.lines[patchLine + 1] === "\\ No newline at end of file";
    return lines[number - 1] === content && number > 0 &&
      (noNewline ? number === lines.length && !bytes.toString("utf8").endsWith("\n")
        : number < lines.length);
  };
  for (const [index, section] of coverage.sections.entries()) {
    const before = intermediates.get(section.startLine) ?? base;
    const after = intermediates.get(coverage.sections[index + 1]?.startLine ?? coverage.lines.length) ?? post;
    let unbound = false;
    for (const line of section.text) {
      const oldBound = line.oldLine === undefined ||
        bound(section.oldPath, line.oldLine, line.content, before, line.patchLine);
      const newBound = line.newLine === undefined ||
        bound(section.newPath, line.newLine, line.content, after, line.patchLine);
      if (oldBound && newBound) {
        envelope[line.patchLine] = "";
        coveredLines.add(line.patchLine);
      }
      else unbound = true;
    }
    if (unbound) {
      // Scan both source-side fragments together: assignments and Bearer syntax
      // can span lines. Diff prefixes must not separate their lexical content.
      for (const side of ["oldLine", "newLine"] as const) {
        const fragment = section.text.filter((line) => line[side] !== undefined)
          .map((line) => line.content).join("\n");
        if (detectSecretLikeContent(fragment) !== undefined) {
          throw new Error("git_patch_secret_unbound_text_content");
        }
      }
    }
  }
  for (const index of binaryPayloadLines) {
    envelope[index] = "";
    coveredLines.add(index);
  }
  // Covered bytes were scanned in full reconstructed blobs above. Keep one
  // synthetic newline per contiguous covered run: thousands of synthetic blank
  // lines cause pathological whitespace backtracking in envelope detection.
  // Preserve every unbound byte and a whitespace separator between fragments.
  const envelopeText = envelope.filter((_line, index) =>
    !coveredLines.has(index) || !coveredLines.has(index - 1)
  ).join("\n");
  if (detectSecretLikeContent(envelopeText) !== undefined) {
    throw new Error("git_patch_secret_envelope_content");
  }
}

function diffPaths(raw: string, safePath: (path: string) => string):
  readonly [string, string] | undefined {
  if (raw.length > 32790) invalid();
  const candidates: [string, string][] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== " ") continue;
    try {
      const left = decodeGitPath(raw.slice(0, index));
      const right = decodeGitPath(raw.slice(index + 1));
      candidates.push([stripPatchPrefix(left, safePath), stripPatchPrefix(right, safePath)]);
    } catch { /* Try another space delimiter, including spaces inside quoted paths. */ }
  }
  return candidates.find(([left, right]) => left === right) ??
    (candidates.length === 1 ? candidates[0] : undefined);
}

/** Git apply defaults to -p1: remove one component, not a fixed a/ or b/. */
function stripPatchPrefix(decoded: string, safePath: (path: string) => string): string {
  const slash = decoded.indexOf("/");
  if (slash < 0) invalid();
  return safePath(decoded.slice(slash + 1));
}

function decodeGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"')) invalid();
  const bytes: number[] = [];
  for (let i = 1; i < raw.length - 1; i += 1) {
    const character = raw[i];
    if (character === undefined || character === '"') invalid();
    if (character !== "\\") {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const escaped = raw[++i];
    const mapping: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    if (escaped !== undefined && mapping[escaped] !== undefined) {
      bytes.push(mapping[escaped]);
    } else {
      const octal = raw.slice(i, i + 3);
      if (!/^[0-3][0-7]{2}$/.test(octal)) invalid();
      bytes.push(parseInt(octal, 8));
      i += 2;
    }
  }
  const buffer = Buffer.from(bytes);
  const decoded = buffer.toString("utf8");
  if (!Buffer.from(decoded).equals(buffer)) invalid();
  return decoded;
}

function invalid(): never {
  throw new Error("git_patch_secret_patch_structure_invalid");
}
