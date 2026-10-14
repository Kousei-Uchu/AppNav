import { ParseError, UnsupportedVersionError } from "./errors";
import { setOwn } from "./json";
import {
  VARIABLE_TYPES,
  type ActionDeclaration,
  type Graph,
  type JsonObject,
  type JsonValue,
  type RawEdge,
  type RawScreen,
  type VariableDeclaration,
  type VariableType,
} from "./types";

export const SUPPORTED_GRAPH_VERSIONS: readonly number[] = [2];

export interface ParseOptions {
  /** File name used in error messages. */
  file?: string;
  /** Override the accepted NAVGRAPH versions. */
  supportedVersions?: readonly number[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const ID_PART = /[A-Za-z0-9_.:]/;
const KEYWORDS = new Set(["APP", "VAR", "SCREEN", "ACTION", "END", "DO"]);

/**
 * Parse `.navgraph` source text into a Graph. This performs syntax checks only;
 * run `validateGraph` (or `indexGraph`) for semantic checks.
 *
 * Grammar summary:
 *   document  := "NAVGRAPH/" int item* ["END"]
 *   item      := app | var | screen | edge
 *   app       := "APP" string
 *   var       := "VAR" NAME ":" type ["=" json]
 *   screen    := "SCREEN" id string [json-object]
 *   edge      := id "->" id ["[" attr ("," attr)* "]"] ["{" action* "}"]
 *   action    := "DO" TYPE [json-object] ["repeat" "=" (int | string | "$"NAME"$")]
 * Comments start with # and run to the end of the line. Whitespace between
 * tokens is insignificant except that VAR, SCREEN and APP end at a line break.
 */
export function parseGraph(text: string, options: ParseOptions = {}): Graph {
  if (typeof text !== "string") {
    throw new ParseError("parseGraph expects a string", { file: options.file }, "INVALID_INPUT");
  }
  const file = options.file;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);

  const locate = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { file, line: lo + 1, column: offset - (lineStarts[lo] as number) + 1 };
  };
  const fail = (msg: string, offset: number, code = "SYNTAX_ERROR"): never => {
    throw new ParseError(msg, locate(offset), code);
  };

  let pos = 0;
  const eof = () => pos >= src.length;
  const peek = (n = 0) => src[pos + n] ?? "";

  const skipInline = () => {
    while (pos < src.length && (src[pos] === " " || src[pos] === "\t" || src[pos] === "\r")) pos++;
  };
  /** Skips whitespace, newlines and comments. */
  const skipTrivia = () => {
    for (;;) {
      const c = peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n") pos++;
      else if (c === "#") while (!eof() && peek() !== "\n") pos++;
      else return;
    }
  };
  const expectEol = (what: string) => {
    skipInline();
    if (peek() === "#") while (!eof() && peek() !== "\n") pos++;
    if (!eof() && peek() !== "\n") fail(`Unexpected content after ${what}`, pos, "UNEXPECTED_TOKEN");
  };

  const readWhile = (re: RegExp) => {
    const start = pos;
    while (pos < src.length && re.test(src[pos] as string)) pos++;
    return src.slice(start, pos);
  };
  const readIdent = (what: string): string => {
    if (!IDENT_START.test(peek())) fail(`Expected ${what}`, pos, "EXPECTED_IDENTIFIER");
    return readWhile(IDENT_PART);
  };
  const readId = (what: string): string => {
    if (!IDENT_START.test(peek())) fail(`Expected ${what}`, pos, "EXPECTED_IDENTIFIER");
    return readWhile(ID_PART);
  };

  const readString = (): string => {
    const start = pos;
    if (peek() !== '"') fail("Expected a quoted string", pos, "EXPECTED_STRING");
    pos++;
    while (!eof() && peek() !== '"') {
      if (peek() === "\n") fail("Unterminated string", start, "UNTERMINATED_STRING");
      if (peek() === "\\") pos++;
      pos++;
    }
    if (eof()) fail("Unterminated string", start, "UNTERMINATED_STRING");
    pos++;
    try {
      return JSON.parse(src.slice(start, pos)) as string;
    } catch {
      return fail("Invalid escape sequence in string", start, "INVALID_STRING");
    }
  };

  /** Scans a balanced {...} or [...] block, aware of strings. Returns the raw slice. */
  const scanBalanced = (): string => {
    const start = pos;
    const stack: string[] = [];
    do {
      const c = peek();
      if (c === "") fail("Unterminated JSON block", start, "UNTERMINATED_JSON");
      if (c === '"') {
        pos++;
        while (!eof() && peek() !== '"') {
          if (peek() === "\\") pos++;
          pos++;
        }
        if (eof()) fail("Unterminated string in JSON block", start, "UNTERMINATED_JSON");
        pos++;
        continue;
      }
      if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") {
        if (stack.pop() !== c) fail(`Mismatched "${c}" in JSON block`, pos, "UNTERMINATED_JSON");
      }
      pos++;
    } while (stack.length > 0);
    return src.slice(start, pos);
  };

  const parseJson = (raw: string, start: number): JsonValue => {
    try {
      return JSON.parse(raw) as JsonValue;
    } catch (e) {
      const m = /position (\d+)/.exec(e instanceof Error ? e.message : "");
      const off = m ? start + Number(m[1]) : start;
      return fail(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, off, "INVALID_JSON");
    }
  };

  const readJsonObject = (): JsonObject => {
    const start = pos;
    const raw = scanBalanced();
    if (raw[0] !== "{") fail("Expected a JSON object", start, "EXPECTED_OBJECT");
    return parseJson(raw, start) as JsonObject;
  };

  /** Reads any JSON value (used for VAR defaults and attribute values). */
  const readJsonValue = (): JsonValue => {
    const start = pos;
    const c = peek();
    let raw: string;
    if (c === "{" || c === "[") raw = scanBalanced();
    else if (c === '"') {
      readString();
      raw = src.slice(start, pos);
    } else {
      raw = readWhile(/[^\s#]/);
      if (raw === "") fail("Expected a value", start, "EXPECTED_VALUE");
    }
    return parseJson(raw, start);
  };

  // ---- header ----
  skipTrivia();
  const headerStart = pos;
  const hm = /^NAVGRAPH\/(\S+)/.exec(src.slice(pos));
  if (!hm) fail('Missing header. Files must start with "NAVGRAPH/<version>"', pos, "MISSING_HEADER");
  const versionText = (hm as RegExpExecArray)[1] as string;
  const version = Number(versionText);
  const supported = options.supportedVersions ?? SUPPORTED_GRAPH_VERSIONS;
  if (!Number.isInteger(version) || !supported.includes(version)) {
    throw new UnsupportedVersionError(versionText, locate(headerStart));
  }
  pos += (hm as RegExpExecArray)[0].length;
  expectEol("version header");

  const graph: Graph = { version, file, variables: [], screens: [], edges: [], hasEnd: false };

  const parseAttributes = (): Pick<RawEdge, "id" | "cost" | "condition" | "meta"> => {
    const open = pos;
    pos++; // [
    const out: Pick<RawEdge, "id" | "cost" | "condition" | "meta"> = { meta: {} };
    const seen = new Set<string>();
    for (;;) {
      skipTrivia();
      if (peek() === "]") {
        pos++;
        return out;
      }
      if (eof()) fail("Unterminated attribute list", open, "UNTERMINATED_ATTRIBUTES");
      const keyAt = pos;
      const key = readIdent("an attribute name");
      skipTrivia();
      if (peek() !== "=") fail(`Expected "=" after attribute "${key}"`, pos, "EXPECTED_EQUALS");
      pos++;
      skipTrivia();
      if (seen.has(key)) fail(`Duplicate attribute "${key}"`, keyAt, "DUPLICATE_ATTRIBUTE");
      seen.add(key);
      const valueAt = pos;
      // Capture the raw value up to a top level "," or "]".
      let depth = 0;
      while (!eof()) {
        const c = peek();
        if (c === '"') {
          pos++;
          while (!eof() && peek() !== '"') {
            if (peek() === "\\") pos++;
            pos++;
          }
          if (eof()) fail("Unterminated string", valueAt, "UNTERMINATED_STRING");
        } else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "}") depth--;
        else if (c === "]") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
        pos++;
      }
      if (eof()) fail("Unterminated attribute list", open, "UNTERMINATED_ATTRIBUTES");
      const raw = src.slice(valueAt, pos).trim();
      if (raw === "") fail(`Missing value for attribute "${key}"`, valueAt, "EXPECTED_VALUE");
      const quoted = raw.startsWith('"') ? (parseJson(raw, valueAt) as string) : undefined;
      switch (key) {
        case "cost": {
          const n = quoted !== undefined ? NaN : Number(raw);
          if (Number.isNaN(n)) fail(`Edge cost must be a number, got ${raw}`, valueAt, "INVALID_COST");
          out.cost = n;
          break;
        }
        case "if":
          out.condition = quoted ?? raw;
          break;
        case "id":
          out.id = quoted ?? raw;
          break;
        default: {
          let value: JsonValue;
          if (quoted !== undefined) value = quoted;
          else {
            try {
              value = JSON.parse(raw) as JsonValue;
            } catch {
              value = raw;
            }
          }
          setOwn(out.meta, key, value);
        }
      }
      skipTrivia();
      if (peek() === ",") pos++;
      else if (peek() !== "]") fail('Expected "," or "]" in attribute list', pos, "UNEXPECTED_TOKEN");
    }
  };

  const parseActions = (): ActionDeclaration[] => {
    const open = pos;
    pos++; // {
    const actions: ActionDeclaration[] = [];
    for (;;) {
      skipTrivia();
      if (eof()) fail("Unterminated edge block", open, "UNTERMINATED_BLOCK");
      if (peek() === "}") {
        pos++;
        return actions;
      }
      const at = pos;
      const word = readWhile(IDENT_PART);
      if (word !== "DO") fail('Expected "DO" or "}" inside an edge block', at, "UNEXPECTED_TOKEN");
      skipInline();
      const typeAt = pos;
      const type = readIdent("an action type");
      skipTrivia();
      let data: JsonObject = {};
      if (peek() === "{") {
        data = readJsonObject();
        skipTrivia();
      }
      const repeat = peek() === "r" ? readRepeat() : undefined;
      const loc = locate(typeAt);
      actions.push({ type, data, ...(repeat !== undefined ? { repeat } : {}), line: loc.line, column: loc.column });
    }
  };

  /**
   * Reads `repeat=4`, `repeat="$COUNT$"` or `repeat=$COUNT$` after a DO payload.
   * Whether a number is a usable count is checked by validation, like `cost`.
   */
  const readRepeat = (): number | string => {
    const at = pos;
    if (readWhile(IDENT_PART) !== "repeat") fail('Expected "DO" or "}" inside an edge block', at, "UNEXPECTED_TOKEN");
    skipInline();
    if (peek() !== "=") fail('Expected "=" after "repeat"', pos, "EXPECTED_EQUALS");
    pos++;
    skipInline();
    const valueAt = pos;
    if (peek() === '"') return readString();
    const raw = readWhile(/[^\s#}]/);
    if (/^\$[A-Za-z_][A-Za-z0-9_]*\$$/.test(raw)) return raw;
    let n: unknown;
    try {
      n = JSON.parse(raw);
    } catch {
      n = undefined;
    }
    if (typeof n !== "number") fail(`repeat must be a whole number or a $NAME$ variable reference, got ${raw === "" ? "nothing" : raw}`, valueAt, "INVALID_REPEAT");
    return n as number;
  };

  // ---- body ----
  for (;;) {
    skipTrivia();
    if (eof()) break;
    const itemAt = pos;
    if (!IDENT_START.test(peek())) fail(`Unexpected character "${peek()}"`, pos, "UNEXPECTED_TOKEN");
    const word = readId("a declaration");
    // Decide between keyword and an edge whose source is named like a keyword.
    const save = pos;
    skipInline();
    const isEdge = peek() === "-" && peek(1) === ">";
    pos = save;

    if (!isEdge && KEYWORDS.has(word)) {
      if (word === "END") {
        expectEol("END");
        graph.hasEnd = true;
        skipTrivia();
        if (!eof()) fail("Unexpected content after END", pos, "TRAILING_CONTENT");
        break;
      }
      if (word === "DO") fail('"DO" is only valid inside an edge block', itemAt, "UNEXPECTED_TOKEN");
      skipInline();
      if (word === "APP") {
        if (graph.app !== undefined) fail("Duplicate APP declaration", itemAt, "DUPLICATE_APP");
        graph.app = readString();
        expectEol("APP declaration");
      } else if (word === "SCREEN" || word === "ACTION") {
        const actionNode = word === "ACTION";
        const id = readId(`a ${actionNode ? "action" : "screen"} id`);
        skipInline();
        const name = readString();
        skipInline();
        const meta: JsonObject = peek() === "{" ? readJsonObject() : {};
        if (actionNode) setOwn(meta, "kind", meta.kind ?? "action");
        expectEol(`${word} declaration`);
        const loc = locate(itemAt);
        const screen: RawScreen = { id, name, meta, line: loc.line, column: loc.column };
        graph.screens.push(screen);
      } else {
        // VAR NAME : type [= value]
        const name = readIdent("a variable name");
        skipInline();
        if (peek() !== ":") fail('Expected ":" after variable name', pos, "EXPECTED_COLON");
        pos++;
        skipInline();
        const typeAt = pos;
        const type = readIdent("a variable type");
        if (!(VARIABLE_TYPES as readonly string[]).includes(type)) {
          fail(`Unknown variable type "${type}"`, typeAt, "UNKNOWN_VARIABLE_TYPE");
        }
        skipInline();
        let decl: VariableDeclaration;
        const loc = locate(itemAt);
        if (peek() === "=") {
          pos++;
          skipInline();
          const value = readJsonValue();
          decl = { name, type: type as VariableType, hasDefault: true, default: value, line: loc.line, column: loc.column };
        } else {
          decl = { name, type: type as VariableType, hasDefault: false, line: loc.line, column: loc.column };
        }
        expectEol("VAR declaration");
        graph.variables.push(decl);
      }
      continue;
    }

    // edge
    skipInline();
    pos += 2; // ->
    skipInline();
    const to = readId("a destination screen id");
    skipTrivia();
    let attrs: Pick<RawEdge, "id" | "cost" | "condition" | "meta"> = { meta: {} };
    if (peek() === "[") {
      attrs = parseAttributes();
      skipTrivia();
    }
    const actions = peek() === "{" ? parseActions() : [];
    const loc = locate(itemAt);
    graph.edges.push({ ...attrs, from: word, to, actions, line: loc.line, column: loc.column });
  }
  return graph;
}
