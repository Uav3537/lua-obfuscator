"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  LexError: () => LexError,
  ParseError: () => ParseError,
  UnknownDialectError: () => UnknownDialectError,
  generate: () => generate,
  obfuscate: () => obfuscate,
  parse: () => parse,
  resolveScopes: () => resolveScopes
});
module.exports = __toCommonJS(index_exports);

// src/lexer/tokens.ts
var LiteralTypes = 2 /* StringLiteral */ | 16 /* NumericLiteral */ | 64 /* BooleanLiteral */ | 128 /* NilLiteral */ | 256 /* VarargLiteral */;
var KEYWORDS = /* @__PURE__ */ new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while"
]);
var LUAU_ONLY_KEYWORDS = /* @__PURE__ */ new Set(["continue"]);
var GOTO_KEYWORDS = /* @__PURE__ */ new Set(["goto"]);
function isKeyword(word, continueKeyword, gotoKeyword) {
  if (KEYWORDS.has(word)) return true;
  if (continueKeyword && LUAU_ONLY_KEYWORDS.has(word)) return true;
  if (gotoKeyword && GOTO_KEYWORDS.has(word)) return true;
  return false;
}

// src/lexer/lexer.ts
var WHITESPACE = /* @__PURE__ */ new Set([" ", "	", "\r", "\n"]);
function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function isHexDigit(ch) {
  return isDigit(ch) || ch >= "a" && ch <= "f" || ch >= "A" && ch <= "F";
}
function isIdentStart(ch) {
  return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch === "_";
}
function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}
function parseHexNumber(raw) {
  const match = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(raw);
  if (!match || match[1] === "" && (match[2] ?? "") === "") return NaN;
  const [, intDigits, fracDigits, expDigits] = match;
  let mantissa = intDigits.length > 0 ? parseInt(intDigits, 16) : 0;
  if (fracDigits && fracDigits.length > 0) {
    mantissa += parseInt(fracDigits, 16) / Math.pow(16, fracDigits.length);
  }
  const exponent = expDigits !== void 0 ? parseInt(expDigits, 10) : 0;
  return mantissa * Math.pow(2, exponent);
}
var LexError = class extends Error {
  constructor(message, line, column) {
    super(`[${line}:${column}] ${message}`);
    this.line = line;
    this.column = column;
  }
  line;
  column;
};
var Lexer = class {
  // pos where the current line starts (for column calculation)
  constructor(src, dialect) {
    this.src = src;
    this.dialect = dialect;
  }
  src;
  dialect;
  pos = 0;
  line = 1;
  lineStart = 0;
  get column() {
    return this.pos - this.lineStart + 1;
  }
  peek(offset = 0) {
    return this.src.charAt(this.pos + offset);
  }
  advance() {
    const ch = this.src.charAt(this.pos);
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.lineStart = this.pos;
    }
    return ch;
  }
  match(ch) {
    if (this.peek() === ch) {
      this.advance();
      return true;
    }
    return false;
  }
  error(msg) {
    throw new LexError(msg, this.line, this.column);
  }
  /** Pulls the entire source into a token array in one pass (includes the EOF token). */
  tokenize() {
    const tokens = [];
    for (; ; ) {
      const tok = this.next();
      tokens.push(tok);
      if (tok.type === 1 /* EOF */) break;
    }
    return tokens;
  }
  /** Reads and returns the next single token. */
  next() {
    this.skipWhitespaceAndComments();
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.pos;
    if (this.pos >= this.src.length) {
      return this.makeToken(1 /* EOF */, null, startPos, startLine, startColumn);
    }
    const ch = this.peek();
    if (isIdentStart(ch)) return this.scanIdentifierOrKeyword(startPos, startLine, startColumn);
    if (isDigit(ch) || ch === "." && isDigit(this.peek(1))) {
      return this.scanNumber(startPos, startLine, startColumn);
    }
    if (ch === '"' || ch === "'") return this.scanQuotedString(startPos, startLine, startColumn);
    if (ch === "`") return this.scanInterpolatedString(startPos, startLine, startColumn);
    if (ch === "[" && (this.peek(1) === "[" || this.peek(1) === "=")) {
      const long = this.tryScanLongBracket();
      if (long !== null) {
        return this.makeToken(2 /* StringLiteral */, long, startPos, startLine, startColumn);
      }
    }
    return this.scanPunctuator(startPos, startLine, startColumn);
  }
  // ---- Whitespace / comments ----
  skipWhitespaceAndComments() {
    for (; ; ) {
      const ch = this.peek();
      if (WHITESPACE.has(ch)) {
        this.advance();
        continue;
      }
      if (ch === "-" && this.peek(1) === "-") {
        this.advance();
        this.advance();
        if (this.peek() === "[" && (this.peek(1) === "[" || this.peek(1) === "=")) {
          const long = this.tryScanLongBracket();
          if (long !== null) continue;
        }
        while (this.pos < this.src.length && this.peek() !== "\n") this.advance();
        continue;
      }
      break;
    }
  }
  // ---- Identifiers / keywords ----
  scanIdentifierOrKeyword(startPos, line, column) {
    while (isIdentPart(this.peek())) this.advance();
    const word = this.src.slice(startPos, this.pos);
    if (word === "true" || word === "false") {
      return this.makeToken(64 /* BooleanLiteral */, word === "true", startPos, line, column);
    }
    if (word === "nil") {
      return this.makeToken(128 /* NilLiteral */, null, startPos, line, column);
    }
    if (isKeyword(word, this.dialect.continueKeyword, this.dialect.gotoStatements)) {
      return this.makeToken(4 /* Keyword */, word, startPos, line, column);
    }
    return this.makeToken(8 /* Identifier */, word, startPos, line, column);
  }
  // ---- Numbers ----
  scanNumber(startPos, line, column) {
    if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
      this.advance();
      this.advance();
      while (isHexDigit(this.peek())) this.advance();
      if (this.peek() === ".") {
        this.advance();
        while (isHexDigit(this.peek())) this.advance();
      }
      if (this.peek() === "p" || this.peek() === "P") {
        this.advance();
        if (this.peek() === "+" || this.peek() === "-") this.advance();
        while (isDigit(this.peek())) this.advance();
      }
    } else {
      while (isDigit(this.peek())) this.advance();
      if (this.peek() === ".") {
        this.advance();
        while (isDigit(this.peek())) this.advance();
      }
      if (this.peek() === "e" || this.peek() === "E") {
        this.advance();
        if (this.peek() === "+" || this.peek() === "-") this.advance();
        while (isDigit(this.peek())) this.advance();
      }
    }
    const raw = this.src.slice(startPos, this.pos);
    const value = raw.toLowerCase().startsWith("0x") ? parseHexNumber(raw) : parseFloat(raw);
    return this.makeToken(16 /* NumericLiteral */, value, startPos, line, column);
  }
  // ---- Plain quoted strings ("..." / '...') ----
  scanQuotedString(startPos, line, column) {
    const quote = this.advance();
    let value = "";
    for (; ; ) {
      if (this.pos >= this.src.length) this.error("unfinished string");
      const ch = this.peek();
      if (ch === quote) {
        this.advance();
        break;
      }
      if (ch === "\n") this.error("unfinished string");
      if (ch === "\\") {
        this.advance();
        value += this.readEscape();
        continue;
      }
      value += this.advance();
    }
    return this.makeToken(2 /* StringLiteral */, value, startPos, line, column);
  }
  readEscape() {
    const ch = this.advance();
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "	";
      case "r":
        return "\r";
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      case "\n":
        return "\n";
      case "x": {
        const hex = this.advance() + this.advance();
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        if (isDigit(ch)) {
          let digits = ch;
          for (let i = 0; i < 2 && isDigit(this.peek()); i++) digits += this.advance();
          return String.fromCharCode(parseInt(digits, 10));
        }
        return ch;
    }
  }
  // ---- Long-bracket strings/comments [[ ... ]], [=[ ... ]=], etc. ----
  // A null return means it wasn't a long bracket to begin with (e.g. just a `[` symbol).
  tryScanLongBracket() {
    const save = { pos: this.pos, line: this.line, lineStart: this.lineStart };
    if (this.peek() !== "[") return null;
    this.advance();
    let level = 0;
    while (this.peek() === "=") {
      level++;
      this.advance();
    }
    if (this.peek() !== "[") {
      this.pos = save.pos;
      this.line = save.line;
      this.lineStart = save.lineStart;
      return null;
    }
    this.advance();
    if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.advance();
      this.advance();
    } else if (this.peek() === "\n" || this.peek() === "\r") {
      this.advance();
    }
    const contentStart = this.pos;
    const closer = "]" + "=".repeat(level) + "]";
    const closeIdx = this.src.indexOf(closer, this.pos);
    if (closeIdx === -1) this.error("unfinished long string/comment");
    const content = this.src.slice(contentStart, closeIdx);
    while (this.pos < closeIdx + closer.length) this.advance();
    return content;
  }
  // ---- Luau string interpolation: `...{expr}...` ----
  scanInterpolatedString(startPos, line, column) {
    this.advance();
    const parts = [];
    let buf = "";
    for (; ; ) {
      if (this.pos >= this.src.length) this.error("unfinished interpolated string");
      const ch = this.peek();
      if (ch === "`") {
        this.advance();
        if (buf.length > 0 || parts.length === 0) parts.push({ kind: "string", value: buf });
        break;
      }
      if (ch === "\\") {
        this.advance();
        buf += this.readEscape();
        continue;
      }
      if (ch === "{") {
        if (this.peek(1) === "{") {
          this.advance();
          this.advance();
          buf += "{";
          continue;
        }
        parts.push({ kind: "string", value: buf });
        buf = "";
        this.advance();
        const exprLine = this.line;
        const exprColumn = this.column;
        const exprStart = this.pos;
        this.skipBalancedInterpolationExpr();
        const exprSource = this.src.slice(exprStart, this.pos);
        this.advance();
        parts.push({ kind: "expr", source: exprSource, line: exprLine, column: exprColumn });
        continue;
      }
      buf += this.advance();
    }
    return this.makeToken(
      512 /* InterpolatedStringLiteral */,
      null,
      startPos,
      line,
      column,
      parts
    );
  }
  /**
   * Right after consuming `{`, advances pos up to the matching `}` (that `}`
   * is left unconsumed - the caller slices out exprSource and consumes it).
   * Any `"..."` / `'...'` / `` `...` `` string encountered along the way is
   * skipped wholesale, so its inner `{`/`}` are ignored for depth counting.
   */
  skipBalancedInterpolationExpr() {
    let depth = 1;
    while (depth > 0) {
      if (this.pos >= this.src.length) this.error("unfinished interpolation expression");
      const c = this.peek();
      if (c === '"' || c === "'") {
        this.skipRawQuotedString();
        continue;
      }
      if (c === "`") {
        this.skipRawInterpolatedString();
        continue;
      }
      if (c === "{") {
        depth++;
        this.advance();
        continue;
      }
      if (c === "}") {
        depth--;
        if (depth === 0) return;
        this.advance();
        continue;
      }
      this.advance();
    }
  }
  /** Skips over `"..."` / `'...'` as raw text without interpreting it as a value (escapes are just skipped). */
  skipRawQuotedString() {
    const quote = this.advance();
    while (true) {
      if (this.pos >= this.src.length) this.error("unfinished string");
      const ch = this.peek();
      if (ch === quote) {
        this.advance();
        return;
      }
      if (ch === "\n") this.error("unfinished string");
      if (ch === "\\") {
        this.advance();
        if (this.pos < this.src.length) this.advance();
        continue;
      }
      this.advance();
    }
  }
  /**
   * Skip logic for an interpolated string nested inside another interpolation
   * expression (`` `{`nested {x}`}` ``). The inner `{expr}` also needs to be
   * skipped recursively in a balanced way, so its strings/braces don't
   * disturb the outer depth count.
   */
  skipRawInterpolatedString() {
    this.advance();
    while (true) {
      if (this.pos >= this.src.length) this.error("unfinished interpolated string");
      const ch = this.peek();
      if (ch === "`") {
        this.advance();
        return;
      }
      if (ch === "\\") {
        this.advance();
        if (this.pos < this.src.length) this.advance();
        continue;
      }
      if (ch === "{") {
        if (this.peek(1) === "{") {
          this.advance();
          this.advance();
          continue;
        }
        this.advance();
        this.skipBalancedInterpolationExpr();
        if (this.peek() === "}") this.advance();
        continue;
      }
      this.advance();
    }
  }
  // ---- Punctuators (operators/symbols), including Luau's compound assignment operators ----
  scanPunctuator(startPos, line, column) {
    const ch = this.advance();
    if (ch === "." && this.peek() === "." && this.peek(1) === ".") {
      this.advance();
      this.advance();
      return this.makeToken(256 /* VarargLiteral */, "...", startPos, line, column);
    }
    const two = ch + this.peek();
    const twoCharPunctuators = /* @__PURE__ */ new Set([
      "==",
      "~=",
      "<=",
      ">=",
      "::",
      "..",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "^=",
      // Luau compound assignment
      "->",
      // Luau function type: (number) -> string
      "?.",
      "?["
      // Luau optional chaining: a?.b / a?[b]
    ]);
    if (twoCharPunctuators.has(two)) {
      this.advance();
      return this.makeToken(32 /* Punctuator */, two, startPos, line, column);
    }
    if (ch === "/" && this.peek() === "/") {
      this.advance();
      if (this.peek() === "=") {
        this.advance();
        return this.makeToken(32 /* Punctuator */, "//=", startPos, line, column);
      }
      return this.makeToken(32 /* Punctuator */, "//", startPos, line, column);
    }
    if (ch === "." && this.peek() === "." && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return this.makeToken(32 /* Punctuator */, "..=", startPos, line, column);
    }
    const singleCharPunctuators = /* @__PURE__ */ new Set([
      "+",
      "-",
      "*",
      "/",
      "%",
      "^",
      "#",
      "&",
      "~",
      "|",
      "<",
      ">",
      "=",
      "(",
      ")",
      "{",
      "}",
      "[",
      "]",
      ";",
      ":",
      ",",
      ".",
      "?"
      // '?' is used in Luau optional types (T?)
    ]);
    if (singleCharPunctuators.has(ch)) {
      return this.makeToken(32 /* Punctuator */, ch, startPos, line, column);
    }
    this.error(`unexpected symbol '${ch}'`);
  }
  makeToken(type, value, startPos, line, column, parts) {
    return {
      type,
      value,
      raw: this.src.slice(startPos, this.pos),
      line,
      column,
      range: [startPos, this.pos],
      parts
    };
  }
};

// src/parser/cursor.ts
var ParseError = class extends Error {
  constructor(message, line, column) {
    super(`[${line}:${column}] ${message}`);
    this.line = line;
    this.column = column;
  }
  line;
  column;
};
var Cursor = class {
  constructor(tokens, dialect) {
    this.tokens = tokens;
    this.dialect = dialect;
  }
  tokens;
  dialect;
  pos = 0;
  // ---- Basic lookup / movement ----
  current() {
    return this.tokens[this.pos];
  }
  peek(offset = 0) {
    const idx = this.pos + offset;
    return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
  }
  previous() {
    return this.tokens[this.pos - 1];
  }
  isAtEnd() {
    return this.current().type === 1 /* EOF */;
  }
  advance() {
    const tok = this.current();
    if (!this.isAtEnd()) this.pos++;
    return tok;
  }
  // ---- Checks ----
  check(type, value) {
    const tok = this.current();
    if (tok.type !== type) return false;
    if (value !== void 0 && tok.value !== value) return false;
    return true;
  }
  checkKeyword(word) {
    return this.check(4 /* Keyword */, word);
  }
  checkPunct(value) {
    return this.check(32 /* Punctuator */, value);
  }
  match(type, value) {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }
  matchKeyword(word) {
    return this.match(4 /* Keyword */, word);
  }
  matchPunct(value) {
    return this.match(32 /* Punctuator */, value);
  }
  // ---- Mandatory consumption (error on failure) ----
  expect(type, value, message) {
    if (!this.check(type, value)) {
      this.error(message);
    }
    return this.advance();
  }
  expectPunct(value) {
    return this.expect(32 /* Punctuator */, value, `expected '${value}' but found ${this.describeCurrent()}`);
  }
  expectKeyword(word) {
    return this.expect(4 /* Keyword */, word, `expected '${word}' but found ${this.describeCurrent()}`);
  }
  expectIdentifierName() {
    return this.expect(8 /* Identifier */, void 0, `expected an identifier but found ${this.describeCurrent()}`);
  }
  describeCurrent() {
    const tok = this.current();
    if (tok.type === 1 /* EOF */) return "<eof>";
    return `'${tok.raw}'`;
  }
  // ---- Dialect gating ----
  /** Error if the current token requires a feature that's disabled in this dialect. No-op if enabled (caller proceeds). */
  requireDialectFeature(enabled, featureName) {
    if (!enabled) {
      this.error(`'${featureName}' is Luau-only syntax (current dialect: ${this.dialect.name})`);
    }
  }
  // ---- Errors ----
  error(msg) {
    const tok = this.current();
    throw new ParseError(msg, tok.line, tok.column);
  }
  // ---- Position calculation ----
  posOf(tok) {
    return { line: tok.line, column: tok.column };
  }
  /** Computes the loc/range spanning from startTok to the "last consumed token". */
  finishRange(startTok, endTok = this.previous()) {
    return {
      range: [startTok.range[0], endTok.range[1]],
      loc: {
        start: this.posOf(startTok),
        end: { line: endTok.line, column: endTok.column + (endTok.raw?.length ?? 0) }
      }
    };
  }
};

// src/parser/types.ts
var TypeParser = class extends Cursor {
  // ---- Entry point ----
  parseTypeAnnotation() {
    return this.parseType();
  }
  parseType() {
    return this.parseUnionType();
  }
  parseUnionType() {
    this.matchPunct("|");
    const start = this.current();
    const first = this.parseIntersectionType();
    if (!this.checkPunct("|")) return first;
    const types = [first];
    while (this.matchPunct("|")) {
      types.push(this.parseIntersectionType());
    }
    return { type: "TypeUnion", types, ...this.finishRange(start) };
  }
  parseIntersectionType() {
    this.matchPunct("&");
    const start = this.current();
    const first = this.parseOptionalType();
    if (!this.checkPunct("&")) return first;
    const types = [first];
    while (this.matchPunct("&")) {
      types.push(this.parseOptionalType());
    }
    return { type: "TypeIntersection", types, ...this.finishRange(start) };
  }
  parseOptionalType() {
    const start = this.current();
    let base2 = this.parsePrimaryType();
    while (this.matchPunct("?")) {
      base2 = { type: "TypeOptional", base: base2, ...this.finishRange(start) };
    }
    return base2;
  }
  // ---- Primary types ----
  parsePrimaryType() {
    const start = this.current();
    if (this.checkPunct("(")) return this.parseParenOrFunctionType();
    if (this.checkPunct("{")) return this.parseTableType();
    if (this.check(2 /* StringLiteral */)) {
      const tok = this.advance();
      return { type: "TypeLiteralString", value: tok.value, ...this.finishRange(start) };
    }
    if (this.checkKeyword("true") || this.checkKeyword("false")) {
    }
    if (this.check(64 /* BooleanLiteral */)) {
      const tok = this.advance();
      return { type: "TypeLiteralBoolean", value: tok.value, ...this.finishRange(start) };
    }
    if (this.checkKeyword("nil")) {
      this.advance();
      return { type: "TypeReference", name: "nil", typeArguments: [], ...this.finishRange(start) };
    }
    if (this.check(8 /* Identifier */, "typeof")) {
      return this.parseTypeofType();
    }
    if (this.check(8 /* Identifier */) || this.checkKeyword("function")) {
      return this.parseTypeReference();
    }
    if (this.checkPunct("<")) {
      return this.parseFunctionTypeWithGenerics();
    }
    this.error(`expected a type but found ${this.current().type === 1 /* EOF */ ? "<eof>" : `'${this.current().raw}'`}`);
  }
  parseTypeReference() {
    const start = this.current();
    let name = this.expect(8 /* Identifier */, void 0, "expected a type name").value;
    while (this.matchPunct(".")) {
      const part = this.expectIdentifierName();
      name += "." + part.value;
    }
    const typeArguments = this.checkPunct("<") ? this.parseTypeArgumentList() : [];
    return { type: "TypeReference", name, typeArguments, ...this.finishRange(start) };
  }
  parseTypeArgumentList() {
    this.expectPunct("<");
    const args = [];
    if (!this.checkPunct(">")) {
      args.push(this.parseType());
      while (this.matchPunct(",")) args.push(this.parseType());
    }
    this.closeAngleBracket();
    return args;
  }
  /**
   * `<`/`>` are lexed as plain Punctuators, so two of them stuck together
   * like `>>` don't get merged into a single token (that two-char combo isn't
   * in twoCharPunctuators) — but that's fine, because even nested generics
   * like `Foo<Bar<Baz>>` always lex correctly as two separate '>' tokens.
   */
  closeAngleBracket() {
    this.expectPunct(">");
  }
  parseTypeofType() {
    const start = this.current();
    this.advance();
    this.expectPunct("(");
    const expression = this.parseExpression();
    this.expectPunct(")");
    return { type: "TypeTypeof", expression, ...this.finishRange(start) };
  }
  parseTableType() {
    const start = this.current();
    this.expectPunct("{");
    const fields = [];
    while (!this.checkPunct("}")) {
      if (this.checkPunct("[")) {
        this.advance();
        const keyType = this.parseType();
        this.expectPunct("]");
        this.expectPunct(":");
        const valueType = this.parseType();
        fields.push({ key: keyType, value: valueType });
      } else if (this.check(8 /* Identifier */) && this.peek(1).type === 32 /* Punctuator */ && this.peek(1).value === ":") {
        const name = this.advance().value;
        this.advance();
        const valueType = this.parseType();
        fields.push({ key: name, value: valueType });
      } else {
        const valueType = this.parseType();
        fields.push({ key: null, value: valueType });
      }
      if (!this.matchPunct(",") && !this.matchPunct(";")) break;
    }
    this.expectPunct("}");
    return { type: "TypeTable", fields, ...this.finishRange(start) };
  }
  /** Having just seen '(': decide whether this is a function type `(A, B) -> C` or a plain parenthesized type `(T)` */
  parseParenOrFunctionType() {
    const start = this.current();
    const { parameters, vararg } = this.parseFunctionParamList();
    if (this.matchPunct("->")) {
      const returns = this.parseReturnTypeList();
      return { type: "TypeFunction", generics: [], parameters, returns, ...this.finishRange(start) };
    }
    if (parameters.length === 1 && !vararg && parameters[0].name === null) {
      return { type: "TypeParenthesized", type_: parameters[0].type, ...this.finishRange(start) };
    }
    this.error("a parenthesized type without '->' can only contain a single type (if this was meant to be a function type, check that you didn't forget the '->')");
  }
  parseFunctionTypeWithGenerics() {
    const start = this.current();
    const generics = this.parseGenericTypeParameterList();
    const { parameters, vararg } = this.parseFunctionParamList();
    this.expectPunct("->");
    const returns = this.parseReturnTypeList();
    void vararg;
    return { type: "TypeFunction", generics, parameters, returns, ...this.finishRange(start) };
  }
  parseFunctionParamList() {
    this.expectPunct("(");
    const parameters = [];
    let vararg = null;
    if (!this.checkPunct(")")) {
      for (; ; ) {
        if (this.check(256 /* VarargLiteral */)) {
          this.advance();
          const varStart = this.previous();
          if (this.checkPunct(":")) {
            this.advance();
            const base2 = this.parseType();
            vararg = { type: "TypeVariadic", base: base2, ...this.finishRange(varStart) };
          } else {
            const anyRef = {
              type: "TypeReference",
              name: "any",
              typeArguments: [],
              ...this.finishRange(varStart)
            };
            vararg = { type: "TypeVariadic", base: anyRef, ...this.finishRange(varStart) };
          }
          break;
        }
        if (this.check(8 /* Identifier */) && this.peek(1).type === 32 /* Punctuator */ && this.peek(1).value === ":") {
          const name = this.advance().value;
          this.advance();
          const t = this.parseType();
          parameters.push({ name, type: t });
        } else {
          const t = this.parseType();
          parameters.push({ name: null, type: t });
        }
        if (!this.matchPunct(",")) break;
      }
    }
    this.expectPunct(")");
    return { parameters, vararg };
  }
  parseReturnTypeList() {
    if (this.checkPunct("(")) {
      const { parameters, vararg } = this.parseFunctionParamList();
      return { types: parameters.map((p) => p.type), vararg };
    }
    if (this.check(256 /* VarargLiteral */)) {
      const start = this.advance();
      this.expectPunct(":");
      const base2 = this.parseType();
      return { types: [], vararg: { type: "TypeVariadic", base: base2, ...this.finishRange(start) } };
    }
    const single = this.parseType();
    return { types: [single], vararg: null };
  }
  // ---- Generic parameter list: <T, U = DefaultType, V...> ----
  parseGenericTypeParameterList() {
    if (!this.checkPunct("<")) return [];
    this.advance();
    const params = [];
    if (!this.checkPunct(">")) {
      params.push(this.parseGenericTypeParameter());
      while (this.matchPunct(",")) params.push(this.parseGenericTypeParameter());
    }
    this.closeAngleBracket();
    return params;
  }
  parseGenericTypeParameter() {
    const name = this.expectIdentifierName().value;
    if (this.check(256 /* VarargLiteral */)) {
      this.advance();
      return { name: name + "...", defaultType: null };
    }
    let defaultType = null;
    if (this.matchPunct("=")) {
      defaultType = this.parseType();
    }
    return { name, defaultType };
  }
};

// src/parser/precedence.ts
var UNARY_PRECEDENCE = 8;
var TABLE = {
  or: { precedence: 1, rightAssoc: false },
  and: { precedence: 2, rightAssoc: false },
  "<": { precedence: 3, rightAssoc: false },
  ">": { precedence: 3, rightAssoc: false },
  "<=": { precedence: 3, rightAssoc: false },
  ">=": { precedence: 3, rightAssoc: false },
  "~=": { precedence: 3, rightAssoc: false },
  "==": { precedence: 3, rightAssoc: false },
  "..": { precedence: 4, rightAssoc: true },
  "+": { precedence: 5, rightAssoc: false },
  "-": { precedence: 5, rightAssoc: false },
  "*": { precedence: 6, rightAssoc: false },
  "/": { precedence: 6, rightAssoc: false },
  "//": { precedence: 6, rightAssoc: false },
  // Luau-only; if lua5.1, the parser already rejects the token before this matters
  "%": { precedence: 6, rightAssoc: false },
  "^": { precedence: 9, rightAssoc: true }
  // binds even tighter than unary (8): -x^2 === -(x^2)
};
function getBinaryOpInfo(op) {
  return TABLE[op] ?? null;
}
function isLogicalOperator(op) {
  return op === "and" || op === "or";
}

// src/parser/parser.ts
var COMPOUND_ASSIGNMENT_OPS = /* @__PURE__ */ new Set(["+=", "-=", "*=", "/=", "//=", "%=", "^=", "..="]);
var Parser = class _Parser extends TypeParser {
  constructor(tokens, dialect) {
    super(tokens, dialect);
  }
  // =========================================================================
  // Entry point
  // =========================================================================
  parseChunk() {
    const start = this.current();
    const body = this.parseBlock();
    const eof = this.expect(1 /* EOF */, void 0, `expected <eof> but found ${this.currentDescription()}`);
    return {
      type: "Chunk",
      body,
      range: [start.range[0], eof.range[1]],
      loc: { start: this.posOf(start), end: this.posOf(eof) }
    };
  }
  currentDescription() {
    const tok = this.current();
    return tok.type === 1 /* EOF */ ? "<eof>" : `'${tok.raw}'`;
  }
  // =========================================================================
  // Blocks / statements
  // =========================================================================
  isBlockEnd() {
    if (this.isAtEnd()) return true;
    return this.checkKeyword("end") || this.checkKeyword("else") || this.checkKeyword("elseif") || this.checkKeyword("until");
  }
  parseBlock() {
    const stmts = [];
    while (!this.isBlockEnd()) {
      if (this.checkKeyword("return")) {
        stmts.push(this.parseReturnStatement());
        break;
      }
      const stmt = this.parseStatement();
      if (stmt) stmts.push(stmt);
    }
    return stmts;
  }
  parseStatement() {
    if (this.matchPunct(";")) return null;
    if (this.checkKeyword("if")) return this.parseIfStatement();
    if (this.checkKeyword("while")) return this.parseWhileStatement();
    if (this.checkKeyword("do")) return this.parseDoStatement();
    if (this.checkKeyword("for")) return this.parseForStatement();
    if (this.checkKeyword("repeat")) return this.parseRepeatStatement();
    if (this.checkKeyword("function")) return this.parseFunctionStatement();
    if (this.checkKeyword("local")) return this.parseLocalStatement();
    if (this.checkKeyword("break")) return this.parseBreakStatement();
    if (this.checkKeyword("continue")) return this.parseContinueStatement();
    if (this.checkPunct("::")) return this.parseLabelStatement();
    if (this.checkKeyword("goto")) return this.parseGotoStatement();
    if (this.isTypeAliasStart()) return this.parseTypeAliasStatement();
    return this.parseExpressionStatement();
  }
  // ---- Individual statements ----
  parseIfStatement() {
    const start = this.current();
    this.advance();
    const clauses = [];
    const firstClauseStart = start;
    const condition = this.parseExpression();
    this.expectKeyword("then");
    const body = this.parseBlock();
    clauses.push({ type: "IfClause", condition, body, ...this.finishRange(firstClauseStart) });
    while (this.checkKeyword("elseif")) {
      const clauseStart = this.current();
      this.advance();
      const cond = this.parseExpression();
      this.expectKeyword("then");
      const b = this.parseBlock();
      clauses.push({ type: "ElseifClause", condition: cond, body: b, ...this.finishRange(clauseStart) });
    }
    if (this.checkKeyword("else")) {
      const clauseStart = this.current();
      this.advance();
      const b = this.parseBlock();
      clauses.push({ type: "ElseClause", body: b, ...this.finishRange(clauseStart) });
    }
    this.expectKeyword("end");
    return { type: "IfStatement", clauses, ...this.finishRange(start) };
  }
  parseWhileStatement() {
    const start = this.current();
    this.advance();
    const condition = this.parseExpression();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "WhileStatement", condition, body, ...this.finishRange(start) };
  }
  parseDoStatement() {
    const start = this.current();
    this.advance();
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "DoStatement", body, ...this.finishRange(start) };
  }
  parseRepeatStatement() {
    const start = this.current();
    this.advance();
    const body = this.parseBlock();
    this.expectKeyword("until");
    const condition = this.parseExpression();
    return { type: "RepeatStatement", condition, body, ...this.finishRange(start) };
  }
  parseForStatement() {
    const start = this.current();
    this.advance();
    const firstNameTok = this.expectIdentifierName();
    const firstVar = this.identifierFromToken(firstNameTok, "local", false);
    if (this.matchPunct("=")) {
      const from = this.parseExpression();
      this.expectPunct(",");
      const to = this.parseExpression();
      let step = null;
      if (this.matchPunct(",")) step = this.parseExpression();
      this.expectKeyword("do");
      const body2 = this.parseBlock();
      this.expectKeyword("end");
      return { type: "ForNumericStatement", variable: firstVar, start: from, end: to, step, body: body2, ...this.finishRange(start) };
    }
    const variables = [firstVar];
    while (this.matchPunct(",")) {
      variables.push(this.identifierFromToken(this.expectIdentifierName(), "local", false));
    }
    this.expectKeyword("in");
    const iterators = this.parseExpressionList();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "ForGenericStatement", variables, iterators, body, ...this.finishRange(start) };
  }
  parseFunctionStatement() {
    const start = this.current();
    this.advance();
    const { identifier, isMethod } = this.parseFuncName();
    const body = this.parseFunctionBody(isMethod);
    return { type: "FunctionDeclaration", identifier, isLocal: false, isMethod, ...body, ...this.finishRange(start) };
  }
  /** funcname: Name {'.' Name} [':' Name] */
  parseFuncName() {
    const start = this.current();
    const nameTok = this.expectIdentifierName();
    let node = this.identifierFromToken(nameTok, "global", false);
    while (this.matchPunct(".")) {
      const idTok = this.expectIdentifierName();
      node = {
        type: "MemberExpression",
        indexer: ".",
        base: node,
        identifier: this.identifierFromToken(idTok, "global", true),
        optional: false,
        ...this.finishRange(start)
      };
    }
    let isMethod = false;
    if (this.matchPunct(":")) {
      const idTok = this.expectIdentifierName();
      node = {
        type: "MemberExpression",
        indexer: ":",
        base: node,
        identifier: this.identifierFromToken(idTok, "global", true),
        optional: false,
        ...this.finishRange(start)
      };
      isMethod = true;
    }
    return { identifier: node, isMethod };
  }
  parseLocalStatement() {
    const start = this.current();
    this.advance();
    if (this.matchKeyword("function")) {
      const nameTok = this.expectIdentifierName();
      const identifier = this.identifierFromToken(nameTok, "local", false);
      const body = this.parseFunctionBody(false);
      return { type: "FunctionDeclaration", identifier, isLocal: true, isMethod: false, ...body, ...this.finishRange(start) };
    }
    const variables = [];
    for (; ; ) {
      const nameTok = this.expectIdentifierName();
      const id = this.identifierFromToken(nameTok, "local", false);
      if (this.checkPunct("<")) {
        if (!this.dialect.attributes) {
          this.error(`variable attributes (<const>/<close>) are Luau-only syntax (current dialect: ${this.dialect.name})`);
        }
        this.advance();
        const attrTok = this.expectIdentifierName();
        const attrName = attrTok.value;
        if (attrName !== "const" && attrName !== "close") {
          this.error(`unknown variable attribute '${attrName}' (only const or close are allowed)`);
        }
        id.attribute = attrName;
        this.expectPunct(">");
      }
      if (this.checkPunct(":")) {
        this.advance();
        if (!this.dialect.typeAnnotations) {
          this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
        }
        this.parseType();
      }
      variables.push(id);
      if (!this.matchPunct(",")) break;
    }
    let init = [];
    if (this.matchPunct("=")) init = this.parseExpressionList();
    return { type: "LocalStatement", variables, init, ...this.finishRange(start) };
  }
  parseReturnStatement() {
    const start = this.current();
    this.advance();
    let args = [];
    if (!this.isBlockEnd() && !this.checkPunct(";")) {
      args = this.parseExpressionList();
    }
    this.matchPunct(";");
    return { type: "ReturnStatement", arguments: args, ...this.finishRange(start) };
  }
  parseBreakStatement() {
    const start = this.advance();
    return { type: "BreakStatement", ...this.finishRange(start) };
  }
  parseContinueStatement() {
    const start = this.advance();
    return { type: "ContinueStatement", ...this.finishRange(start) };
  }
  parseGotoStatement() {
    const start = this.current();
    this.advance();
    const label = this.expectIdentifierName().value;
    return { type: "GotoStatement", label, ...this.finishRange(start) };
  }
  parseLabelStatement() {
    const start = this.current();
    if (!this.dialect.gotoStatements) {
      this.error(
        `'::label::' is not supported (current dialect: ${this.dialect.name}) \u2014 goto/labels are a Lua 5.2+ feature; neither Lua 5.1 nor Luau implement them`
      );
    }
    this.advance();
    const name = this.expectIdentifierName().value;
    this.expectPunct("::");
    return { type: "LabelStatement", name, ...this.finishRange(start) };
  }
  /** `type`/`export` aren't reserved words — they're identifiers judged by context, so we have to look ahead before consuming them */
  isTypeAliasStart() {
    if (!this.dialect.typeAnnotations) return false;
    if (this.check(8 /* Identifier */, "type") && this.peek(1).type === 8 /* Identifier */) return true;
    if (this.check(8 /* Identifier */, "export") && this.peek(1).type === 8 /* Identifier */ && this.peek(1).value === "type" && this.peek(2).type === 8 /* Identifier */) return true;
    return false;
  }
  /**
   * `type X = ...` / `export type X = ...`. Fully consumed per Luau's type
   * grammar so the parser's position stays correct, but no AST node is ever
   * built for it — the statement is ignored outright, the same as a
   * comment, rather than being represented and then stripped later.
   */
  parseTypeAliasStatement() {
    if (this.check(8 /* Identifier */, "export")) {
      this.advance();
    }
    this.advance();
    this.expectIdentifierName();
    this.parseGenericTypeParameterList();
    this.expectPunct("=");
    this.parseType();
    return null;
  }
  /** A statement that resolves to one of CallStatement / AssignmentStatement / CompoundAssignmentStatement */
  parseExpressionStatement() {
    const start = this.current();
    const first = this.parseSuffixedExpression();
    const opTok = this.current();
    if (opTok.type === 32 /* Punctuator */ && COMPOUND_ASSIGNMENT_OPS.has(opTok.value)) {
      if (!this.dialect.compoundAssignment) {
        this.error(`compound assignment operator '${opTok.value}' is Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      const variable = this.toAssignmentTarget(first);
      this.advance();
      const value = this.parseExpression();
      return {
        type: "CompoundAssignmentStatement",
        operator: opTok.value,
        variable,
        value,
        ...this.finishRange(start)
      };
    }
    if (this.checkPunct(",") || this.checkPunct("=")) {
      const variables = [this.toAssignmentTarget(first)];
      while (this.matchPunct(",")) {
        variables.push(this.toAssignmentTarget(this.parseSuffixedExpression()));
      }
      this.expectPunct("=");
      const init = this.parseExpressionList();
      return { type: "AssignmentStatement", variables, init, ...this.finishRange(start) };
    }
    if (first.type === "CallExpression" || first.type === "TableCallExpression" || first.type === "StringCallExpression") {
      return { type: "CallStatement", expression: first, ...this.finishRange(start) };
    }
    this.error("syntax error: this expression cannot be used as a statement (it must be a call or an assignment)");
  }
  toAssignmentTarget(expr) {
    if (expr.type === "Identifier" || expr.type === "MemberExpression" || expr.type === "IndexExpression") {
      return expr;
    }
    this.error("this expression cannot be an assignment target (only a variable, obj.field, or obj[key] form is allowed)");
  }
  // =========================================================================
  // Function body (shared by statements and expressions): [<generics>] '(' params ')' [':' returnType] block 'end'
  // =========================================================================
  parseFunctionBody(isMethod) {
    if (this.checkPunct("<")) {
      if (!this.dialect.genericFunctions) {
        this.error(`generic functions are Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      this.parseGenericTypeParameterList();
    }
    this.expectPunct("(");
    const parameters = [];
    if (isMethod) parameters.push(this.makeSelfIdentifier(this.previous()));
    let hasVararg = false;
    if (!this.checkPunct(")")) {
      for (; ; ) {
        if (this.check(256 /* VarargLiteral */)) {
          const varTok = this.advance();
          hasVararg = true;
          const varargNode = { type: "VarargLiteral", value: "...", ...this.finishRange(varTok, varTok) };
          parameters.push(varargNode);
          if (this.checkPunct(":")) {
            this.advance();
            if (!this.dialect.typeAnnotations) {
              this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
            }
            this.parseType();
          }
          break;
        }
        const nameTok = this.expectIdentifierName();
        const id = this.identifierFromToken(nameTok, "parameter", false);
        if (this.checkPunct(":")) {
          this.advance();
          if (!this.dialect.typeAnnotations) {
            this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
          }
          this.parseType();
        }
        parameters.push(id);
        if (!this.matchPunct(",")) break;
      }
    }
    this.expectPunct(")");
    if (this.checkPunct(":")) {
      this.advance();
      if (!this.dialect.typeAnnotations) {
        this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      this.parseReturnTypeList();
    }
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { parameters, body, hasVararg, varargTypeAnnotation: null, generics: [], returnTypeAnnotation: null };
  }
  makeSelfIdentifier(refTok) {
    return { type: "Identifier", name: "self", attribute: null, typeAnnotation: null, ...this.finishRange(refTok, refTok), scope: "parameter", isField: false, bindingId: null };
  }
  // NOTE: `scope` here is only ever the parser's syntactic best guess
  // ('local' at a `local`/for-loop declaration site, 'parameter' for a
  // function parameter, 'global' as a placeholder everywhere else). The
  // parser has no visibility into the surrounding scope chain, so a plain
  // reference like the `x` in `print(x)` is always stamped 'global' here
  // even when it actually resolves to an enclosing local or upvalue.
  // resolveScopes() (src/analysis/scope.ts) fixes this up for every
  // non-field Identifier in a single pass immediately after parseChunk()
  // returns — nothing downstream should trust `.scope`/`.bindingId` off the
  // raw parser output.
  identifierFromToken(tok, scope, isField) {
    return { type: "Identifier", name: tok.value, attribute: null, typeAnnotation: null, ...this.finishRange(tok, tok), scope, isField, bindingId: null };
  }
  // =========================================================================
  // Expressions (Pratt / precedence climbing)
  // =========================================================================
  parseExpression() {
    return this.parseBinaryExpression(0);
  }
  parseExpressionList() {
    const list = [this.parseExpression()];
    while (this.matchPunct(",")) list.push(this.parseExpression());
    return list;
  }
  currentOperatorString() {
    const tok = this.current();
    if (tok.type === 4 /* Keyword */ && (tok.value === "and" || tok.value === "or")) return tok.value;
    if (tok.type === 32 /* Punctuator */) return tok.value;
    return null;
  }
  parseBinaryExpression(minPrecedence) {
    const start = this.current();
    let left = this.parseUnaryExpression();
    for (; ; ) {
      const opStr = this.currentOperatorString();
      if (!opStr) break;
      const opInfo = getBinaryOpInfo(opStr);
      if (!opInfo || opInfo.precedence < minPrecedence) break;
      if (opStr === "//") this.requireDialectFeature(this.dialect.floorDivision, "// (integer division)");
      this.advance();
      const nextMinPrecedence = opInfo.rightAssoc ? opInfo.precedence : opInfo.precedence + 1;
      const right = this.parseBinaryExpression(nextMinPrecedence);
      left = isLogicalOperator(opStr) ? { type: "LogicalExpression", operator: opStr, left, right, ...this.finishRange(start) } : { type: "BinaryExpression", operator: opStr, left, right, ...this.finishRange(start) };
    }
    return left;
  }
  isUnaryOperatorToken() {
    return this.checkKeyword("not") || this.checkPunct("-") || this.checkPunct("#");
  }
  parseUnaryExpression() {
    if (this.isUnaryOperatorToken()) {
      const start = this.current();
      const opTok = this.advance();
      const argument = this.parseBinaryExpression(UNARY_PRECEDENCE);
      return {
        type: "UnaryExpression",
        operator: opTok.value,
        argument,
        ...this.finishRange(start)
      };
    }
    return this.parseCastExpression();
  }
  /**
   * Luau's type-ascription operator: `exp '::' Type`. Cast is a
   * compile-time-only annotation — it never changes the runtime value — so
   * it's parsed here (tightly, right after the suffixed/primary expression)
   * purely to consume the tokens correctly; the parsed Type is discarded
   * and the inner expression is returned completely unchanged. Chained
   * casts (`x :: any :: string`) are handled by the loop.
   */
  parseCastExpression() {
    const expr = this.parseSuffixedExpression();
    while (this.checkPunct("::")) {
      this.advance();
      if (!this.dialect.typeAnnotations) {
        this.error(`type ascription ('::') is Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      this.parseType();
    }
    return expr;
  }
  /** primaryexp { '.' Name | ':' Name call | '[' exp ']' | call } */
  parseSuffixedExpression() {
    const start = this.current();
    let expr = this.parsePrimaryAtom();
    for (; ; ) {
      if (this.matchPunct(".")) {
        const idTok = this.expectIdentifierName();
        expr = {
          type: "MemberExpression",
          indexer: ".",
          base: expr,
          identifier: this.identifierFromToken(idTok, "global", true),
          optional: false,
          ...this.finishRange(start)
        };
      } else if (this.matchPunct("[")) {
        const index = this.parseExpression();
        this.expectPunct("]");
        expr = { type: "IndexExpression", base: expr, index, optional: false, ...this.finishRange(start) };
      } else if (this.checkPunct("?.") || this.checkPunct("?[")) {
        this.requireDialectFeature(this.dialect.optionalChaining, "optional chaining (?./?[)");
        if (this.matchPunct("?.")) {
          const idTok = this.expectIdentifierName();
          expr = {
            type: "MemberExpression",
            indexer: ".",
            base: expr,
            identifier: this.identifierFromToken(idTok, "global", true),
            optional: true,
            ...this.finishRange(start)
          };
        } else {
          this.advance();
          const index = this.parseExpression();
          this.expectPunct("]");
          expr = { type: "IndexExpression", base: expr, index, optional: true, ...this.finishRange(start) };
        }
      } else if (this.matchPunct(":")) {
        const idTok = this.expectIdentifierName();
        const member = {
          type: "MemberExpression",
          indexer: ":",
          base: expr,
          identifier: this.identifierFromToken(idTok, "global", true),
          optional: false,
          ...this.finishRange(start)
        };
        expr = this.applyCallSuffix(member, start, true);
      } else if (this.checkPunct("(") || this.check(2 /* StringLiteral */) || this.checkPunct("{")) {
        expr = this.applyCallSuffix(expr, start, false);
      } else {
        break;
      }
    }
    return expr;
  }
  applyCallSuffix(base2, start, mandatory) {
    if (this.matchPunct("(")) {
      let args = [];
      if (!this.checkPunct(")")) args = this.parseExpressionList();
      this.expectPunct(")");
      return { type: "CallExpression", base: base2, arguments: args, ...this.finishRange(start) };
    }
    if (this.check(2 /* StringLiteral */)) {
      const tok = this.advance();
      const argument = { type: "StringLiteral", value: tok.value, raw: tok.raw, ...this.finishRange(tok, tok) };
      return { type: "StringCallExpression", base: base2, argument, ...this.finishRange(start) };
    }
    if (this.checkPunct("{")) {
      const table = this.parseTableConstructor();
      return { type: "TableCallExpression", base: base2, arguments: [table], ...this.finishRange(start) };
    }
    if (mandatory) {
      this.error('a method call requires arguments (e.g. obj:method(...), obj:method"str", obj:method{...})');
    }
    this.error("internal parser error: applyCallSuffix was entered in an invalid state");
  }
  parsePrimaryAtom() {
    const start = this.current();
    if (this.check(16 /* NumericLiteral */)) {
      const tok = this.advance();
      return { type: "NumericLiteral", value: tok.value, raw: tok.raw, ...this.finishRange(tok, tok) };
    }
    if (this.check(2 /* StringLiteral */)) {
      const tok = this.advance();
      return { type: "StringLiteral", value: tok.value, raw: tok.raw, ...this.finishRange(tok, tok) };
    }
    if (this.check(64 /* BooleanLiteral */)) {
      const tok = this.advance();
      return { type: "BooleanLiteral", value: tok.value, ...this.finishRange(tok, tok) };
    }
    if (this.check(128 /* NilLiteral */)) {
      const tok = this.advance();
      return { type: "NilLiteral", ...this.finishRange(tok, tok) };
    }
    if (this.check(256 /* VarargLiteral */)) {
      const tok = this.advance();
      return { type: "VarargLiteral", value: "...", ...this.finishRange(tok, tok) };
    }
    if (this.check(512 /* InterpolatedStringLiteral */)) {
      this.requireDialectFeature(this.dialect.stringInterpolation, "string interpolation (`...{expr}...`)");
      return this.parseInterpolatedString();
    }
    if (this.checkKeyword("function")) {
      this.advance();
      const body = this.parseFunctionBody(false);
      return { type: "FunctionDeclaration", identifier: null, isLocal: false, isMethod: false, ...body, ...this.finishRange(start) };
    }
    if (this.checkPunct("{")) {
      return this.parseTableConstructor();
    }
    if (this.matchPunct("(")) {
      const expression = this.parseExpression();
      this.expectPunct(")");
      return { type: "ParenthesizedExpression", expression, ...this.finishRange(start) };
    }
    if (this.checkKeyword("if")) {
      this.requireDialectFeature(this.dialect.ifExpression, "if-then-else expression");
      return this.parseIfExpression();
    }
    if (this.check(8 /* Identifier */)) {
      const tok = this.advance();
      return this.identifierFromToken(tok, "global", false);
    }
    this.error(`expected an expression but found ${this.currentDescription()}`);
  }
  parseIfExpression() {
    const start = this.current();
    this.advance();
    const clauses = [];
    const cond = this.parseExpression();
    this.expectKeyword("then");
    const body = this.parseExpression();
    clauses.push({ condition: cond, body });
    while (this.matchKeyword("elseif")) {
      const c = this.parseExpression();
      this.expectKeyword("then");
      const b = this.parseExpression();
      clauses.push({ condition: c, body: b });
    }
    this.expectKeyword("else");
    const elseBody = this.parseExpression();
    clauses.push({ condition: null, body: elseBody });
    return { type: "IfExpression", clauses, ...this.finishRange(start) };
  }
  parseTableConstructor() {
    const start = this.current();
    this.expectPunct("{");
    const fields = [];
    while (!this.checkPunct("}")) {
      const fieldStart = this.current();
      if (this.matchPunct("[")) {
        const key = this.parseExpression();
        this.expectPunct("]");
        this.expectPunct("=");
        const value = this.parseExpression();
        fields.push({ type: "TableKey", key, value, ...this.finishRange(fieldStart) });
      } else if (this.check(8 /* Identifier */) && this.peek(1).type === 32 /* Punctuator */ && this.peek(1).value === "=") {
        const idTok = this.advance();
        this.advance();
        const value = this.parseExpression();
        fields.push({ type: "TableKeyString", key: this.identifierFromToken(idTok, "global", true), value, ...this.finishRange(fieldStart) });
      } else {
        const value = this.parseExpression();
        fields.push({ type: "TableValue", value, ...this.finishRange(fieldStart) });
      }
      if (!this.matchPunct(",") && !this.matchPunct(";")) break;
    }
    this.expectPunct("}");
    return { type: "TableConstructorExpression", fields, ...this.finishRange(start) };
  }
  /** `text {expr} text` -> InterpolatedStringExpression(strings, expressions) */
  parseInterpolatedString() {
    const start = this.current();
    const tok = this.advance();
    const parts = tok.parts ?? [];
    const strings = [];
    const expressions = [];
    for (const part of parts) {
      if (part.kind === "string") {
        strings.push(part.value);
      } else {
        const subLexer = new Lexer(part.source, this.dialect);
        const subParser = new _Parser(subLexer.tokenize(), this.dialect);
        expressions.push(subParser.parseExpression());
      }
    }
    if (strings.length === expressions.length) strings.push("");
    return { type: "InterpolatedStringExpression", strings, expressions, ...this.finishRange(start) };
  }
};

// src/dialect.ts
var LUA51_FLAGS = {
  name: "lua5.1",
  continueKeyword: false,
  gotoStatements: false,
  compoundAssignment: false,
  stringInterpolation: false,
  attributes: false,
  typeAnnotations: false,
  floorDivision: false,
  genericFunctions: false,
  ifExpression: false,
  optionalChaining: false
};
var LUAU_FLAGS = {
  name: "luaU",
  continueKeyword: true,
  gotoStatements: false,
  compoundAssignment: true,
  stringInterpolation: true,
  attributes: true,
  typeAnnotations: true,
  floorDivision: true,
  genericFunctions: true,
  ifExpression: true,
  optionalChaining: true
};
var UnknownDialectError = class extends Error {
  constructor(given) {
    super(`unknown dialect '${given}' (expected 'lua5.1' or 'luaU')`);
  }
};
function resolveDialect(name) {
  switch (name) {
    case "lua5.1":
      return LUA51_FLAGS;
    case "luaU":
      return LUAU_FLAGS;
    default:
      throw new UnknownDialectError(name);
  }
}

// src/analysis/scope.ts
var Resolver = class {
  nextBindingId = 0;
  functionDepth = 0;
  top = { parent: null, functionDepth: 0, bindings: /* @__PURE__ */ new Map() };
  pushBlock() {
    this.top = { parent: this.top, functionDepth: this.functionDepth, bindings: /* @__PURE__ */ new Map() };
  }
  pushFunction() {
    this.functionDepth++;
    this.top = { parent: this.top, functionDepth: this.functionDepth, bindings: /* @__PURE__ */ new Map() };
  }
  pop() {
    this.top = this.top.parent;
  }
  popFunction() {
    this.top = this.top.parent;
    this.functionDepth--;
  }
  declare(id, kind) {
    const binding = { id: this.nextBindingId++, name: id.name, kind, declaration: id };
    this.top.bindings.set(id.name, binding);
    id.bindingId = binding.id;
    id.scope = kind === "parameter" ? "parameter" : "local";
  }
  resolveReference(id) {
    if (id.isField) return;
    let frame = this.top;
    while (frame) {
      const binding = frame.bindings.get(id.name);
      if (binding) {
        id.bindingId = binding.id;
        id.scope = frame.functionDepth === this.functionDepth ? binding.kind === "parameter" ? "parameter" : "local" : "upvalue";
        return;
      }
      frame = frame.parent;
    }
    id.bindingId = null;
    id.scope = "global";
  }
  run(chunk) {
    this.block(chunk.body);
  }
  block(stmts) {
    this.pushBlock();
    for (const stmt of stmts) this.statement(stmt);
    this.pop();
  }
  statement(stmt) {
    switch (stmt.type) {
      case "LocalStatement":
        stmt.init.forEach((e) => this.expr(e));
        stmt.variables.forEach((v) => {
          this.visitType(v.typeAnnotation);
          this.declare(v, "local");
        });
        break;
      case "CallStatement":
        this.expr(stmt.expression);
        break;
      case "WhileStatement":
        this.expr(stmt.condition);
        this.block(stmt.body);
        break;
      case "RepeatStatement":
        this.pushBlock();
        for (const s of stmt.body) this.statement(s);
        this.expr(stmt.condition);
        this.pop();
        break;
      case "AssignmentStatement":
        stmt.init.forEach((e) => this.expr(e));
        stmt.variables.forEach((v) => this.expr(v));
        break;
      case "CompoundAssignmentStatement":
        this.expr(stmt.value);
        this.expr(stmt.variable);
        break;
      case "FunctionDeclaration":
        this.functionDecl(stmt);
        break;
      case "ForNumericStatement":
        this.expr(stmt.start);
        this.expr(stmt.end);
        if (stmt.step) this.expr(stmt.step);
        this.pushBlock();
        this.declare(stmt.variable, "for-loop");
        for (const s of stmt.body) this.statement(s);
        this.pop();
        break;
      case "ForGenericStatement":
        stmt.iterators.forEach((e) => this.expr(e));
        this.pushBlock();
        stmt.variables.forEach((v) => this.declare(v, "for-in"));
        for (const s of stmt.body) this.statement(s);
        this.pop();
        break;
      case "IfStatement":
        for (const c of stmt.clauses) {
          if (c.type !== "ElseClause") this.expr(c.condition);
          this.block(c.body);
        }
        break;
      case "DoStatement":
        this.block(stmt.body);
        break;
      case "ReturnStatement":
        stmt.arguments.forEach((e) => this.expr(e));
        break;
      default:
        break;
    }
  }
  functionDecl(fn) {
    if (fn.identifier) {
      if (fn.isLocal && fn.identifier.type === "Identifier") {
        this.declare(fn.identifier, "local-function");
      } else {
        this.expr(fn.identifier);
      }
    }
    this.pushFunction();
    for (const p of fn.parameters) {
      if (p.type === "Identifier") {
        this.visitType(p.typeAnnotation);
        this.declare(p, "parameter");
      }
    }
    fn.generics.forEach((g) => this.visitType(g.defaultType));
    this.visitType(fn.varargTypeAnnotation);
    this.visitTypeList(fn.returnTypeAnnotation);
    for (const s of fn.body) this.statement(s);
    this.popFunction();
  }
  expr(expr) {
    switch (expr.type) {
      case "Identifier":
        this.resolveReference(expr);
        break;
      case "FunctionDeclaration":
        this.functionDecl(expr);
        break;
      case "TableConstructorExpression":
        for (const f of expr.fields) {
          if (f.type === "TableKey") {
            this.expr(f.key);
            this.expr(f.value);
          } else {
            this.expr(f.value);
          }
        }
        break;
      case "BinaryExpression":
      case "LogicalExpression":
        this.expr(expr.left);
        this.expr(expr.right);
        break;
      case "UnaryExpression":
        this.expr(expr.argument);
        break;
      case "MemberExpression":
        this.expr(expr.base);
        break;
      case "IndexExpression":
        this.expr(expr.base);
        this.expr(expr.index);
        break;
      case "CallExpression":
        this.expr(expr.base);
        expr.arguments.forEach((a) => this.expr(a));
        break;
      case "TableCallExpression":
        this.expr(expr.base);
        this.expr(expr.arguments[0]);
        break;
      case "StringCallExpression":
        this.expr(expr.base);
        break;
      case "ParenthesizedExpression":
        this.expr(expr.expression);
        break;
      case "IfExpression":
        for (const c of expr.clauses) {
          if (c.condition) this.expr(c.condition);
          this.expr(c.body);
        }
        break;
      case "InterpolatedStringExpression":
        expr.expressions.forEach((e) => this.expr(e));
        break;
      default:
        break;
    }
  }
  // ---- Luau type annotations ----
  // Types live in their own namespace (a TypeReference's `name` is a plain
  // string, not an Identifier) so most of a type tree has nothing to
  // resolve. The one exception is `typeof(expr)`, which embeds a real
  // value-level Expression that must see the current scope.
  visitTypeList(list) {
    if (!list) return;
    list.types.forEach((t) => this.visitType(t));
    if (list.vararg) this.visitType(list.vararg);
  }
  visitType(type) {
    if (!type) return;
    switch (type.type) {
      case "TypeTypeof":
        this.expr(type.expression);
        break;
      case "TypeUnion":
      case "TypeIntersection":
        type.types.forEach((t) => this.visitType(t));
        break;
      case "TypeOptional":
        this.visitType(type.base);
        break;
      case "TypeParenthesized":
        this.visitType(type.type_);
        break;
      case "TypeVariadic":
        this.visitType(type.base);
        break;
      case "TypeFunction":
        type.parameters.forEach((p) => this.visitType(p.type));
        this.visitTypeList(type.returns);
        break;
      case "TypeTable":
        for (const f of type.fields) {
          if (f.key && typeof f.key !== "string") this.visitType(f.key);
          this.visitType(f.value);
        }
        break;
      case "TypeReference":
        type.typeArguments.forEach((t) => this.visitType(t));
        break;
      default:
        break;
    }
  }
};
function resolveScopes(chunk) {
  new Resolver().run(chunk);
  return chunk;
}

// src/codegen/generator.ts
var BIN_PRECEDENCE = {
  or: 1,
  and: 2,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "~=": 3,
  "==": 3,
  "|": 4,
  "~": 5,
  "&": 6,
  "<<": 7,
  ">>": 7,
  "..": 9,
  "+": 10,
  "-": 10,
  "*": 11,
  "/": 11,
  "//": 11,
  "%": 11,
  "^": 14
};
var UNARY_PRECEDENCE2 = 12;
var RIGHT_ASSOC = /* @__PURE__ */ new Set(["..", "^"]);
var Generator = class {
  indentLevel = 0;
  minify;
  constructor(options = {}) {
    this.minify = options.minify ?? false;
  }
  indent() {
    return this.minify ? "" : "  ".repeat(this.indentLevel);
  }
  generate(chunk) {
    return this.printBlock(chunk.body);
  }
  printBlock(stmts) {
    if (this.minify) {
      return stmts.map((s) => this.printStatement(s)).join("; ");
    }
    return stmts.map((s) => this.indent() + this.printStatement(s)).join("\n");
  }
  withIndent(fn) {
    this.indentLevel++;
    const out = fn();
    this.indentLevel--;
    return out;
  }
  /**
   * Renders `head <body> tail` (e.g. `while x do`, block, `end`) in either
   * pretty-printed (indented, multi-line) or minified (single-line,
   * `;`-separated body) form depending on `this.minify`.
   */
  wrapBlock(head, body, tail) {
    const inner = this.withIndent(() => this.printBlock(body));
    if (this.minify) {
      return inner.length ? `${head} ${inner} ${tail}` : `${head} ${tail}`;
    }
    return `${head}
${inner}
${this.indent()}${tail}`;
  }
  // -------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------
  printStatement(stmt) {
    switch (stmt.type) {
      case "LocalStatement": {
        const vars = stmt.variables.map((v) => this.printIdentifierDecl(v)).join(", ");
        if (stmt.init.length === 0) return `local ${vars}`;
        return `local ${vars} = ${stmt.init.map((e) => this.printExpr(e)).join(", ")}`;
      }
      case "CallStatement":
        return this.printExpr(stmt.expression);
      case "WhileStatement":
        return this.wrapBlock(`while ${this.printExpr(stmt.condition)} do`, stmt.body, "end");
      case "RepeatStatement":
        return this.wrapBlock("repeat", stmt.body, `until ${this.printExpr(stmt.condition)}`);
      case "AssignmentStatement":
        return `${stmt.variables.map((v) => this.printExpr(v)).join(", ")} = ${stmt.init.map((e) => this.printExpr(e)).join(", ")}`;
      case "CompoundAssignmentStatement": {
        const op = stmt.operator.slice(0, -1);
        const target = this.printExpr(stmt.variable);
        return `${target} = ${target} ${op} ${this.printExpr(stmt.value)}`;
      }
      case "FunctionDeclaration":
        return this.printFunctionDeclaration(stmt);
      case "ForNumericStatement": {
        const step = stmt.step ? `, ${this.printExpr(stmt.step)}` : "";
        return this.wrapBlock(
          `for ${stmt.variable.name} = ${this.printExpr(stmt.start)}, ${this.printExpr(stmt.end)}${step} do`,
          stmt.body,
          "end"
        );
      }
      case "ForGenericStatement":
        return this.wrapBlock(
          `for ${stmt.variables.map((v) => v.name).join(", ")} in ${stmt.iterators.map((e) => this.printExpr(e)).join(", ")} do`,
          stmt.body,
          "end"
        );
      case "IfStatement":
        return this.printIfStatement(stmt);
      case "DoStatement":
        return this.wrapBlock("do", stmt.body, "end");
      case "ReturnStatement":
        return stmt.arguments.length ? `return ${stmt.arguments.map((e) => this.printExpr(e)).join(", ")}` : "return";
      case "BreakStatement":
        return "break";
      case "ContinueStatement":
        return "continue";
      case "GotoStatement":
        return `goto ${stmt.label}`;
      case "LabelStatement":
        return `::${stmt.name}::`;
      default:
        throw new Error(`Generator: unhandled statement type ${stmt.type}`);
    }
  }
  printIdentifierDecl(id) {
    const attr = id.attribute ? ` <${id.attribute}>` : "";
    return `${id.name}${attr}`;
  }
  printIfStatement(stmt) {
    let out = "";
    for (let i = 0; i < stmt.clauses.length; i++) {
      const clause = stmt.clauses[i];
      let head;
      if (clause.type === "IfClause") head = `if ${this.printExpr(clause.condition)} then`;
      else if (clause.type === "ElseifClause") head = `elseif ${this.printExpr(clause.condition)} then`;
      else head = "else";
      const inner = this.withIndent(() => this.printBlock(clause.body));
      if (this.minify) {
        out += inner.length ? `${head} ${inner} ` : `${head} `;
      } else {
        out += `${head}
${inner}
${this.indent()}`;
      }
    }
    return out + "end";
  }
  printFunctionDeclaration(fn) {
    const visibleParams = fn.isMethod ? fn.parameters.slice(1) : fn.parameters;
    const params = visibleParams.map((p) => p.type === "VarargLiteral" ? "..." : p.name).join(", ");
    const kw = fn.isLocal ? "local function" : "function";
    const nameStr = fn.identifier ? this.printExpr(fn.identifier) : "";
    const head = fn.identifier ? `${kw} ${nameStr}(${params})` : `function(${params})`;
    return this.wrapBlock(head, fn.body, "end");
  }
  // -------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------
  printExpr(expr, parentPrec = 0) {
    switch (expr.type) {
      case "Identifier":
        return expr.name;
      case "StringLiteral":
        return printStringLiteral(expr.value);
      case "NumericLiteral":
        return formatNumber(expr.value);
      case "BooleanLiteral":
        return expr.value ? "true" : "false";
      case "NilLiteral":
        return "nil";
      case "VarargLiteral":
        return "...";
      case "InterpolatedStringExpression":
        return this.printInterpolatedString(expr);
      case "FunctionDeclaration":
        return this.printFunctionDeclaration(expr);
      case "TableConstructorExpression":
        return this.printTableConstructor(expr);
      case "BinaryExpression":
        return this.printBinary(expr.operator, expr.left, expr.right, parentPrec);
      case "LogicalExpression":
        return this.printBinary(expr.operator, expr.left, expr.right, parentPrec);
      case "UnaryExpression": {
        const opStr = expr.operator === "not" ? "not " : expr.operator;
        const inner = `${opStr}${this.printExpr(expr.argument, UNARY_PRECEDENCE2)}`;
        return UNARY_PRECEDENCE2 < parentPrec ? `(${inner})` : inner;
      }
      case "MemberExpression":
        return `${this.printExpr(expr.base, 100)}${expr.optional ? "?" : ""}${expr.indexer}${expr.identifier.name}`;
      case "IndexExpression":
        return `${this.printExpr(expr.base, 100)}${expr.optional ? "?" : ""}[${this.printExpr(
          expr.index
        )}]`;
      case "CallExpression":
        return `${this.printExpr(expr.base, 100)}(${expr.arguments.map((a) => this.printExpr(a)).join(", ")})`;
      case "TableCallExpression":
        return `${this.printExpr(expr.base, 100)}${this.printTableConstructor(expr.arguments[0])}`;
      case "StringCallExpression":
        return `${this.printExpr(expr.base, 100)}${printStringLiteral(expr.argument.value)}`;
      case "ParenthesizedExpression":
        return `(${this.printExpr(expr.expression)})`;
      case "IfExpression":
        return this.printIfExpression(expr);
      default:
        throw new Error(`Generator: unhandled expression type ${expr.type}`);
    }
  }
  printBinary(op, left, right, parentPrec) {
    const prec = BIN_PRECEDENCE[op] ?? 5;
    const rightAssoc = RIGHT_ASSOC.has(op);
    const leftStr = this.printExpr(left, rightAssoc ? prec + 1 : prec);
    const rightStr = this.printExpr(right, rightAssoc ? prec : prec + 1);
    const inner = `${leftStr} ${op} ${rightStr}`;
    return prec < parentPrec ? `(${inner})` : inner;
  }
  printTableConstructor(t) {
    const fields = t.fields.map((f) => {
      if (f.type === "TableKey") return `[${this.printExpr(f.key)}] = ${this.printExpr(f.value)}`;
      if (f.type === "TableKeyString") return `${f.key.name} = ${this.printExpr(f.value)}`;
      return this.printExpr(f.value);
    });
    return `{${fields.join(", ")}}`;
  }
  printInterpolatedString(e) {
    const parts = [];
    for (let i = 0; i < e.strings.length; i++) {
      if (e.strings[i] !== "") parts.push(printStringLiteral(e.strings[i]));
      if (i < e.expressions.length) {
        parts.push(`tostring(${this.printExpr(e.expressions[i])})`);
      }
    }
    if (parts.length === 0) return `""`;
    return parts.join(" .. ");
  }
  printIfExpression(e) {
    let out = "";
    for (let i = 0; i < e.clauses.length; i++) {
      const c = e.clauses[i];
      if (c.condition === null) {
        out += `else ${this.printExpr(c.body)}`;
      } else if (i === 0) {
        out += `if ${this.printExpr(c.condition)} then ${this.printExpr(c.body)} `;
      } else {
        out += `elseif ${this.printExpr(c.condition)} then ${this.printExpr(c.body)} `;
      }
    }
    return out.trim();
  }
};
function formatNumber(n) {
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}
function printStringLiteral(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (code < 32 || code >= 127) out += `\\${String(code).padStart(3, "0")}`;
    else out += ch;
  }
  return out + '"';
}
function generate(chunk, options = {}) {
  return new Generator(options).generate(chunk);
}

// src/utils/random.ts
function webcrypto() {
  return typeof globalThis !== "undefined" ? globalThis.crypto : void 0;
}
function randomUint32() {
  const c = webcrypto();
  if (c && typeof c.getRandomValues === "function") {
    return c.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 4294967296);
}
function randomHex32() {
  const c = webcrypto();
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID().replace(/-/g, "");
    } catch {
    }
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function randInt(min, max) {
  const range = max - min + 1;
  return min + randomUint32() % range;
}
function choice(arr) {
  return arr[randInt(0, arr.length - 1)];
}
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
var NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
var VALID_LUA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function randomVarName(existing) {
  let name;
  do {
    const len = randInt(5, 10);
    name = `${randomHex32().slice(0, len)}`;
  } while (!VALID_LUA_IDENTIFIER.test(name) || existing.has(name) || RESERVED.has(name));
  existing.add(name);
  return name;
}
function randomKey(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) s += NAME_CHARS[randInt(0, NAME_CHARS.length - 1)];
  return s;
}
var RESERVED = /* @__PURE__ */ new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
  "continue",
  "self"
]);

// src/passes/rename-variables.ts
function lookup(scopes, name) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const hit = scopes[i].get(name);
    if (hit) return hit;
  }
  return null;
}
function declare(scopes, allNames, id, skip = false) {
  if (skip || id.name === "self") return;
  const newName = randomVarName(allNames);
  scopes[scopes.length - 1].set(id.name, newName);
  id.name = newName;
}
var Renamer = class {
  allNames = /* @__PURE__ */ new Set();
  run(chunk) {
    this.block([/* @__PURE__ */ new Map()], chunk.body);
  }
  block(scopes, stmts) {
    scopes.push(/* @__PURE__ */ new Map());
    for (const stmt of stmts) this.statement(scopes, stmt);
    scopes.pop();
  }
  statement(scopes, stmt) {
    switch (stmt.type) {
      case "LocalStatement":
        stmt.init.forEach((e) => this.expr(scopes, e));
        stmt.variables.forEach((v) => declare(scopes, this.allNames, v));
        break;
      case "CallStatement":
        this.expr(scopes, stmt.expression);
        break;
      case "WhileStatement":
        this.expr(scopes, stmt.condition);
        this.block(scopes, stmt.body);
        break;
      case "RepeatStatement": {
        scopes.push(/* @__PURE__ */ new Map());
        for (const s of stmt.body) this.statement(scopes, s);
        this.expr(scopes, stmt.condition);
        scopes.pop();
        break;
      }
      case "AssignmentStatement":
        stmt.init.forEach((e) => this.expr(scopes, e));
        stmt.variables.forEach((v) => this.expr(scopes, v));
        break;
      case "CompoundAssignmentStatement":
        this.expr(scopes, stmt.value);
        this.expr(scopes, stmt.variable);
        break;
      case "FunctionDeclaration":
        this.functionDecl(scopes, stmt);
        break;
      case "ForNumericStatement":
        this.expr(scopes, stmt.start);
        this.expr(scopes, stmt.end);
        if (stmt.step) this.expr(scopes, stmt.step);
        scopes.push(/* @__PURE__ */ new Map());
        declare(scopes, this.allNames, stmt.variable);
        for (const s of stmt.body) this.statement(scopes, s);
        scopes.pop();
        break;
      case "ForGenericStatement":
        stmt.iterators.forEach((e) => this.expr(scopes, e));
        scopes.push(/* @__PURE__ */ new Map());
        stmt.variables.forEach((v) => declare(scopes, this.allNames, v));
        for (const s of stmt.body) this.statement(scopes, s);
        scopes.pop();
        break;
      case "IfStatement":
        for (const c of stmt.clauses) {
          if (c.type !== "ElseClause") this.expr(scopes, c.condition);
          this.block(scopes, c.body);
        }
        break;
      case "DoStatement":
        this.block(scopes, stmt.body);
        break;
      case "ReturnStatement":
        stmt.arguments.forEach((e) => this.expr(scopes, e));
        break;
      default:
        break;
    }
  }
  functionDecl(scopes, fn) {
    if (fn.identifier) {
      if (fn.isLocal && fn.identifier.type === "Identifier") {
        declare(scopes, this.allNames, fn.identifier);
      } else {
        this.expr(scopes, fn.identifier);
      }
    }
    scopes.push(/* @__PURE__ */ new Map());
    for (const p of fn.parameters) {
      if (p.type === "Identifier") declare(scopes, this.allNames, p, p.name === "self");
    }
    for (const s of fn.body) this.statement(scopes, s);
    scopes.pop();
  }
  expr(scopes, expr) {
    switch (expr.type) {
      case "Identifier": {
        const resolved = lookup(scopes, expr.name);
        if (resolved) expr.name = resolved;
        break;
      }
      case "FunctionDeclaration":
        this.functionDecl(scopes, expr);
        break;
      case "TableConstructorExpression":
        for (const f of expr.fields) {
          if (f.type === "TableKey") {
            this.expr(scopes, f.key);
            this.expr(scopes, f.value);
          } else {
            this.expr(scopes, f.value);
          }
        }
        break;
      case "BinaryExpression":
      case "LogicalExpression":
        this.expr(scopes, expr.left);
        this.expr(scopes, expr.right);
        break;
      case "UnaryExpression":
        this.expr(scopes, expr.argument);
        break;
      case "MemberExpression":
        this.expr(scopes, expr.base);
        break;
      case "IndexExpression":
        this.expr(scopes, expr.base);
        this.expr(scopes, expr.index);
        break;
      case "CallExpression":
        this.expr(scopes, expr.base);
        expr.arguments.forEach((a) => this.expr(scopes, a));
        break;
      case "TableCallExpression":
        this.expr(scopes, expr.base);
        this.expr(scopes, expr.arguments[0]);
        break;
      case "StringCallExpression":
        this.expr(scopes, expr.base);
        break;
      case "ParenthesizedExpression":
        this.expr(scopes, expr.expression);
        break;
      case "IfExpression":
        for (const c of expr.clauses) {
          if (c.condition) this.expr(scopes, c.condition);
          this.expr(scopes, c.body);
        }
        break;
      case "InterpolatedStringExpression":
        expr.expressions.forEach((e) => this.expr(scopes, e));
        break;
      default:
        break;
    }
  }
};
var renameVariables = (chunk) => {
  new Renamer().run(chunk);
  return chunk;
};

// src/utils/walk.ts
function tExpr(expr, fn) {
  switch (expr.type) {
    case "FunctionDeclaration":
      expr.body = tStmts(expr.body, fn);
      break;
    case "TableConstructorExpression":
      for (const f of expr.fields) {
        if (f.type === "TableKey") {
          f.key = tExpr(f.key, fn);
          f.value = tExpr(f.value, fn);
        } else if (f.type === "TableKeyString") {
          f.value = tExpr(f.value, fn);
        } else {
          f.value = tExpr(f.value, fn);
        }
      }
      break;
    case "BinaryExpression":
    case "LogicalExpression":
      expr.left = tExpr(expr.left, fn);
      expr.right = tExpr(expr.right, fn);
      break;
    case "UnaryExpression":
      expr.argument = tExpr(expr.argument, fn);
      break;
    case "MemberExpression":
      expr.base = tExpr(expr.base, fn);
      break;
    case "IndexExpression":
      expr.base = tExpr(expr.base, fn);
      expr.index = tExpr(expr.index, fn);
      break;
    case "CallExpression":
      expr.base = tExpr(expr.base, fn);
      expr.arguments = expr.arguments.map((a) => tExpr(a, fn));
      break;
    case "TableCallExpression":
      expr.base = tExpr(expr.base, fn);
      expr.arguments[0] = tExpr(expr.arguments[0], fn);
      break;
    case "StringCallExpression":
      expr.base = tExpr(expr.base, fn);
      break;
    case "ParenthesizedExpression":
      expr.expression = tExpr(expr.expression, fn);
      break;
    case "IfExpression":
      for (const c of expr.clauses) {
        if (c.condition) c.condition = tExpr(c.condition, fn);
        c.body = tExpr(c.body, fn);
      }
      break;
    case "InterpolatedStringExpression":
      expr.expressions = expr.expressions.map((e) => tExpr(e, fn));
      break;
    default:
      break;
  }
  const replaced = fn(expr);
  return replaced ?? expr;
}
function tStmt(stmt, fn) {
  switch (stmt.type) {
    case "LocalStatement":
      stmt.init = stmt.init.map((e) => tExpr(e, fn));
      break;
    case "CallStatement":
      stmt.expression = tExpr(stmt.expression, fn);
      break;
    case "WhileStatement":
      stmt.condition = tExpr(stmt.condition, fn);
      stmt.body = tStmts(stmt.body, fn);
      break;
    case "RepeatStatement":
      stmt.body = tStmts(stmt.body, fn);
      stmt.condition = tExpr(stmt.condition, fn);
      break;
    case "AssignmentStatement":
      stmt.variables = stmt.variables.map((v) => tExpr(v, fn));
      stmt.init = stmt.init.map((e) => tExpr(e, fn));
      break;
    case "CompoundAssignmentStatement":
      stmt.variable = tExpr(stmt.variable, fn);
      stmt.value = tExpr(stmt.value, fn);
      break;
    case "FunctionDeclaration":
      stmt.body = tStmts(stmt.body, fn);
      break;
    case "ForNumericStatement":
      stmt.start = tExpr(stmt.start, fn);
      stmt.end = tExpr(stmt.end, fn);
      if (stmt.step) stmt.step = tExpr(stmt.step, fn);
      stmt.body = tStmts(stmt.body, fn);
      break;
    case "ForGenericStatement":
      stmt.iterators = stmt.iterators.map((e) => tExpr(e, fn));
      stmt.body = tStmts(stmt.body, fn);
      break;
    case "IfStatement":
      for (const c of stmt.clauses) {
        if (c.type !== "ElseClause") c.condition = tExpr(c.condition, fn);
        c.body = tStmts(c.body, fn);
      }
      break;
    case "DoStatement":
      stmt.body = tStmts(stmt.body, fn);
      break;
    case "ReturnStatement":
      stmt.arguments = stmt.arguments.map((e) => tExpr(e, fn));
      break;
    default:
      break;
  }
  return stmt;
}
function tStmts(stmts, fn) {
  return stmts.map((s) => tStmt(s, fn));
}
function transformExpressions(chunk, fn) {
  chunk.body = tStmts(chunk.body, fn);
}

// src/ast/builders.ts
var DUMMY_LOC = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
var DUMMY_RANGE = [0, 0];
function base() {
  return { range: DUMMY_RANGE, loc: DUMMY_LOC };
}
function ident(name) {
  return { type: "Identifier", name, attribute: null, typeAnnotation: null, scope: "global", isField: false, bindingId: null, ...base() };
}
function varargParam() {
  return { type: "VarargLiteral", value: "...", ...base() };
}
function numLit(value) {
  return { type: "NumericLiteral", value, raw: String(value), ...base() };
}
function strLit(value) {
  return { type: "StringLiteral", value, raw: JSON.stringify(value), ...base() };
}
function boolLit(value) {
  return { type: "BooleanLiteral", value, ...base() };
}
function nilLit() {
  return { type: "NilLiteral", ...base() };
}
function binExpr(operator, left, right) {
  return { type: "BinaryExpression", operator, left, right, ...base() };
}
function paren(expression) {
  return { type: "ParenthesizedExpression", expression, ...base() };
}
function callExpr(calleeBase, args) {
  return { type: "CallExpression", base: calleeBase, arguments: args, ...base() };
}
function memberExpr(objBase, name) {
  return { type: "MemberExpression", indexer: ".", base: objBase, identifier: { ...ident(name), isField: true }, optional: false, ...base() };
}
function indexExpr(objBase, index) {
  return { type: "IndexExpression", base: objBase, index, optional: false, ...base() };
}
function tableCtor(fields) {
  return { type: "TableConstructorExpression", fields, ...base() };
}
function tableValue(value) {
  return { type: "TableValue", value, ...base() };
}
function localStmt(variables, init) {
  return { type: "LocalStatement", variables, init, ...base() };
}
function assignStmt(variables, init) {
  return { type: "AssignmentStatement", variables, init, ...base() };
}
function returnStmt(args) {
  return { type: "ReturnStatement", arguments: args, ...base() };
}
function funcExpr(parameters, body, hasVararg = false) {
  return {
    type: "FunctionDeclaration",
    identifier: null,
    isLocal: false,
    isMethod: false,
    parameters,
    body,
    hasVararg,
    varargTypeAnnotation: null,
    generics: [],
    returnTypeAnnotation: null,
    ...base()
  };
}

// src/passes/numbers-to-expressions.ts
function buildNumberExpr(value, min, max) {
  const steps = randInt(min, max);
  const deltas = [];
  for (let i = 0; i < steps; i++) {
    const magnitude = randInt(1e3, 6e4);
    deltas.push(randInt(0, 1) === 0 ? magnitude : -magnitude);
  }
  const sum = deltas.reduce((a, b) => a + b, 0);
  const initial = value + sum;
  const scope = /* @__PURE__ */ new Set();
  const varName = randomVarName(scope);
  const v = ident(varName);
  const stmts = [localStmt([ident(varName)], [numLit(initial)])];
  for (const d of deltas) {
    const op = d >= 0 ? "-" : "+";
    stmts.push(assignStmt([ident(varName)], [binExpr(op, v, numLit(Math.abs(d)))]));
  }
  stmts.push(returnStmt([v]));
  const fn = funcExpr([], stmts);
  return callExpr(paren(fn), []);
}
var numbersToExpressions = (chunk, _ctx, opts) => {
  const min = opts?.min ?? 3;
  const max = Math.max(min, opts?.max ?? 8);
  transformExpressions(chunk, (expr) => {
    if (expr.type === "NumericLiteral" && Number.isFinite(expr.value)) {
      return buildNumberExpr(expr.value, min, max);
    }
    return null;
  });
  return chunk;
};

// src/passes/strings-to-expressions.ts
function stringCharCall(chunkStr) {
  const codes = Array.from(chunkStr).map((c) => numLit(c.codePointAt(0)));
  return callExpr(memberExpr(ident("string"), "char"), codes);
}
function splitInto(s, parts) {
  if (parts <= 1 || s.length === 0) return [s];
  parts = Math.min(parts, s.length);
  const chars = Array.from(s);
  const base2 = Math.floor(chars.length / parts);
  const remainder = chars.length % parts;
  const out = [];
  let idx = 0;
  for (let i = 0; i < parts; i++) {
    const len = base2 + (i < remainder ? 1 : 0);
    out.push(chars.slice(idx, idx + len).join(""));
    idx += len;
  }
  return out.filter((p) => p.length > 0);
}
function buildStringExpr(value, min, max) {
  if (value.length === 0) return strLit("");
  const steps = Math.max(1, Math.min(randInt(min, max), value.length));
  const pieces = splitInto(value, steps);
  let result = null;
  for (const piece of pieces) {
    const pieceExpr = randInt(0, 1) === 0 ? strLit(piece) : stringCharCall(piece);
    result = result === null ? pieceExpr : binExpr("..", result, pieceExpr);
  }
  return result;
}
var stringsToExpressions = (chunk, _ctx, opts) => {
  const min = opts?.min ?? 3;
  const max = Math.max(min, opts?.max ?? 8);
  transformExpressions(chunk, (expr) => {
    if (expr.type === "StringLiteral") {
      return buildStringExpr(expr.value, min, max);
    }
    return null;
  });
  return chunk;
};

// src/utils/parse-snippet.ts
function parseSnippet(source, dialect) {
  const flags = resolveDialect(dialect);
  const tokens = new Lexer(source, flags).tokenize();
  const chunk = new Parser(tokens, flags).parseChunk();
  resolveScopes(chunk);
  return chunk;
}

// src/passes/encrypt-strings.ts
function buildDecryptHelper(fnName, keyName, key, dialect) {
  const keyLiteral = `{${key.join(", ")}}`;
  const src = `
    local ${keyName} = ${keyLiteral}
    local function ${fnName}(_enc)
      local _out = {}
      for _i = 1, #_enc do
        local _k = ${keyName}[((_i - 1) % #${keyName}) + 1]
        local _b = string.byte(_enc, _i)
        local _x = _b
        if _b >= _k then _x = _b - _k else _x = _b + (256 - _k) end
        _out[_i] = string.char(_x % 256)
      end
      return table.concat(_out)
    end
  `;
  return parseSnippet(src, dialect.name).body;
}
function modEncrypt(value, key) {
  const bytes = Array.from(value).map((c) => c.codePointAt(0) & 255);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const k = key[i % key.length];
    const enc = (bytes[i] + k) % 256;
    out += String.fromCharCode(enc);
  }
  return out;
}
var encryptStrings = (chunk, ctx) => {
  const key = Array.from({ length: randInt(4, 8) }, () => randInt(1, 255));
  const names = /* @__PURE__ */ new Set();
  const fnName = randomVarName(names);
  const keyName = randomVarName(names);
  let touched = false;
  transformExpressions(chunk, (expr) => {
    if (expr.type === "StringLiteral") {
      touched = true;
      const enc = modEncrypt(expr.value, key);
      return callExpr(ident(fnName), [strLit(enc)]);
    }
    return null;
  });
  if (touched) {
    const helper = buildDecryptHelper(fnName, keyName, key, ctx.dialect);
    chunk.body = [...helper, ...chunk.body];
  }
  return chunk;
};

// src/passes/constant-array.ts
var constantArray = (chunk) => {
  const pool = [];
  const slotOf = /* @__PURE__ */ new Map();
  transformExpressions(chunk, (expr) => {
    if (expr.type === "StringLiteral" || expr.type === "NumericLiteral") {
      pool.push(expr);
      slotOf.set(expr, pool.length - 1);
      return null;
    }
    return null;
  });
  if (pool.length === 0) return chunk;
  const order = shuffle(pool.map((_, i) => i));
  const physicalIndexOf = /* @__PURE__ */ new Map();
  order.forEach((originalSlot, physicalPos) => {
    physicalIndexOf.set(originalSlot, physicalPos + 1);
  });
  const names = /* @__PURE__ */ new Set();
  const arrName = randomVarName(names);
  const offset = randInt(1, 50);
  const arrayFields = order.map((originalSlot) => tableValue(pool[originalSlot]));
  const decl = localStmt([ident(arrName)], [tableCtor(arrayFields)]);
  let slotCounter = 0;
  transformExpressions(chunk, (expr) => {
    if (expr.type === "StringLiteral" || expr.type === "NumericLiteral") {
      const originalSlot = slotCounter++;
      const physicalIndex = physicalIndexOf.get(originalSlot);
      const shownIndex = physicalIndex - offset;
      const indexExprNode = offset === 0 ? numLit(physicalIndex) : binExpr("+", numLit(shownIndex), numLit(offset));
      return indexExpr(ident(arrName), paren(indexExprNode));
    }
    return expr;
  });
  chunk.body = [decl, ...chunk.body];
  return chunk;
};

// src/passes/vmify.ts
function hoistNamesFromStatement(stmt, into) {
  if (stmt.type === "LocalStatement") {
    for (const v of stmt.variables) {
      if (v.type === "Identifier") {
        into.push({
          ...v,
          attribute: null
        });
      }
    }
    return {
      type: "AssignmentStatement",
      variables: stmt.variables,
      init: stmt.init,
      range: stmt.range,
      loc: stmt.loc
    };
  }
  if (stmt.type === "FunctionDeclaration" && stmt.isLocal && stmt.identifier?.type === "Identifier") {
    into.push({
      ...stmt.identifier,
      attribute: null
    });
    return {
      type: "AssignmentStatement",
      variables: [
        stmt.identifier
      ],
      init: [
        // Anonymous function values don't get their own AST node type —
        // per FunctionDeclaration's own doc comment, `identifier: null`
        // IS how an anonymous function/closure literal is represented,
        // both as a statement and (here) as an expression. This used to
        // stamp a fictitious 'FunctionExpression' type that no part of
        // this codebase's AST (or compileExpression's switch) actually
        // recognizes, silently making every `local function` un-compilable
        // as a value — see the CLOSURES section.
        {
          ...stmt,
          type: "FunctionDeclaration",
          identifier: null,
          isLocal: false
        }
      ],
      range: stmt.range,
      loc: stmt.loc
    };
  }
  return stmt;
}
function hoistAll(stmts, into) {
  return stmts.map((s) => hoistOne(s, into));
}
function hoistOne(stmt, into) {
  const rewritten = hoistNamesFromStatement(stmt, into);
  switch (rewritten.type) {
    case "IfStatement":
      return {
        ...rewritten,
        clauses: rewritten.clauses.map((c) => ({
          ...c,
          body: hoistAll(c.body, into)
        }))
      };
    case "WhileStatement":
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      };
    case "RepeatStatement":
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      };
    case "ForNumericStatement":
      into.push({ ...rewritten.variable, attribute: null });
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      };
    case "ForGenericStatement":
      for (const v of rewritten.variables) {
        if (v.type === "Identifier") {
          into.push({ ...v, attribute: null });
        }
      }
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      };
    case "DoStatement":
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      };
    default:
      return rewritten;
  }
}
var OPCODE_NAMES = [
  "MOVE",
  "LOADK",
  "GETGLOBAL",
  "SETGLOBAL",
  "GETINDEX",
  "SETINDEX",
  "NEWTABLE",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "IDIV",
  "MOD",
  "POW",
  "CONCAT",
  "UNM",
  "NOT",
  "LEN",
  "EQ",
  "LT",
  "LE",
  "JMP",
  "JMPIF",
  "JMPIFNOT",
  "CALL",
  "RETURN",
  "VARARG",
  "TOSTRING",
  "GETUPVAL",
  "SETUPVAL",
  "LOADRAW",
  "SPREADVARARG",
  "SPREADMULTRET",
  "NOP",
  "XOR"
];
function buildShuffledOpcodes() {
  const shuffled = shuffle(OPCODE_NAMES);
  const map = {};
  shuffled.forEach((name, i) => {
    map[name] = i + 1;
  });
  return map;
}
var ConstantPool = class {
  values = [];
  map = /* @__PURE__ */ new Map();
  add(v) {
    const key = typeof v + ":" + String(v);
    const old = this.map.get(key);
    if (old !== void 0) return old;
    const id = this.values.length;
    this.values.push(v);
    this.map.set(key, id);
    return id;
  }
};
function constNodeFor(v) {
  if (v === null) return nilLit();
  switch (typeof v) {
    case "number":
      return numLit(v);
    case "string":
      return strLit(v);
    case "boolean":
      return boolLit(v);
    default:
      throw new Error(`VMify: unsupported constant type in pool: ${typeof v}`);
  }
}
var RegisterAllocator = class {
  next = 0;
  alloc() {
    const r = this.next;
    this.next++;
    return r;
  }
  reset(base2 = 0) {
    this.next = base2;
  }
  high() {
    return this.next;
  }
};
function keyAt(seed, pc) {
  let x = seed + pc * 2654435761 >>> 0;
  x = Math.imul(x, 1664525) + 1013904223 >>> 0;
  return x % 251 + 1;
}
function push(state, instr) {
  const pc = state.code.length;
  state.code.push(instr);
  return pc;
}
function keyedConst(state, pcForKey, v) {
  const k = keyAt(state.keySeed, pcForKey);
  return state.pool.add(v) ^ k;
}
function keyedGlobalConst(state, pcForKey, name) {
  state.usedGlobals.add(name);
  return keyedConst(state, pcForKey, name);
}
function readVarInto(id, state, target) {
  const bid = id.bindingId;
  if (bid == null) return false;
  const reg = state.regs.get(bid);
  if (reg !== void 0) {
    state.code.push({ op: state.opcodes.MOVE, a: target, b: reg, c: 0 });
    return true;
  }
  const box = state.boxIndex.get(bid);
  if (box !== void 0) {
    state.code.push({ op: state.opcodes.GETUPVAL, a: target, b: box, c: 0 });
    return true;
  }
  return false;
}
function writeVarFrom(id, state, srcReg) {
  const bid = id.bindingId;
  if (bid == null) return false;
  const reg = state.regs.get(bid);
  if (reg !== void 0) {
    state.code.push({ op: state.opcodes.MOVE, a: reg, b: srcReg, c: 0 });
    return true;
  }
  const box = state.boxIndex.get(bid);
  if (box !== void 0) {
    state.code.push({ op: state.opcodes.SETUPVAL, a: box, b: srcReg, c: 0 });
    return true;
  }
  return false;
}
function computeNeededBoxes(body) {
  const needed = /* @__PURE__ */ new Set();
  const wrapper = { type: "Chunk", body, range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } };
  transformExpressions(wrapper, (expr) => {
    if (expr.type === "Identifier" && !expr.isField && expr.scope === "upvalue" && expr.bindingId != null) {
      needed.add(expr.bindingId);
    }
    return expr;
  });
  return needed;
}
function rewriteCapturedRefs(fn, state) {
  const cloned = structuredClone(fn);
  const wrapper = { type: "Chunk", body: [returnStmt([cloned])], range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } };
  transformExpressions(wrapper, (expr) => {
    if (expr.type !== "Identifier" || expr.isField || expr.bindingId == null) return expr;
    const box = state.boxIndex.get(expr.bindingId);
    if (box === void 0) return expr;
    return memberExpr(indexExpr(ident(state.upvalsName), numLit(box + 1)), "v");
  });
  return wrapper.body[0].arguments[0];
}
function compileClosureLiteral(fn, state) {
  const rewritten = rewriteCapturedRefs(fn, state);
  const idx = state.rawPool.length;
  state.rawPool.push(rewritten);
  return idx;
}
function compileExpression(expr, state, target) {
  if (!expr) return;
  switch (expr.type) {
    case "NilLiteral": {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, null), c: 0 });
      return;
    }
    case "NumericLiteral":
    case "StringLiteral":
    case "BooleanLiteral": {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, expr.value), c: 0 });
      return;
    }
    case "VarargLiteral": {
      state.code.push({ op: state.opcodes.VARARG, a: target, b: 0, c: 0 });
      return;
    }
    case "Identifier": {
      if (readVarInto(expr, state, target)) return;
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.GETGLOBAL, a: target, b: keyedGlobalConst(state, pc, expr.name), c: 0 });
      return;
    }
    case "FunctionDeclaration": {
      const rawIdx = compileClosureLiteral(expr, state);
      state.code.push({ op: state.opcodes.LOADRAW, a: target, b: rawIdx, c: 0 });
      return;
    }
    case "MemberExpression": {
      const baseReg = state.allocator.alloc();
      compileExpression(expr.base, state, baseReg);
      const keyReg = state.allocator.alloc();
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, expr.identifier.name), c: 0 });
      state.code.push({ op: state.opcodes.GETINDEX, a: target, b: baseReg, c: keyReg });
      return;
    }
    case "IndexExpression": {
      const baseReg = state.allocator.alloc();
      compileExpression(expr.base, state, baseReg);
      const keyReg = state.allocator.alloc();
      compileExpression(expr.index, state, keyReg);
      state.code.push({ op: state.opcodes.GETINDEX, a: target, b: baseReg, c: keyReg });
      return;
    }
    case "UnaryExpression": {
      const src = state.allocator.alloc();
      compileExpression(expr.argument, state, src);
      const operator = expr.operator;
      let op;
      switch (operator) {
        case "-":
          op = state.opcodes.UNM;
          break;
        case "not":
          op = state.opcodes.NOT;
          break;
        case "#":
          op = state.opcodes.LEN;
          break;
        default:
          throw new Error(`VMify: unsupported unary operator '${operator}'`);
      }
      state.code.push({ op, a: target, b: src, c: 0 });
      return;
    }
    case "LogicalExpression": {
      compileExpression(expr.left, state, target);
      const testOp = expr.operator === "and" ? state.opcodes.JMPIFNOT : state.opcodes.JMPIF;
      const jmpPc = push(state, { op: testOp, a: target, b: -1, c: 0 });
      compileExpression(expr.right, state, target);
      patchJumpTarget(state, jmpPc, state.code.length);
      return;
    }
    case "BinaryExpression": {
      const left = state.allocator.alloc();
      compileExpression(expr.left, state, left);
      const right = state.allocator.alloc();
      compileExpression(expr.right, state, right);
      let op;
      let swapForGt = false;
      switch (expr.operator) {
        case "+":
          op = state.opcodes.ADD;
          break;
        case "-":
          op = state.opcodes.SUB;
          break;
        case "*":
          op = state.opcodes.MUL;
          break;
        case "/":
          op = state.opcodes.DIV;
          break;
        case "%":
          op = state.opcodes.MOD;
          break;
        case "^":
          op = state.opcodes.POW;
          break;
        case "..":
          op = state.opcodes.CONCAT;
          break;
        case "==":
          op = state.opcodes.EQ;
          break;
        case "<":
          op = state.opcodes.LT;
          break;
        case "<=":
          op = state.opcodes.LE;
          break;
        // ~=, >, >= are all expressed via EQ/LT/LE: `a ~= b` is `not (a ==
        // b)`, and `a > b` / `a >= b` are `b < a` / `b <= a` with operands
        // swapped, so the instruction set doesn't need four more opcodes.
        case "~=":
          op = state.opcodes.EQ;
          break;
        case ">":
          op = state.opcodes.LT;
          swapForGt = true;
          break;
        case ">=":
          op = state.opcodes.LE;
          swapForGt = true;
          break;
        case "//":
          op = state.opcodes.IDIV;
          break;
        default:
          throw new Error(`VMify: unsupported binary operator '${expr.operator}'`);
      }
      const a = swapForGt ? right : left;
      const b = swapForGt ? left : right;
      state.code.push({ op, a: target, b: a, c: b });
      if (expr.operator === "~=") {
        state.code.push({ op: state.opcodes.NOT, a: target, b: target, c: 0 });
      }
      return;
    }
    case "IfExpression": {
      const endJumps = [];
      for (let i = 0; i < expr.clauses.length; i++) {
        const clause = expr.clauses[i];
        const isLast = clause.condition === null;
        let skipPc = -1;
        if (!isLast) {
          const condReg = state.allocator.alloc();
          compileExpression(clause.condition, state, condReg);
          skipPc = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
        }
        compileExpression(clause.body, state, target);
        if (!isLast) {
          endJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
          patchJumpTarget(state, skipPc, state.code.length);
        }
      }
      const endPc = state.code.length;
      for (const j of endJumps) {
        patchJumpTarget(state, j, endPc);
      }
      return;
    }
    case "InterpolatedStringExpression": {
      const { strings, expressions } = expr;
      let haveValue = false;
      for (let i = 0; i < strings.length; i++) {
        if (strings[i].length > 0 || i === 0) {
          if (!haveValue) {
            const pc = state.code.length;
            state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, strings[i]), c: 0 });
            haveValue = true;
          } else {
            const piece = state.allocator.alloc();
            const pc = state.code.length;
            state.code.push({ op: state.opcodes.LOADK, a: piece, b: keyedConst(state, pc, strings[i]), c: 0 });
            state.code.push({ op: state.opcodes.CONCAT, a: target, b: target, c: piece });
          }
        }
        if (i < expressions.length) {
          const raw = state.allocator.alloc();
          compileExpression(expressions[i], state, raw);
          if (!haveValue) {
            state.code.push({ op: state.opcodes.TOSTRING, a: target, b: raw, c: 0 });
            haveValue = true;
          } else {
            const piece = state.allocator.alloc();
            state.code.push({ op: state.opcodes.TOSTRING, a: piece, b: raw, c: 0 });
            state.code.push({ op: state.opcodes.CONCAT, a: target, b: target, c: piece });
          }
        }
      }
      if (!haveValue) {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, ""), c: 0 });
      }
      return;
    }
    case "TableConstructorExpression": {
      state.code.push({ op: state.opcodes.NEWTABLE, a: target, b: 0, c: 0 });
      let arrayIndex = 1;
      expr.fields.forEach((field, i) => {
        const isLast = i === expr.fields.length - 1;
        if (field.type === "TableValue") {
          if (isLast && field.value.type === "VarargLiteral") {
            state.code.push({ op: state.opcodes.SPREADVARARG, a: target, b: arrayIndex, c: 0 });
            return;
          }
          if (isLast && field.value.type === "CallExpression") {
            const scratch = state.allocator.alloc();
            compileCallIntoWithCapture(field.value, state, scratch);
            state.code.push({ op: state.opcodes.SPREADMULTRET, a: target, b: arrayIndex, c: 0 });
            return;
          }
          const valReg2 = state.allocator.alloc();
          compileExpression(field.value, state, valReg2);
          const keyReg2 = state.allocator.alloc();
          const pc = state.code.length;
          state.code.push({ op: state.opcodes.LOADK, a: keyReg2, b: keyedConst(state, pc, arrayIndex), c: 0 });
          state.code.push({ op: state.opcodes.SETINDEX, a: target, b: keyReg2, c: valReg2 });
          arrayIndex++;
          return;
        }
        if (field.type === "TableKeyString") {
          const valReg2 = state.allocator.alloc();
          compileExpression(field.value, state, valReg2);
          const keyReg2 = state.allocator.alloc();
          const pc = state.code.length;
          state.code.push({ op: state.opcodes.LOADK, a: keyReg2, b: keyedConst(state, pc, field.key.name), c: 0 });
          state.code.push({ op: state.opcodes.SETINDEX, a: target, b: keyReg2, c: valReg2 });
          return;
        }
        const keyReg = state.allocator.alloc();
        compileExpression(field.key, state, keyReg);
        const valReg = state.allocator.alloc();
        compileExpression(field.value, state, valReg);
        state.code.push({ op: state.opcodes.SETINDEX, a: target, b: keyReg, c: valReg });
      });
      return;
    }
    case "CallExpression": {
      compileCallInto(expr, state, target);
      return;
    }
    case "TableCallExpression": {
      compileCallInto(callExpr(expr.base, [expr.arguments[0]]), state, target);
      return;
    }
    case "StringCallExpression": {
      compileCallInto(callExpr(expr.base, [expr.argument]), state, target);
      return;
    }
    case "ParenthesizedExpression": {
      compileExpression(expr.expression, state, target);
      return;
    }
  }
  throw new Error(
    `VMify: unsupported expression type '${expr.type}' (only ParenthesizedExpression was missing \u2014 see the case added above; anything else here is a genuinely new gap, not the closures/upvalues work)`
  );
}
function compileCallInto(call, state, target, nret = 1) {
  let unwrappedBase = call.base;
  while (unwrappedBase.type === "ParenthesizedExpression") {
    unwrappedBase = unwrappedBase.expression;
  }
  const isMethodCall = unwrappedBase.type === "MemberExpression" && unwrappedBase.indexer === ":";
  let func;
  let selfReg;
  if (isMethodCall) {
    const memberBase = unwrappedBase;
    selfReg = state.allocator.alloc();
    compileExpression(memberBase.base, state, selfReg);
    const keyReg = state.allocator.alloc();
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, memberBase.identifier.name), c: 0 });
    func = state.allocator.alloc();
    state.code.push({ op: state.opcodes.GETINDEX, a: func, b: selfReg, c: keyReg });
  } else {
    func = state.allocator.alloc();
    compileExpression(call.base, state, func);
  }
  const lastArg = call.arguments[call.arguments.length - 1];
  const varargSpread = call.arguments.length > 0 && lastArg.type === "VarargLiteral";
  const callSpread = !varargSpread && call.arguments.length > 0 && lastArg.type === "CallExpression";
  const fixedArgs = varargSpread || callSpread ? call.arguments.slice(0, -1) : call.arguments;
  let argBase;
  if (selfReg === void 0 && fixedArgs.length === 0) {
    argBase = state.allocator.alloc();
  } else {
    const argScratch = selfReg !== void 0 ? [selfReg] : [];
    for (const argExpr of fixedArgs) {
      const r = state.allocator.alloc();
      compileExpression(argExpr, state, r);
      argScratch.push(r);
    }
    argBase = state.allocator.alloc();
    for (let i = 1; i < argScratch.length; i++) state.allocator.alloc();
    argScratch.forEach((r, i) => {
      state.code.push({ op: state.opcodes.MOVE, a: argBase + i, b: r, c: 0 });
    });
  }
  let spreadKind = 0;
  if (varargSpread) {
    spreadKind = 1;
  } else if (callSpread) {
    const scratch = state.allocator.alloc();
    compileCallIntoWithCapture(lastArg, state, scratch);
    spreadKind = 2;
  }
  state.code.push({
    op: state.opcodes.CALL,
    a: target,
    b: func,
    c: argBase,
    nargs: (selfReg !== void 0 ? 1 : 0) + fixedArgs.length,
    nret,
    spreadKind
  });
}
function compileCallIntoWithCapture(call, state, target) {
  compileCallInto(call, state, target, 1);
  state.code[state.code.length - 1].captureMultret = true;
}
function patchJumpTarget(state, jmpPc, destPc) {
  const instr = state.code[jmpPc];
  const k = keyAt(state.keySeed, jmpPc);
  instr.b = destPc ^ k;
}
function writeAssignTarget(v, srcReg, state) {
  if (v.type === "Identifier") {
    if (writeVarFrom(v, state, srcReg)) return;
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.SETGLOBAL, a: srcReg, b: keyedGlobalConst(state, pc, v.name), c: 0 });
    return;
  }
  if (v.type === "MemberExpression" || v.type === "IndexExpression") {
    const baseReg = state.allocator.alloc();
    compileExpression(v.base, state, baseReg);
    const keyReg = state.allocator.alloc();
    if (v.type === "MemberExpression") {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, v.identifier.name), c: 0 });
    } else {
      compileExpression(v.index, state, keyReg);
    }
    state.code.push({ op: state.opcodes.SETINDEX, a: baseReg, b: keyReg, c: srcReg });
    return;
  }
  throw new Error(
    `VMify: unsupported assignment target '${v.type}' (only identifiers and t.k / t[k] are supported)`
  );
}
function compileSingleInit(v, expr, state) {
  if (v.type === "Identifier") {
    const bid = v.bindingId;
    const local = bid != null ? state.regs.get(bid) : void 0;
    if (local !== void 0) {
      if (expr) {
        compileExpression(expr, state, local);
      } else {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: local, b: keyedConst(state, pc, null), c: 0 });
      }
      return;
    }
    const box = bid != null ? state.boxIndex.get(bid) : void 0;
    if (box !== void 0) {
      const temp = state.allocator.alloc();
      if (expr) {
        compileExpression(expr, state, temp);
      } else {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: temp, b: keyedConst(state, pc, null), c: 0 });
      }
      state.code.push({ op: state.opcodes.SETUPVAL, a: box, b: temp, c: 0 });
      return;
    }
    {
      const temp = state.allocator.alloc();
      if (expr) {
        compileExpression(expr, state, temp);
      } else {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: temp, b: keyedConst(state, pc, null), c: 0 });
      }
      const pc2 = state.code.length;
      state.code.push({ op: state.opcodes.SETGLOBAL, a: temp, b: keyedGlobalConst(state, pc2, v.name), c: 0 });
    }
    return;
  }
  if (v.type === "MemberExpression" || v.type === "IndexExpression") {
    const baseReg = state.allocator.alloc();
    compileExpression(v.base, state, baseReg);
    const keyReg = state.allocator.alloc();
    if (v.type === "MemberExpression") {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, v.identifier.name), c: 0 });
    } else {
      compileExpression(v.index, state, keyReg);
    }
    const valReg = state.allocator.alloc();
    if (expr) {
      compileExpression(expr, state, valReg);
    } else {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: valReg, b: keyedConst(state, pc, null), c: 0 });
    }
    state.code.push({ op: state.opcodes.SETINDEX, a: baseReg, b: keyReg, c: valReg });
    return;
  }
  throw new Error(
    `VMify: unsupported assignment target '${v.type}' (only identifiers and t.k / t[k] are supported)`
  );
}
function compileAssignment(stmt, state) {
  const nInit = stmt.init.length;
  const nVars = stmt.variables.length;
  if (nInit > 0 && nVars > nInit && stmt.init[nInit - 1].type === "CallExpression") {
    for (let i = 0; i < nInit - 1; i++) {
      state.allocator.reset(state.regFloor);
      compileSingleInit(stmt.variables[i], stmt.init[i], state);
    }
    state.allocator.reset(state.regFloor);
    const remaining = nVars - (nInit - 1);
    const base2 = state.allocator.alloc();
    for (let i = 1; i < remaining; i++) state.allocator.alloc();
    compileCallInto(stmt.init[nInit - 1], state, base2, remaining);
    for (let i = 0; i < remaining; i++) {
      writeAssignTarget(stmt.variables[nInit - 1 + i], base2 + i, state);
    }
    return;
  }
  stmt.variables.forEach((v, i) => {
    state.allocator.reset(state.regFloor);
    compileSingleInit(v, stmt.init[i], state);
  });
}
function opForBinary(op, state) {
  switch (op) {
    case "+":
      return state.opcodes.ADD;
    case "-":
      return state.opcodes.SUB;
    case "*":
      return state.opcodes.MUL;
    case "/":
      return state.opcodes.DIV;
    case "//":
      return state.opcodes.IDIV;
    case "%":
      return state.opcodes.MOD;
    case "^":
      return state.opcodes.POW;
    case "..":
      return state.opcodes.CONCAT;
    default:
      throw new Error(`VMify: internal error \u2014 unexpected compound-assignment base operator '${op}'`);
  }
}
function compileCompoundAssignment(stmt, state) {
  const opMap = {
    "+=": "+",
    "-=": "-",
    "*=": "*",
    "/=": "/",
    "//=": "//",
    "%=": "%",
    "^=": "^",
    "..=": ".."
  };
  const binOp = opMap[stmt.operator];
  const opcode = opForBinary(binOp, state);
  const v = stmt.variable;
  if (v.type === "Identifier") {
    const bid = v.bindingId;
    const local = bid != null ? state.regs.get(bid) : void 0;
    if (local !== void 0) {
      state.allocator.reset(state.regFloor);
      const rhs2 = state.allocator.alloc();
      compileExpression(stmt.value, state, rhs2);
      state.code.push({ op: opcode, a: local, b: local, c: rhs2 });
      return;
    }
    const box = bid != null ? state.boxIndex.get(bid) : void 0;
    if (box !== void 0) {
      state.allocator.reset(state.regFloor);
      const cur2 = state.allocator.alloc();
      state.code.push({ op: state.opcodes.GETUPVAL, a: cur2, b: box, c: 0 });
      const rhs2 = state.allocator.alloc();
      compileExpression(stmt.value, state, rhs2);
      state.code.push({ op: opcode, a: cur2, b: cur2, c: rhs2 });
      state.code.push({ op: state.opcodes.SETUPVAL, a: box, b: cur2, c: 0 });
      return;
    }
    state.allocator.reset(state.regFloor);
    const cur = state.allocator.alloc();
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.GETGLOBAL, a: cur, b: keyedGlobalConst(state, pc, v.name), c: 0 });
    const rhs = state.allocator.alloc();
    compileExpression(stmt.value, state, rhs);
    state.code.push({ op: opcode, a: cur, b: cur, c: rhs });
    const pc2 = state.code.length;
    state.code.push({ op: state.opcodes.SETGLOBAL, a: cur, b: keyedGlobalConst(state, pc2, v.name), c: 0 });
    return;
  }
  if (v.type === "MemberExpression" || v.type === "IndexExpression") {
    state.allocator.reset(state.regFloor);
    const baseReg = state.allocator.alloc();
    compileExpression(v.base, state, baseReg);
    const keyReg = state.allocator.alloc();
    if (v.type === "MemberExpression") {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, v.identifier.name), c: 0 });
    } else {
      compileExpression(v.index, state, keyReg);
    }
    const cur = state.allocator.alloc();
    state.code.push({ op: state.opcodes.GETINDEX, a: cur, b: baseReg, c: keyReg });
    const rhs = state.allocator.alloc();
    compileExpression(stmt.value, state, rhs);
    state.code.push({ op: opcode, a: cur, b: cur, c: rhs });
    state.code.push({ op: state.opcodes.SETINDEX, a: baseReg, b: keyReg, c: cur });
    return;
  }
  throw new Error(
    `VMify: unsupported compound-assignment target '${v.type}'`
  );
}
function compileIf(stmt, state) {
  const endJumps = [];
  for (let i = 0; i < stmt.clauses.length; i++) {
    const clause = stmt.clauses[i];
    const isLast = i === stmt.clauses.length - 1;
    let skipPc = -1;
    if (clause.type !== "ElseClause") {
      state.allocator.reset(state.regFloor);
      const condReg = state.allocator.alloc();
      compileExpression(clause.condition, state, condReg);
      skipPc = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
    }
    for (const s of clause.body) {
      state.allocator.reset(state.regFloor);
      compileStatement(s, state);
    }
    if (!isLast) {
      endJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
    }
    if (skipPc !== -1) {
      patchJumpTarget(state, skipPc, state.code.length);
    }
  }
  const endPc = state.code.length;
  for (const j of endJumps) {
    patchJumpTarget(state, j, endPc);
  }
}
function compileWhile(stmt, state) {
  const loopStart = state.code.length;
  state.allocator.reset(state.regFloor);
  const condReg = state.allocator.alloc();
  compileExpression(stmt.condition, state, condReg);
  const exitJmp = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
  state.loopStack.push({ continueJumps: [], breakJumps: [] });
  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }
  const backJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);
  const exitPc = state.code.length;
  patchJumpTarget(state, exitJmp, exitPc);
  const frame = state.loopStack.pop();
  for (const j of frame.continueJumps) patchJumpTarget(state, j, loopStart);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);
}
function compileRepeat(stmt, state) {
  const loopStart = state.code.length;
  state.loopStack.push({ continueJumps: [], breakJumps: [] });
  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }
  const condPc = state.code.length;
  state.allocator.reset(state.regFloor);
  const condReg = state.allocator.alloc();
  compileExpression(stmt.condition, state, condReg);
  const backJmp = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);
  const exitPc = state.code.length;
  const frame = state.loopStack.pop();
  for (const j of frame.continueJumps) patchJumpTarget(state, j, condPc);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);
}
function compileForNumeric(stmt, state) {
  if (stmt.variable.type !== "Identifier") {
    throw new Error("VMify: for-loop variable must be a plain identifier");
  }
  const loopBid = stmt.variable.bindingId;
  if (loopBid != null && state.boxIndex.has(loopBid)) {
    throw new Error(
      `VMify: closures capturing the for-loop variable '${stmt.variable.name}' are not supported yet \u2014 this VM does not give loop variables a fresh binding per iteration, so the closure would see a stale/shared value instead of its own. Copy the loop variable into a plain local declared inside the loop body first (e.g. \`local i_ = i\`) and capture that instead.`
    );
  }
  const loopReg = loopBid != null ? state.regs.get(loopBid) : void 0;
  if (loopReg === void 0) {
    throw new Error("VMify: internal error \u2014 for-loop variable was not hoisted to a register");
  }
  state.allocator.reset(state.regFloor);
  compileExpression(stmt.start, state, loopReg);
  const limitReg = state.allocator.alloc();
  compileExpression(stmt.end, state, limitReg);
  const stepReg = state.allocator.alloc();
  if (stmt.step) {
    compileExpression(stmt.step, state, stepReg);
  } else {
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: stepReg, b: keyedConst(state, pc, 1), c: 0 });
  }
  const stepNonNegReg = state.allocator.alloc();
  {
    const zeroReg = state.allocator.alloc();
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: zeroReg, b: keyedConst(state, pc, 0), c: 0 });
    state.code.push({ op: state.opcodes.LE, a: stepNonNegReg, b: zeroReg, c: stepReg });
  }
  const loopStart = state.code.length;
  const outerFloor = state.regFloor;
  state.regFloor = state.allocator.high();
  state.allocator.reset(state.regFloor);
  const condReg = state.allocator.alloc();
  const negBranchJmp = push(state, { op: state.opcodes.JMPIFNOT, a: stepNonNegReg, b: -1, c: 0 });
  state.code.push({ op: state.opcodes.LE, a: condReg, b: loopReg, c: limitReg });
  const condDoneJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, negBranchJmp, state.code.length);
  state.code.push({ op: state.opcodes.LE, a: condReg, b: limitReg, c: loopReg });
  patchJumpTarget(state, condDoneJmp, state.code.length);
  const exitJmp = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
  state.loopStack.push({ continueJumps: [], breakJumps: [] });
  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }
  const stepPc = state.code.length;
  state.allocator.reset(state.regFloor);
  state.code.push({ op: state.opcodes.ADD, a: loopReg, b: loopReg, c: stepReg });
  const backJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);
  const exitPc = state.code.length;
  patchJumpTarget(state, exitJmp, exitPc);
  const frame = state.loopStack.pop();
  for (const j of frame.continueJumps) patchJumpTarget(state, j, stepPc);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);
  state.regFloor = outerFloor;
}
function compileForGeneric(stmt, state) {
  state.allocator.reset(state.regFloor);
  const fReg = state.allocator.alloc();
  const sReg = state.allocator.alloc();
  const cReg = state.allocator.alloc();
  const outerFloor = state.regFloor;
  state.regFloor = outerFloor + 3;
  if (stmt.iterators.length === 1 && stmt.iterators[0].type === "CallExpression") {
    compileCallInto(stmt.iterators[0], state, fReg, 3);
  } else {
    compileExpression(stmt.iterators[0], state, fReg);
    if (stmt.iterators[1]) {
      compileExpression(stmt.iterators[1], state, sReg);
    } else {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: sReg, b: keyedConst(state, pc, null), c: 0 });
    }
    if (stmt.iterators[2]) {
      compileExpression(stmt.iterators[2], state, cReg);
    } else {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: cReg, b: keyedConst(state, pc, null), c: 0 });
    }
  }
  const varRegs = stmt.variables.map((v) => {
    if (v.type !== "Identifier") {
      throw new Error("VMify: generic-for variables must be plain identifiers");
    }
    const bid = v.bindingId;
    if (bid != null && state.boxIndex.has(bid)) {
      throw new Error(
        `VMify: closures capturing the for-in variable '${v.name}' are not supported yet \u2014 this VM does not give loop variables a fresh binding per iteration. Copy it into a plain local declared inside the loop body first and capture that.`
      );
    }
    const r = bid != null ? state.regs.get(bid) : void 0;
    if (r === void 0) {
      throw new Error("VMify: internal error \u2014 generic-for variable was not hoisted to a register");
    }
    return r;
  });
  const loopStart = state.code.length;
  state.allocator.reset(state.regFloor);
  const callFunc = state.allocator.alloc();
  state.code.push({ op: state.opcodes.MOVE, a: callFunc, b: fReg, c: 0 });
  const argBase = state.allocator.alloc();
  state.code.push({ op: state.opcodes.MOVE, a: argBase, b: sReg, c: 0 });
  const argCtrl = state.allocator.alloc();
  state.code.push({ op: state.opcodes.MOVE, a: argCtrl, b: cReg, c: 0 });
  const retBase = state.allocator.alloc();
  for (let i = 1; i < varRegs.length; i++) state.allocator.alloc();
  state.code.push({
    op: state.opcodes.CALL,
    a: retBase,
    b: callFunc,
    c: argBase,
    nargs: 2,
    nret: Math.max(varRegs.length, 1)
  });
  varRegs.forEach((r, i) => {
    state.code.push({ op: state.opcodes.MOVE, a: r, b: retBase + i, c: 0 });
  });
  const nilReg = state.allocator.alloc();
  {
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: nilReg, b: keyedConst(state, pc, null), c: 0 });
  }
  const testReg = state.allocator.alloc();
  state.code.push({ op: state.opcodes.EQ, a: testReg, b: varRegs[0], c: nilReg });
  const exitJmp = push(state, { op: state.opcodes.JMPIF, a: testReg, b: -1, c: 0 });
  state.code.push({ op: state.opcodes.MOVE, a: cReg, b: varRegs[0], c: 0 });
  state.loopStack.push({ continueJumps: [], breakJumps: [] });
  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }
  const backJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);
  const exitPc = state.code.length;
  patchJumpTarget(state, exitJmp, exitPc);
  const frame = state.loopStack.pop();
  for (const j of frame.continueJumps) patchJumpTarget(state, j, loopStart);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);
  state.regFloor = outerFloor;
}
function compileStatement(stmt, state) {
  switch (stmt.type) {
    case "AssignmentStatement":
      compileAssignment(stmt, state);
      return;
    case "CompoundAssignmentStatement":
      state.allocator.reset(state.regFloor);
      compileCompoundAssignment(stmt, state);
      return;
    case "CallStatement": {
      const call = stmt.expression;
      const asCall = call.type === "CallExpression" ? call : call.type === "TableCallExpression" ? callExpr(call.base, [call.arguments[0]]) : call.type === "StringCallExpression" ? callExpr(call.base, [call.argument]) : (() => {
        throw new Error(`VMify: unsupported call statement form '${call.type}'`);
      })();
      state.allocator.reset(state.regFloor);
      const scratch = state.allocator.alloc();
      compileCallInto(asCall, state, scratch);
      return;
    }
    case "IfStatement":
      compileIf(stmt, state);
      return;
    case "WhileStatement":
      compileWhile(stmt, state);
      return;
    case "RepeatStatement":
      compileRepeat(stmt, state);
      return;
    case "ForNumericStatement":
      compileForNumeric(stmt, state);
      return;
    case "ForGenericStatement":
      compileForGeneric(stmt, state);
      return;
    case "DoStatement":
      for (const s of stmt.body) {
        state.allocator.reset(state.regFloor);
        compileStatement(s, state);
      }
      return;
    case "BreakStatement": {
      const frame = state.loopStack[state.loopStack.length - 1];
      if (!frame) {
        throw new Error("VMify: break used outside of a loop");
      }
      frame.breakJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
      return;
    }
    case "ContinueStatement": {
      const frame = state.loopStack[state.loopStack.length - 1];
      if (!frame) {
        throw new Error("VMify: continue used outside of a loop");
      }
      frame.continueJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
      return;
    }
    case "GotoStatement": {
      const pc = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
      state.pendingGotos.push({ name: stmt.label, pc });
      return;
    }
    case "LabelStatement": {
      if (state.labels.has(stmt.name)) {
        throw new Error(`VMify: duplicate label '${stmt.name}'`);
      }
      state.labels.set(stmt.name, state.code.length);
      return;
    }
    case "FunctionDeclaration": {
      if (stmt.identifier === null) {
        throw new Error("VMify: internal error \u2014 anonymous FunctionDeclaration reached compileStatement");
      }
      const anon = { ...stmt, identifier: null, isLocal: false };
      const tmp = state.allocator.alloc();
      compileExpression(anon, state, tmp);
      writeAssignTarget(stmt.identifier, tmp, state);
      return;
    }
    default:
      throw new Error(
        `VMify: unsupported statement type '${stmt.type}'`
      );
  }
}
function buildPoolDecl(poolName, pool) {
  return localStmt(
    [ident(poolName)],
    [tableCtor(pool.values.map((v) => tableValue(constNodeFor(v))))]
  );
}
function buildUpvalsDecl(upvalsName, count) {
  const box = () => tableCtor([
    {
      type: "TableKeyString",
      key: { type: "Identifier", name: "v", attribute: null, typeAnnotation: null, scope: "global", isField: true, bindingId: null, range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } },
      value: nilLit(),
      range: [0, 0],
      loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
    }
  ]);
  return localStmt(
    [ident(upvalsName)],
    [tableCtor(Array.from({ length: count }, box).map(tableValue))]
  );
}
function buildRawPoolDecl(rawPoolName, entries) {
  return localStmt(
    [ident(rawPoolName)],
    [tableCtor(entries.map(tableValue))]
  );
}
var DUMMY_RANGE2 = [0, 0];
var DUMMY_LOC2 = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
function buildEnvDecl(envName, usedGlobals) {
  const fields = Array.from(usedGlobals).map((name) => ({
    type: "TableKeyString",
    key: {
      type: "Identifier",
      name,
      attribute: null,
      typeAnnotation: null,
      scope: "global",
      isField: true,
      bindingId: null,
      range: DUMMY_RANGE2,
      loc: DUMMY_LOC2
    },
    value: {
      type: "Identifier",
      name,
      attribute: null,
      typeAnnotation: null,
      scope: "global",
      isField: false,
      bindingId: null,
      range: DUMMY_RANGE2,
      loc: DUMMY_LOC2
    },
    range: DUMMY_RANGE2,
    loc: DUMMY_LOC2
  }));
  return localStmt([ident(envName)], [tableCtor(fields)]);
}
function buildCodeDecl(codeName, code) {
  return localStmt(
    [ident(codeName)],
    [
      tableCtor(
        code.map(
          (ins) => tableValue(
            tableCtor([
              tableValue(numLit(ins.op)),
              tableValue(numLit(ins.a)),
              tableValue(numLit(ins.b)),
              tableValue(numLit(ins.c)),
              tableValue(numLit(ins.nargs ?? 0)),
              tableValue(numLit(ins.spreadKind ?? 0)),
              tableValue(numLit(ins.nret ?? 1)),
              tableValue(numLit(ins.captureMultret ? 1 : 0))
            ])
          )
        )
      )
    ]
  );
}
function buildRuntimeSource(names, opcodes, keySeed) {
  const {
    poolName,
    codeName,
    rawPoolName,
    upvalsName,
    xorName,
    keyName,
    regsName,
    pcName,
    insName,
    opName,
    aName,
    bName,
    cName,
    nName,
    argsName,
    iName,
    bucketName,
    vaName,
    jumpedName,
    envName,
    mrName
  } = names;
  const BUCKETS = 4;
  const buckets = Array.from({ length: BUCKETS }, () => []);
  for (const name of OPCODE_NAMES) {
    buckets[opcodes[name] % BUCKETS].push(name);
  }
  const bReg = `(${bName} + 1)`;
  const keyVal = `${keyName}_v`;
  function branchFor(name) {
    switch (name) {
      case "MOVE":
        return `${regsName}[${aName}] = ${regsName}[${bReg}]`;
      case "LOADK":
        return `${regsName}[${aName}] = ${poolName}[${xorName}(${bName}, ${keyVal}) + 1]`;
      case "GETGLOBAL":
        return `${regsName}[${aName}] = ${envName}[${poolName}[${xorName}(${bName}, ${keyVal}) + 1]]`;
      case "SETGLOBAL":
        return `${envName}[${poolName}[${xorName}(${bName}, ${keyVal}) + 1]] = ${regsName}[${aName}]`;
      case "GETINDEX":
        return `${regsName}[${aName}] = ${regsName}[${bReg}][${regsName}[${cName}]]`;
      case "SETINDEX":
        return `${regsName}[${aName}][${regsName}[${bReg}]] = ${regsName}[${cName}]`;
      case "NEWTABLE":
        return `${regsName}[${aName}] = {}`;
      case "ADD":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] + ${regsName}[${cName}]`;
      case "SUB":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] - ${regsName}[${cName}]`;
      case "MUL":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] * ${regsName}[${cName}]`;
      case "DIV":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] / ${regsName}[${cName}]`;
      case "IDIV":
        return `${regsName}[${aName}] = math.floor(${regsName}[${bReg}] / ${regsName}[${cName}])`;
      case "MOD":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] % ${regsName}[${cName}]`;
      case "POW":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] ^ ${regsName}[${cName}]`;
      case "CONCAT":
        return `${regsName}[${aName}] = ${regsName}[${bReg}] .. ${regsName}[${cName}]`;
      case "UNM":
        return `${regsName}[${aName}] = -${regsName}[${bReg}]`;
      case "NOT":
        return `${regsName}[${aName}] = not ${regsName}[${bReg}]`;
      case "LEN":
        return `${regsName}[${aName}] = #${regsName}[${bReg}]`;
      case "EQ":
        return `${regsName}[${aName}] = (${regsName}[${bReg}] == ${regsName}[${cName}])`;
      case "LT":
        return `${regsName}[${aName}] = (${regsName}[${bReg}] < ${regsName}[${cName}])`;
      case "LE":
        return `${regsName}[${aName}] = (${regsName}[${bReg}] <= ${regsName}[${cName}])`;
      case "JMP":
        return `${pcName} = ${xorName}(${bName}, ${keyVal})
      ${jumpedName} = true`;
      case "JMPIF":
        return `if ${regsName}[${aName}] then
        ${pcName} = ${xorName}(${bName}, ${keyVal})
        ${jumpedName} = true
      end`;
      case "JMPIFNOT":
        return `if not ${regsName}[${aName}] then
        ${pcName} = ${xorName}(${bName}, ${keyVal})
        ${jumpedName} = true
      end`;
      case "VARARG":
        return `${regsName}[${aName}] = ${vaName}[1]`;
      case "TOSTRING":
        return `${regsName}[${aName}] = tostring(${regsName}[${bReg}])`;
      case "GETUPVAL":
        return `${regsName}[${aName}] = ${upvalsName}[${bName} + 1].v`;
      case "SETUPVAL":
        return `${upvalsName}[${aName}].v = ${regsName}[${bReg}]`;
      case "LOADRAW":
        return `${regsName}[${aName}] = ${rawPoolName}[${bName} + 1]`;
      case "SPREADVARARG":
        return `for __si = 1, #${vaName} do ${regsName}[${aName}][${bName} + __si - 1] = ${vaName}[__si] end`;
      case "SPREADMULTRET":
        return `for __si = 1, #${mrName} do ${regsName}[${aName}][${bName} + __si - 1] = ${mrName}[__si] end`;
      case "CALL": {
        return `local ${argsName} = {}
    local ${iName}n = ${nName}
    for ${iName} = 1, ${nName} do ${argsName}[${iName}] = ${regsName}[${cName} + ${iName} - 1] end
    if ${insName}[6] == 1 then
      for ${iName} = 1, #${vaName} do ${argsName}[${nName} + ${iName}] = ${vaName}[${iName}] end
      ${iName}n = ${nName} + #${vaName}
    elseif ${insName}[6] == 2 then
      for ${iName} = 1, #${mrName} do ${argsName}[${nName} + ${iName}] = ${mrName}[${iName}] end
      ${iName}n = ${nName} + #${mrName}
    end
    local __rets = { ${regsName}[${bReg}](table.unpack(${argsName}, 1, ${iName}n)) }
    if ${insName}[8] == 1 then ${mrName} = __rets end
    local __nret = ${insName}[7] or 1
    for __ri = 1, __nret do ${regsName}[${aName} + __ri - 1] = __rets[__ri] end`;
      }
      case "RETURN":
        return `do
      if ${insName}[6] == 1 then
        local __rt = {}
        for __i = 1, ${nName} do __rt[__i] = ${regsName}[__i] end
        for __i = 1, #${vaName} do __rt[${nName} + __i] = ${vaName}[__i] end
        return table.unpack(__rt, 1, ${nName} + #${vaName})
      elseif ${insName}[6] == 2 then
        local __rt = {}
        for __i = 1, ${nName} do __rt[__i] = ${regsName}[__i] end
        for __i = 1, #${mrName} do __rt[${nName} + __i] = ${mrName}[__i] end
        return table.unpack(__rt, 1, ${nName} + #${mrName})
      else
        if ${nName} == 0 then return end
        return table.unpack(${regsName}, 1, ${nName})
      end
    end`;
      case "NOP":
      case "XOR":
        return `${regsName}[${aName}] = ${xorName}(${regsName}[${bReg}], ${regsName}[${cName}])`;
      default:
        throw new Error(`VMify: no runtime codegen for opcode '${name}'`);
    }
  }
  const bucketBlocks = buckets.map((names2, idx) => {
    const arms = names2.map(
      (n) => `    if ${opName} == ${opcodes[n]} then
      ${branchFor(n)}
    end`
    ).join("\n");
    return `  if ${bucketName} == ${idx} then
` + arms + `
  end`;
  }).join("\n");
  return `
local function ${xorName}(a, b)
  local r = 0
  local bit = 1
  while a > 0 or b > 0 do
    local aa = a % 2
    local bb = b % 2
    if aa ~= bb then
      r = r + bit
    end
    a = math.floor(a / 2)
    b = math.floor(b / 2)
    bit = bit * 2
  end
  return r
end

-- Reproduces the compile-time key stream: keyAt(seed, pc) in vmify.ts.
local function ${keyName}(pc)
  local x = (${keySeed} + pc * 2654435761) % 4294967296
  x = (x * 1664525 + 1013904223) % 4294967296
  return (x % 251) + 1
end

local ${vaName} = { ... }
-- Shared "most recent captured call" return-value buffer, used to expand
-- a plain call (not '...') that sits in the LAST position of a call's
-- argument list or a return statement into ALL of its return values
-- (spreadKind 2 \u2014 see the Instr.spreadKind doc in vmify.ts).
local ${mrName} = {}

local ${regsName} = {}
local ${pcName} = 0

while true do
  local ${insName} = ${codeName}[${pcName} + 1]
  if not ${insName} then break end

  local ${opName} = ${insName}[1]
  local ${aName} = ${insName}[2] + 1
  local ${bName} = ${insName}[3]
  local ${cName} = ${insName}[4] + 1
  local ${nName} = ${insName}[5]
  local ${keyName}_v = ${keyName}(${pcName})
  local ${bucketName} = ${opName} % ${BUCKETS}
  local ${jumpedName} = false

${bucketBlocks}

  if not ${jumpedName} then ${pcName} = ${pcName} + 1 end
end
`;
}
var vmify = (chunk, ctx) => {
  const neededBoxes = computeNeededBoxes(chunk.body);
  const body = chunk.body.slice();
  if (body.length === 0) return chunk;
  let trailingReturn = null;
  if (body[body.length - 1].type === "ReturnStatement") {
    trailingReturn = body.pop();
  }
  const hoisted = [];
  const stmts = hoistAll(body, hoisted);
  const regs = /* @__PURE__ */ new Map();
  const boxIndex = /* @__PURE__ */ new Map();
  for (const id of hoisted) {
    const bid = id.bindingId;
    if (neededBoxes.has(bid)) {
      boxIndex.set(bid, boxIndex.size);
    } else {
      regs.set(bid, regs.size);
    }
  }
  const opcodes = buildShuffledOpcodes();
  const keySeed = randInt(1, 2147483647);
  const pool = new ConstantPool();
  const allocator = new RegisterAllocator();
  const used = /* @__PURE__ */ new Set();
  const upvalsName = randomVarName(used);
  const state = {
    pool,
    regs,
    boxIndex,
    rawPool: [],
    upvalsName,
    allocator,
    regFloor: regs.size,
    opcodes,
    keySeed,
    code: [],
    loopStack: [],
    labels: /* @__PURE__ */ new Map(),
    pendingGotos: [],
    usedGlobals: /* @__PURE__ */ new Set()
  };
  for (const stmt of stmts) {
    allocator.reset(regs.size);
    compileStatement(stmt, state);
  }
  if (trailingReturn) {
    const args = trailingReturn.arguments ?? [];
    const lastArg = args[args.length - 1];
    const varargSpread = args.length > 0 && lastArg.type === "VarargLiteral";
    const callSpread = !varargSpread && args.length > 0 && lastArg.type === "CallExpression";
    const fixedArgs = varargSpread || callSpread ? args.slice(0, -1) : args;
    fixedArgs.forEach((arg, i) => compileExpression(arg, state, i));
    let spreadKind = 0;
    if (varargSpread) {
      spreadKind = 1;
    } else if (callSpread) {
      state.allocator.reset(Math.max(state.allocator.high(), fixedArgs.length));
      const scratch = state.allocator.alloc();
      compileCallIntoWithCapture(lastArg, state, scratch);
      spreadKind = 2;
    }
    state.code.push({ op: opcodes.RETURN, a: 0, b: 0, c: 0, nargs: fixedArgs.length, spreadKind });
  }
  for (const { name, pc } of state.pendingGotos) {
    const dest = state.labels.get(name);
    if (dest === void 0) {
      throw new Error(`VMify: goto references undefined label '${name}'`);
    }
    patchJumpTarget(state, pc, dest);
  }
  const names = {
    poolName: randomVarName(used),
    codeName: randomVarName(used),
    rawPoolName: randomVarName(used),
    upvalsName: state.upvalsName,
    xorName: randomVarName(used),
    keyName: randomVarName(used),
    regsName: randomVarName(used),
    pcName: randomVarName(used),
    insName: randomVarName(used),
    opName: randomVarName(used),
    aName: randomVarName(used),
    bName: randomVarName(used),
    cName: randomVarName(used),
    nName: randomVarName(used),
    argsName: randomVarName(used),
    iName: randomVarName(used),
    bucketName: randomVarName(used),
    vaName: randomVarName(used),
    jumpedName: randomVarName(used),
    envName: randomVarName(used),
    mrName: randomVarName(used)
  };
  const poolDecl = buildPoolDecl(names.poolName, pool);
  const codeDecl = buildCodeDecl(names.codeName, state.code);
  const envDecl = buildEnvDecl(names.envName, state.usedGlobals);
  const upvalsDecl = buildUpvalsDecl(names.upvalsName, boxIndex.size);
  const rawPoolDecl = buildRawPoolDecl(names.rawPoolName, state.rawPool);
  const dialect = ctx.dialect.name;
  const runtimeSource = buildRuntimeSource(names, opcodes, keySeed);
  const runtimeChunk = parseSnippet(runtimeSource, dialect);
  const VMIFY_DEBUG = false;
  if (VMIFY_DEBUG) {
    const inv = {};
    for (const k of Object.keys(opcodes)) inv[opcodes[k]] = k;
    state.code.forEach((ins, pc) => {
      console.error(
        `pc=${pc} ${inv[ins.op]}(${ins.op}) a=${ins.a} b=${ins.b} c=${ins.c} nargs=${ins.nargs} spreadKind=${ins.spreadKind} nret=${ins.nret} captureMultret=${ins.captureMultret}`
      );
    });
  }
  const finalChunk = {
    ...chunk,
    body: [
      poolDecl,
      codeDecl,
      envDecl,
      upvalsDecl,
      rawPoolDecl,
      ...runtimeChunk.body
    ]
  };
  resolveScopes(finalChunk);
  return finalChunk;
};

// src/passes/junk.ts
var dummyLoc = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
var dummyRange = [0, 0];
var numLiteral = (value) => ({
  type: "NumericLiteral",
  value,
  raw: value.toString(),
  range: dummyRange,
  loc: dummyLoc
});
var JUNK_TEMPLATES = [
  // 1. 의미 없는 local
  () => {
    const name = randomVarName(/* @__PURE__ */ new Set());
    return localStmt([ident(name)], [numLiteral(randInt(100, 99999))]);
  },
  // 2. 의미 없는 연산
  () => {
    const name = randomVarName(/* @__PURE__ */ new Set());
    return assignStmt([ident(name)], [{
      type: "BinaryExpression",
      operator: choice(["+", "-", "*", "//", "%", "^"]),
      left: numLiteral(randInt(10, 500)),
      right: numLiteral(randInt(10, 500)),
      range: dummyRange,
      loc: dummyLoc
    }]);
  },
  // 3. 항상 false인 if
  () => {
    const dummyName = randomVarName(/* @__PURE__ */ new Set());
    return {
      type: "IfStatement",
      clauses: [{
        type: "IfClause",
        condition: {
          type: "BinaryExpression",
          operator: ">",
          left: numLiteral(randInt(100, 400)),
          right: numLiteral(randInt(500, 999)),
          range: dummyRange,
          loc: dummyLoc
        },
        body: [localStmt([ident(dummyName)], [{ type: "NilLiteral", range: dummyRange, loc: dummyLoc }])],
        range: dummyRange,
        loc: dummyLoc
      }],
      range: dummyRange,
      loc: dummyLoc
    };
  },
  // 4. pcall junk
  () => ({
    type: "CallStatement",
    expression: callExpr(ident("pcall"), [funcExpr([], [])]),
    range: dummyRange,
    loc: dummyLoc
  })
];
var insertJunk = (chunk, ctx, options) => {
  const probability = options.probability ?? 0.33;
  const maxPerBlock = options.maxPerBlock ?? 30;
  let junkCount = 0;
  const visit = (stmts) => {
    const result = [];
    for (const stmt of stmts) {
      if (junkCount < maxPerBlock && Math.random() < probability) {
        result.push(choice(JUNK_TEMPLATES)());
        junkCount++;
      }
      result.push(stmt);
      if ("body" in stmt && Array.isArray(stmt.body)) {
        stmt.body = visit(stmt.body);
      }
      if (stmt.type === "IfStatement") {
        const ifStmt = stmt;
        for (const clause of ifStmt.clauses) {
          if ("body" in clause && Array.isArray(clause.body)) {
            clause.body = visit(clause.body);
          }
        }
      }
    }
    return result;
  };
  chunk.body = visit(chunk.body);
  return chunk;
};

// src/passes/global-mapping.ts
var dummyRange2 = [0, 0];
var dummyLoc2 = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 }
};
var globalMapping = (chunk, ctx, options = {}) => {
  const globalTableName = options.globalTableName ?? "G";
  const keyMap = /* @__PURE__ */ new Map();
  resolveScopes(chunk);
  const transform = (node) => {
    if (!node || typeof node !== "object") return node;
    if (node.type === "Identifier" && node.name) {
      if (node.isField || node.scope !== "global") {
        for (const key2 in node) {
          if (key2 === "range" || key2 === "loc") continue;
          if (Array.isArray(node[key2])) {
            node[key2] = node[key2].map(transform);
          } else {
            node[key2] = transform(node[key2]);
          }
        }
        return node;
      }
      if (!keyMap.has(node.name)) {
        keyMap.set(node.name, randomKey(5));
      }
      const key = keyMap.get(node.name);
      return {
        type: "IndexExpression",
        base: ident(globalTableName),
        index: {
          type: "StringLiteral",
          value: key,
          raw: `"${key}"`,
          range: dummyRange2,
          loc: dummyLoc2
        },
        range: dummyRange2,
        loc: dummyLoc2
      };
    }
    for (const key in node) {
      if (key === "range" || key === "loc") continue;
      if (Array.isArray(node[key])) {
        node[key] = node[key].map(transform);
      } else {
        node[key] = transform(node[key]);
      }
    }
    return node;
  };
  transform(chunk);
  const globalFields = Array.from(keyMap.entries()).map(([name, key]) => ({
    type: "TableKeyString",
    key: {
      type: "Identifier",
      name: key,
      attribute: null,
      typeAnnotation: null,
      scope: "global",
      isField: true,
      bindingId: null,
      range: dummyRange2,
      loc: dummyLoc2
    },
    value: {
      type: "Identifier",
      name,
      attribute: null,
      typeAnnotation: null,
      scope: "global",
      isField: false,
      bindingId: null,
      range: dummyRange2,
      loc: dummyLoc2
    },
    range: dummyRange2,
    loc: dummyLoc2
  }));
  const globalTable = {
    type: "LocalStatement",
    variables: [{
      type: "Identifier",
      name: globalTableName,
      attribute: null,
      typeAnnotation: null,
      scope: "local",
      isField: false,
      bindingId: null,
      range: dummyRange2,
      loc: dummyLoc2
    }],
    init: [{
      type: "TableConstructorExpression",
      fields: globalFields,
      range: dummyRange2,
      loc: dummyLoc2
    }],
    range: dummyRange2,
    loc: dummyLoc2
  };
  if (!chunk.body) chunk.body = [];
  chunk.body.unshift(globalTable);
  return chunk;
};

// src/passes/wrap-function.ts
var wrapInFunction = (chunk, ctx) => {
  const fn = funcExpr([varargParam()], chunk.body, true);
  const call = callExpr(paren(fn), [varargParam()]);
  chunk.body = [returnStmt([call])];
  return chunk;
};

// src/passes/encrypt-numbers.ts
function buildDecryptHelper2(fnName, keyName, key, dialect) {
  const keyLiteral = `{${key.join(", ")}}`;
  const src = `
    local ${keyName} = ${keyLiteral}
    local function ${fnName}(_enc, _slot)
      local _k = ${keyName}[((_slot - 1) % #${keyName}) + 1]
      return _enc - _k
    end
  `;
  return parseSnippet(src, dialect.name).body;
}
var encryptNumbers = (chunk, ctx) => {
  const key = Array.from({ length: randInt(4, 8) }, () => randInt(1e3, 999999));
  const names = /* @__PURE__ */ new Set();
  const fnName = randomVarName(names);
  const keyName = randomVarName(names);
  let slot = 0;
  let touched = false;
  transformExpressions(chunk, (expr) => {
    if (expr.type === "NumericLiteral" && Number.isFinite(expr.value)) {
      touched = true;
      slot += 1;
      const k = key[(slot - 1) % key.length];
      return callExpr(ident(fnName), [numLit(expr.value + k), numLit(slot)]);
    }
    return null;
  });
  if (touched) {
    const helper = buildDecryptHelper2(fnName, keyName, key, ctx.dialect);
    chunk.body = [...helper, ...chunk.body];
  }
  return chunk;
};

// src/obfuscate.ts
function obfuscate(source, dialect, options) {
  const flags = resolveDialect(dialect);
  const ctx = { dialect: flags };
  const tokens = new Lexer(source, flags).tokenize();
  let chunk = new Parser(tokens, flags).parseChunk();
  resolveScopes(chunk);
  for (const step of options.steps) {
    chunk = runStep(chunk, ctx, step);
  }
  return generate(chunk, { minify: options.minify });
}
function runStep(chunk, ctx, step) {
  switch (step.name) {
    case "RenameVariables":
      return renameVariables(chunk, ctx, {});
    case "NumbersToExpressions":
      return numbersToExpressions(chunk, ctx, { min: step.min, max: step.max });
    case "StringsToExpressions":
      return stringsToExpressions(chunk, ctx, { min: step.min, max: step.max });
    case "EncryptStrings":
      return encryptStrings(chunk, ctx, {});
    case "EncryptNumbers":
      return encryptNumbers(chunk, ctx, {});
    case "ConstantArray":
      return constantArray(chunk, ctx, {});
    case "Vmify":
      return vmify(chunk, ctx, {});
    case "InsertJunk":
      return insertJunk(chunk, ctx, { probability: step.probability, maxPerBlock: step.maxPerBlock });
    case "GlobalMapping":
      return globalMapping(chunk, ctx, { globalTableName: step.globalTableName });
    case "WrapInFunction":
      return wrapInFunction(chunk, ctx, {});
    default: {
      const _exhaustive = step;
      throw new Error(`obfuscate: unknown step ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// src/index.ts
function parse(source, dialect) {
  const flags = resolveDialect(dialect);
  const tokens = new Lexer(source, flags).tokenize();
  const parser = new Parser(tokens, flags);
  const chunk = parser.parseChunk();
  resolveScopes(chunk);
  return chunk;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LexError,
  ParseError,
  UnknownDialectError,
  generate,
  obfuscate,
  parse,
  resolveScopes
});
