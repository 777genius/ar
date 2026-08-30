export type StaticExecCommandExtraction = {
  readonly commands: readonly string[];
  readonly dynamicCommand: boolean;
};

type Token = {
  readonly kind: "identifier" | "string" | "punctuation";
  readonly value: string;
  readonly staticValue: boolean;
};

/**
 * Extract the first argument's top-level `cmd` property from code-mode
 * `tools.exec_command(...)` calls. This is deliberately a small JavaScript
 * lexer/parser rather than a source-wide property regex: text in strings and
 * comments cannot become a command, while unsupported expressions fail closed.
 */
export function staticExecCommandsFromCodeModeSource(
  source: string,
): StaticExecCommandExtraction {
  const tokens = tokenize(source);
  const commands: string[] = [];
  let invocationCount = 0;
  let dynamicCommand = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const call = execCommandCallAt(tokens, index);
    if (call === null) continue;
    invocationCount += 1;
    const extracted = commandFromFirstArgument(tokens, call.callOpenIndex);
    if (extracted === null) {
      dynamicCommand = true;
    } else {
      commands.push(extracted);
    }
    index = call.callOpenIndex;
  }

  return {
    commands,
    dynamicCommand: dynamicCommand || invocationCount > commands.length,
  };
}

function execCommandCallAt(
  tokens: readonly Token[],
  index: number,
): { readonly callOpenIndex: number } | null {
  if (!isToken(tokens[index], "identifier", "tools")) return null;
  if (isToken(tokens[index - 1], "punctuation", ".")) return null;
  let cursor = index + 1;
  while (isToken(tokens[cursor], "punctuation", ")")) {
    const openIndex = matchingOpenParenthesis(tokens, cursor);
    if (openIndex === null || openIndex >= index || !isGroupingOpen(tokens, openIndex)) {
      return null;
    }
    cursor += 1;
  }
  const optionalAccess =
    isToken(tokens[cursor], "punctuation", "?") &&
    isToken(tokens[cursor + 1], "punctuation", ".");
  if (optionalAccess) cursor += 2;
  if (optionalAccess && isToken(tokens[cursor], "identifier", "exec_command")) {
    cursor += 1;
  } else if (!optionalAccess && isToken(tokens[cursor], "punctuation", ".")) {
    cursor += 1;
    if (!isToken(tokens[cursor], "identifier", "exec_command")) return null;
    cursor += 1;
  } else if (isToken(tokens[cursor], "punctuation", "[")) {
    const property = tokens[cursor + 1];
    if (
      property?.kind !== "string" ||
      !property.staticValue ||
      property.value !== "exec_command" ||
      !isToken(tokens[cursor + 2], "punctuation", "]")
    ) return null;
    cursor += 3;
  } else {
    return null;
  }

  while (isToken(tokens[cursor], "punctuation", ")")) {
    const openIndex = matchingOpenParenthesis(tokens, cursor);
    if (openIndex === null || openIndex >= index || !isGroupingOpen(tokens, openIndex)) {
      return null;
    }
    cursor += 1;
  }
  if (
    isToken(tokens[cursor], "punctuation", "?") &&
    isToken(tokens[cursor + 1], "punctuation", ".")
  ) cursor += 2;
  return isToken(tokens[cursor], "punctuation", "(")
    ? { callOpenIndex: cursor }
    : null;
}

function commandFromFirstArgument(
  tokens: readonly Token[],
  callOpenIndex: number,
): string | null {
  let cursor = callOpenIndex + 1;
  let argumentWrappers = 0;
  while (isToken(tokens[cursor], "punctuation", "(")) {
    argumentWrappers += 1;
    cursor += 1;
  }
  if (!isToken(tokens[cursor], "punctuation", "{")) return null;
  let command: string | null = null;
  let sawCommand = false;
  cursor += 1;
  while (!isToken(tokens[cursor], "punctuation", "}")) {
    if (isToken(tokens[cursor], "punctuation", ",")) {
      cursor += 1;
      continue;
    }
    if (isToken(tokens[cursor], "punctuation", "...")) return null;
    const property = propertyNameAt(tokens, cursor);
    if (property === null) return null;
    const colonIndex = property.keyEndIndex + 1;
    if (!isToken(tokens[colonIndex], "punctuation", ":")) return null;
    const valueStart = colonIndex + 1;
    const valueEnd = propertyValueEnd(tokens, valueStart);
    if (valueEnd === null || valueEnd === valueStart) return null;
    if (property.name === "cmd") {
      const value = tokens[valueStart];
      if (
        valueEnd !== valueStart + 1 ||
        value?.kind !== "string" ||
        !value.staticValue
      ) return null;
      sawCommand = true;
      command = value.value;
    }
    cursor = valueEnd;
  }

  if (!sawCommand || command === null) return null;
  let after = cursor + 1;
  for (let count = 0; count < argumentWrappers; count += 1) {
    if (!isToken(tokens[after], "punctuation", ")")) return null;
    after += 1;
  }
  const delimiter = tokens[after];
  if (
    !isToken(delimiter, "punctuation", ",") &&
    !isToken(delimiter, "punctuation", ")")
  ) return null;
  return command;
}

function propertyValueEnd(
  tokens: readonly Token[],
  valueStart: number,
): number | null {
  const expectedClosers: string[] = [];
  for (let cursor = valueStart; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!;
    if (token.kind !== "punctuation") continue;
    if (token.value === "(" || token.value === "[" || token.value === "{") {
      expectedClosers.push(token.value === "(" ? ")" : token.value === "[" ? "]" : "}");
      continue;
    }
    if (token.value === ")" || token.value === "]" || token.value === "}") {
      if (expectedClosers.length === 0) {
        return token.value === "}" ? cursor : null;
      }
      if (expectedClosers.pop() !== token.value) return null;
      continue;
    }
    if (token.value === "," && expectedClosers.length === 0) return cursor;
  }
  return null;
}

function propertyNameAt(
  tokens: readonly Token[],
  index: number,
): { readonly name: string; readonly keyEndIndex: number } | null {
  const token = tokens[index];
  if (
    (token?.kind === "identifier" || token?.kind === "string") &&
    token.staticValue
  ) {
    return { name: token.value, keyEndIndex: index };
  }
  if (
    isToken(token, "punctuation", "[") &&
    tokens[index + 1]?.kind === "string" &&
    tokens[index + 1]!.staticValue &&
    isToken(tokens[index + 2], "punctuation", "]")
  ) {
    return { name: tokens[index + 1]!.value, keyEndIndex: index + 2 };
  }
  return null;
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    if (character === "/" && isRegexLiteralStart(tokens)) {
      index = regexLiteralEnd(source, index);
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      const literal = readJavaScriptString(source, index, character);
      tokens.push({
        kind: "string",
        value: literal?.value ?? "",
        staticValue: literal?.staticValue ?? false,
      });
      index = literal?.endIndex ?? source.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) end += 1;
      tokens.push({
        kind: "identifier",
        value: source.slice(index, end),
        staticValue: true,
      });
      index = end;
      continue;
    }
    const punctuation = source.startsWith("...", index) ? "..." : character;
    tokens.push({ kind: "punctuation", value: punctuation, staticValue: true });
    index += punctuation.length;
  }
  return tokens;
}

function matchingOpenParenthesis(
  tokens: readonly Token[],
  closeIndex: number,
): number | null {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (isToken(tokens[index], "punctuation", ")")) depth += 1;
    if (!isToken(tokens[index], "punctuation", "(")) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return null;
}

function isGroupingOpen(tokens: readonly Token[], openIndex: number): boolean {
  const previous = tokens[openIndex - 1];
  if (previous === undefined) return true;
  if (previous.kind === "identifier") {
    return ["await", "return", "throw", "yield", "typeof", "void", "delete", "new"]
      .includes(previous.value);
  }
  return previous.kind === "punctuation" && previous.value !== ")" && previous.value !== "]";
}

function isRegexLiteralStart(tokens: readonly Token[]): boolean {
  const previous = tokens.at(-1);
  if (previous === undefined) return true;
  if (previous.kind === "identifier") {
    return ["case", "delete", "in", "instanceof", "new", "return", "throw", "typeof", "void", "yield"]
      .includes(previous.value);
  }
  return previous.kind === "punctuation" &&
    ["(", "[", "{", ",", ":", ";", "=", "!", "?", "&", "|"].includes(previous.value);
}

function regexLiteralEnd(source: string, startIndex: number): number {
  let characterClass = false;
  let escaped = false;
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") characterClass = true;
    if (character === "]") characterClass = false;
    if (character === "/" && !characterClass) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z]/.test(source[end]!)) end += 1;
      return end;
    }
    if (character === "\n" || character === "\r") return index;
  }
  return source.length;
}

function readJavaScriptString(
  source: string,
  startIndex: number,
  quote: string,
): { readonly value: string; readonly staticValue: boolean; readonly endIndex: number } | null {
  let value = "";
  let staticValue = true;
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote) {
      return { value, staticValue, endIndex: index + 1 };
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      staticValue = false;
      index += 1;
      continue;
    }
    if (character !== "\\") {
      if ((quote !== "`" && (character === "\n" || character === "\r"))) return null;
      value += character;
      continue;
    }
    const escape = decodeJavaScriptEscape(source, index + 1);
    if (escape === null) return null;
    value += escape.value;
    index = escape.endIndex - 1;
  }
  return null;
}

function decodeJavaScriptEscape(
  source: string,
  index: number,
): { readonly value: string; readonly endIndex: number } | null {
  const character = source[index];
  if (character === undefined) return null;
  const simple: Readonly<Record<string, string>> = {
    "0": "\0", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  };
  if (character === "\n") return { value: "", endIndex: index + 1 };
  if (character === "\r") {
    return { value: "", endIndex: source[index + 1] === "\n" ? index + 2 : index + 1 };
  }
  if (character === "0" && /[0-9]/.test(source[index + 1] ?? "")) return null;
  if (/[1-7]/.test(character)) {
    let digits = character;
    while (digits.length < 3 && /[0-7]/.test(source[index + digits.length] ?? "")) {
      digits += source[index + digits.length]!;
    }
    if (Number.parseInt(digits, 8) > 0xff) digits = digits.slice(0, 2);
    return {
      value: String.fromCharCode(Number.parseInt(digits, 8)),
      endIndex: index + digits.length,
    };
  }
  if (simple[character] !== undefined) {
    return { value: simple[character]!, endIndex: index + 1 };
  }
  if (character === "x") {
    const digits = source.slice(index + 1, index + 3);
    return /^[0-9A-Fa-f]{2}$/.test(digits)
      ? { value: String.fromCharCode(Number.parseInt(digits, 16)), endIndex: index + 3 }
      : null;
  }
  if (character === "u") {
    if (source[index + 1] === "{") {
      const close = source.indexOf("}", index + 2);
      if (close < 0) return null;
      const digits = source.slice(index + 2, close);
      const codePoint = /^[0-9A-Fa-f]{1,6}$/.test(digits)
        ? Number.parseInt(digits, 16)
        : Number.NaN;
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? { value: String.fromCodePoint(codePoint), endIndex: close + 1 }
        : null;
    }
    const digits = source.slice(index + 1, index + 5);
    return /^[0-9A-Fa-f]{4}$/.test(digits)
      ? { value: String.fromCharCode(Number.parseInt(digits, 16)), endIndex: index + 5 }
      : null;
  }
  return { value: character, endIndex: index + 1 };
}

function isToken(
  token: Token | undefined,
  kind: Token["kind"],
  value: string,
): boolean {
  return token?.kind === kind && token.value === value;
}
