import { Token, TokenType, isKeyword, InterpolationPart } from './tokens';
import { DialectFlags } from '../dialect';

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * Dedicated parser for `0x` literals. `parseInt` stops as soon as it hits a
 * decimal point (`.`), so it would misparse a hex float like `0x1.8p2` as
 * just `1` (silently dropping the whole `8p2` part). Lua/Luau hex floats
 * have the form `mantissa(intPart.fracPart) * 2^exponent`, so we split the
 * integer/fraction/exponent parts and compute it directly.
 *   0x1.8p2  -> (1 + 8/16)   * 2^2  = 6
 *   0x.8p1   -> (0 + 8/16)   * 2^1  = 1
 *   0xFF     -> 255 (a plain hex integer with no exponent/fraction)
 */
function parseHexNumber(raw: string): number {
  const match = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(raw);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return NaN;

  const [, intDigits, fracDigits, expDigits] = match;
  let mantissa = intDigits.length > 0 ? parseInt(intDigits, 16) : 0;
  if (fracDigits && fracDigits.length > 0) {
    mantissa += parseInt(fracDigits, 16) / Math.pow(16, fracDigits.length);
  }
  const exponent = expDigits !== undefined ? parseInt(expDigits, 10) : 0;
  return mantissa * Math.pow(2, exponent);
}

export class LexError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`[${line}:${column}] ${message}`);
  }
}

/**
 * Converts source into a token stream.
 *
 * The lexing rules that actually branch on dialect (lua5.1 / luaU) are
 * whether `continue` and `goto` are keywords (see scanIdentifierOrKeyword
 * below) — `continue` is Luau-only, and `goto` is off for both dialects
 * this project currently supports (it's a Lua 5.2+ feature, and Luau never
 * adopted it either). All other Luau extensions —
 *   - compound assignment operators: += -= *= /= //= %= ^= ..=
 *   - backtick (`) string interpolation: `Hello {name}!`
 *   - the `<` and `>` used by <const> / <close> attributes (reusing the
 *     existing Punctuator)
 *   - // integer division
 * are always lexed as the same shape of token regardless of dialect. If one
 * of these tokens shows up in lua5.1 source, that's not an "invalid token"
 * but a "token not allowed in this dialect", so rejecting it is the parser's
 * job once it has context (that way we can produce a proper error message
 * like "compound assignment is Luau-only" instead of "unexpected symbol '+'").
 */
export class Lexer {
  private pos = 0;
  private line = 1;
  private lineStart = 0; // pos where the current line starts (for column calculation)

  constructor(private src: string, private dialect: DialectFlags) {}

  private get column(): number {
    return this.pos - this.lineStart + 1;
  }

  private peek(offset = 0): string {
    return this.src.charAt(this.pos + offset);
  }

  private advance(): string {
    const ch = this.src.charAt(this.pos);
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.lineStart = this.pos;
    }
    return ch;
  }

  private match(ch: string): boolean {
    if (this.peek() === ch) {
      this.advance();
      return true;
    }
    return false;
  }

  private error(msg: string): never {
    throw new LexError(msg, this.line, this.column);
  }

  /** Pulls the entire source into a token array in one pass (includes the EOF token). */
  public tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const tok = this.next();
      tokens.push(tok);
      if (tok.type === TokenType.EOF) break;
    }
    return tokens;
  }

  /** Reads and returns the next single token. */
  public next(): Token {
    this.skipWhitespaceAndComments();

    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.pos;

    if (this.pos >= this.src.length) {
      return this.makeToken(TokenType.EOF, null, startPos, startLine, startColumn);
    }

    const ch = this.peek();

    if (isIdentStart(ch)) return this.scanIdentifierOrKeyword(startPos, startLine, startColumn);
    if (isDigit(ch) || (ch === '.' && isDigit(this.peek(1)))) {
      return this.scanNumber(startPos, startLine, startColumn);
    }
    if (ch === '"' || ch === "'") return this.scanQuotedString(startPos, startLine, startColumn);
    if (ch === '`') return this.scanInterpolatedString(startPos, startLine, startColumn);
    if (ch === '[' && (this.peek(1) === '[' || this.peek(1) === '=')) {
      const long = this.tryScanLongBracket();
      if (long !== null) {
        return this.makeToken(TokenType.StringLiteral, long, startPos, startLine, startColumn);
      }
    }

    return this.scanPunctuator(startPos, startLine, startColumn);
  }

  // ---- Whitespace / comments ----

  private skipWhitespaceAndComments(): void {
    for (;;) {
      const ch = this.peek();
      if (WHITESPACE.has(ch)) {
        this.advance();
        continue;
      }
      if (ch === '-' && this.peek(1) === '-') {
        this.advance();
        this.advance();
        // First try a long comment --[[ ... ]]
        if (this.peek() === '[' && (this.peek(1) === '[' || this.peek(1) === '=')) {
          const long = this.tryScanLongBracket();
          if (long !== null) continue;
        }
        // Line comment
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
        continue;
      }
      break;
    }
  }

  // ---- Identifiers / keywords ----

  private scanIdentifierOrKeyword(startPos: number, line: number, column: number): Token {
    while (isIdentPart(this.peek())) this.advance();
    const word = this.src.slice(startPos, this.pos);

    if (word === 'true' || word === 'false') {
      return this.makeToken(TokenType.BooleanLiteral, word === 'true', startPos, line, column);
    }
    if (word === 'nil') {
      return this.makeToken(TokenType.NilLiteral, null, startPos, line, column);
    }
    if (isKeyword(word, this.dialect.continueKeyword, this.dialect.gotoStatements)) {
      return this.makeToken(TokenType.Keyword, word, startPos, line, column);
    }
    return this.makeToken(TokenType.Identifier, word, startPos, line, column);
  }

  // ---- Numbers ----

  private scanNumber(startPos: number, line: number, column: number): Token {
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      this.advance();
      this.advance();
      while (isHexDigit(this.peek())) this.advance();
      if (this.peek() === '.') {
        this.advance();
        while (isHexDigit(this.peek())) this.advance();
      }
      if (this.peek() === 'p' || this.peek() === 'P') {
        this.advance();
        if (this.peek() === '+' || this.peek() === '-') this.advance();
        while (isDigit(this.peek())) this.advance();
      }
    } else {
      while (isDigit(this.peek())) this.advance();
      if (this.peek() === '.') {
        this.advance();
        while (isDigit(this.peek())) this.advance();
      }
      if (this.peek() === 'e' || this.peek() === 'E') {
        this.advance();
        if (this.peek() === '+' || this.peek() === '-') this.advance();
        while (isDigit(this.peek())) this.advance();
      }
    }
    const raw = this.src.slice(startPos, this.pos);
    const value = raw.toLowerCase().startsWith('0x') ? parseHexNumber(raw) : parseFloat(raw);
    return this.makeToken(TokenType.NumericLiteral, value, startPos, line, column);
  }

  // ---- Plain quoted strings ("..." / '...') ----

  private scanQuotedString(startPos: number, line: number, column: number): Token {
    const quote = this.advance(); // consume opening quote
    let value = '';
    for (;;) {
      if (this.pos >= this.src.length) this.error('unfinished string');
      const ch = this.peek();
      if (ch === quote) {
        this.advance();
        break;
      }
      if (ch === '\n') this.error('unfinished string');
      if (ch === '\\') {
        this.advance();
        value += this.readEscape();
        continue;
      }
      value += this.advance();
    }
    return this.makeToken(TokenType.StringLiteral, value, startPos, line, column);
  }

  private readEscape(): string {
    const ch = this.advance();
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\x0b';
      case '\\': return '\\';
      case '"': return '"';
      case "'": return "'";
      case '\n': return '\n';
      case 'x': {
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

  private tryScanLongBracket(): string | null {
    const save = { pos: this.pos, line: this.line, lineStart: this.lineStart };
    if (this.peek() !== '[') return null;
    this.advance();
    let level = 0;
    while (this.peek() === '=') {
      level++;
      this.advance();
    }
    if (this.peek() !== '[') {
      // Wasn't a long bracket after all - roll back
      this.pos = save.pos;
      this.line = save.line;
      this.lineStart = save.lineStart;
      return null;
    }
    this.advance();
    // By convention, the first newline right after the opening bracket is
    // ignored. For files saved with CRLF ('\r\n'), the first character is
    // '\r', so a bare '\n' check alone couldn't skip it and '\r' would leak
    // into the string content.
    if (this.peek() === '\r' && this.peek(1) === '\n') {
      this.advance();
      this.advance();
    } else if (this.peek() === '\n' || this.peek() === '\r') {
      this.advance();
    }

    const contentStart = this.pos;
    const closer = ']' + '='.repeat(level) + ']';
    const closeIdx = this.src.indexOf(closer, this.pos);
    if (closeIdx === -1) this.error('unfinished long string/comment');
    const content = this.src.slice(contentStart, closeIdx);
    // Advance pos past the closing bracket while keeping the line count correct
    while (this.pos < closeIdx + closer.length) this.advance();
    return content;
  }

  // ---- Luau string interpolation: `...{expr}...` ----

  private scanInterpolatedString(startPos: number, line: number, column: number): Token {
    this.advance(); // opening backtick
    const parts: InterpolationPart[] = [];
    let buf = '';

    for (;;) {
      if (this.pos >= this.src.length) this.error('unfinished interpolated string');
      const ch = this.peek();

      if (ch === '`') {
        this.advance();
        if (buf.length > 0 || parts.length === 0) parts.push({ kind: 'string', value: buf });
        break;
      }

      if (ch === '\\') {
        this.advance();
        buf += this.readEscape();
        continue;
      }

      if (ch === '{') {
        // `{{` is treated as a single literal `{` (Luau rule)
        if (this.peek(1) === '{') {
          this.advance();
          this.advance();
          buf += '{';
          continue;
        }
        parts.push({ kind: 'string', value: buf });
        buf = '';
        this.advance(); // consume '{'
        const exprLine = this.line;
        const exprColumn = this.column;
        const exprStart = this.pos;
        // Just counting `{`/`}` depth would also count braces inside a string
        // literal within the expression (e.g. `{f("}")}`), cutting the
        // expression off too early. String/nested interpolated-string parts
        // must be skipped wholesale so their braces are ignored.
        this.skipBalancedInterpolationExpr();
        const exprSource = this.src.slice(exprStart, this.pos);
        this.advance(); // consume '}'
        parts.push({ kind: 'expr', source: exprSource, line: exprLine, column: exprColumn });
        continue;
      }

      buf += this.advance();
    }

    return this.makeToken(
      TokenType.InterpolatedStringLiteral,
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
  private skipBalancedInterpolationExpr(): void {
    let depth = 1;
    while (depth > 0) {
      if (this.pos >= this.src.length) this.error('unfinished interpolation expression');
      const c = this.peek();
      if (c === '"' || c === "'") {
        this.skipRawQuotedString();
        continue;
      }
      if (c === '`') {
        this.skipRawInterpolatedString();
        continue;
      }
      if (c === '{') {
        depth++;
        this.advance();
        continue;
      }
      if (c === '}') {
        depth--;
        if (depth === 0) return; // leave the closing '}' unconsumed
        this.advance();
        continue;
      }
      this.advance();
    }
  }

  /** Skips over `"..."` / `'...'` as raw text without interpreting it as a value (escapes are just skipped). */
  private skipRawQuotedString(): void {
    const quote = this.advance();
    while (true) {
      if (this.pos >= this.src.length) this.error('unfinished string');
      const ch = this.peek();
      if (ch === quote) {
        this.advance();
        return;
      }
      if (ch === '\n') this.error('unfinished string');
      if (ch === '\\') {
        this.advance();
        if (this.pos < this.src.length) this.advance(); // always skip one escaped character wholesale
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
  private skipRawInterpolatedString(): void {
    this.advance(); // opening backtick
    while (true) {
      if (this.pos >= this.src.length) this.error('unfinished interpolated string');
      const ch = this.peek();
      if (ch === '`') {
        this.advance();
        return;
      }
      if (ch === '\\') {
        this.advance();
        if (this.pos < this.src.length) this.advance();
        continue;
      }
      if (ch === '{') {
        if (this.peek(1) === '{') {
          this.advance();
          this.advance();
          continue;
        }
        this.advance(); // consume '{'
        this.skipBalancedInterpolationExpr();
        if (this.peek() === '}') this.advance();
        continue;
      }
      this.advance();
    }
  }

  // ---- Punctuators (operators/symbols), including Luau's compound assignment operators ----

  private scanPunctuator(startPos: number, line: number, column: number): Token {
    const ch = this.advance();

    // Three characters
    if (ch === '.' && this.peek() === '.' && this.peek(1) === '.') {
      this.advance();
      this.advance();
      return this.makeToken(TokenType.VarargLiteral, '...', startPos, line, column);
    }

    // Two-character combinations
    const two = ch + this.peek();
    const twoCharPunctuators = new Set([
      '==', '~=', '<=', '>=', '::', '..',
      '+=', '-=', '*=', '/=', '%=', '^=', // Luau compound assignment
      '->', // Luau function type: (number) -> string
      '?.', '?[', // Luau optional chaining: a?.b / a?[b]
    ]);
    if (twoCharPunctuators.has(two)) {
      this.advance();
      return this.makeToken(TokenType.Punctuator, two, startPos, line, column);
    }
    // //= and ..= are three characters
    if (ch === '/' && this.peek() === '/') {
      this.advance();
      if (this.peek() === '=') {
        this.advance();
        return this.makeToken(TokenType.Punctuator, '//=', startPos, line, column);
      }
      return this.makeToken(TokenType.Punctuator, '//', startPos, line, column);
    }
    if (ch === '.' && this.peek() === '.' && this.peek(1) === '=') {
      this.advance();
      this.advance();
      return this.makeToken(TokenType.Punctuator, '..=', startPos, line, column);
    }

    const singleCharPunctuators = new Set([
      '+', '-', '*', '/', '%', '^', '#', '&', '~', '|',
      '<', '>', '=', '(', ')', '{', '}', '[', ']',
      ';', ':', ',', '.', '?', // '?' is used in Luau optional types (T?)
    ]);
    if (singleCharPunctuators.has(ch)) {
      return this.makeToken(TokenType.Punctuator, ch, startPos, line, column);
    }

    this.error(`unexpected symbol '${ch}'`);
  }

  private makeToken(
    type: TokenType,
    value: Token['value'],
    startPos: number,
    line: number,
    column: number,
    parts?: InterpolationPart[]
  ): Token {
    return {
      type,
      value,
      raw: this.src.slice(startPos, this.pos),
      line,
      column,
      range: [startPos, this.pos],
      parts,
    };
  }
}
