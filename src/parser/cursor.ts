import { Token, TokenType } from '../lexer/tokens';
import { DialectFlags } from '../dialect';
import { Position, SourceLocation } from '../ast/nodes';

export class ParseError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`[${line}:${column}] ${message}`);
  }
}

/**
 * Base class holding only the low-level utilities for walking the token stream.
 * TypeParser extends this, and the main Parser extends TypeParser in turn:
 *
 *   Cursor <- TypeParser <- Parser
 *
 * TypeParser needs an expression parser to parse the `expr` inside
 * `typeof(expr)`, but the expression parser only exists on Parser. So
 * TypeParser declares parseExpression as abstract, and Parser implements it
 * (sharing functionality without a circular import).
 */
export abstract class Cursor {
  protected pos = 0;

  constructor(
    protected readonly tokens: Token[],
    protected readonly dialect: DialectFlags
  ) {}

  // ---- Basic lookup / movement ----

  protected current(): Token {
    return this.tokens[this.pos];
  }

  protected peek(offset = 0): Token {
    const idx = this.pos + offset;
    return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
  }

  protected previous(): Token {
    return this.tokens[this.pos - 1];
  }

  protected isAtEnd(): boolean {
    return this.current().type === TokenType.EOF;
  }

  protected advance(): Token {
    const tok = this.current();
    if (!this.isAtEnd()) this.pos++;
    return tok;
  }

  // ---- Checks ----

  protected check(type: TokenType, value?: string | number | boolean): boolean {
    const tok = this.current();
    if (tok.type !== type) return false;
    if (value !== undefined && tok.value !== value) return false;
    return true;
  }

  protected checkKeyword(word: string): boolean {
    return this.check(TokenType.Keyword, word);
  }

  protected checkPunct(value: string): boolean {
    return this.check(TokenType.Punctuator, value);
  }

  protected match(type: TokenType, value?: string | number | boolean): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  protected matchKeyword(word: string): boolean {
    return this.match(TokenType.Keyword, word);
  }

  protected matchPunct(value: string): boolean {
    return this.match(TokenType.Punctuator, value);
  }

  // ---- Mandatory consumption (error on failure) ----

  protected expect(type: TokenType, value: string | number | boolean | undefined, message: string): Token {
    if (!this.check(type, value)) {
      this.error(message);
    }
    return this.advance();
  }

  protected expectPunct(value: string): Token {
    return this.expect(TokenType.Punctuator, value, `expected '${value}' but found ${this.describeCurrent()}`);
  }

  protected expectKeyword(word: string): Token {
    return this.expect(TokenType.Keyword, word, `expected '${word}' but found ${this.describeCurrent()}`);
  }

  protected expectIdentifierName(): Token {
    return this.expect(TokenType.Identifier, undefined, `expected an identifier but found ${this.describeCurrent()}`);
  }

  private describeCurrent(): string {
    const tok = this.current();
    if (tok.type === TokenType.EOF) return '<eof>';
    return `'${tok.raw}'`;
  }

  // ---- Dialect gating ----

  /** Error if the current token requires a feature that's disabled in this dialect. No-op if enabled (caller proceeds). */
  protected requireDialectFeature(enabled: boolean, featureName: string): void {
    if (!enabled) {
      this.error(`'${featureName}' is Luau-only syntax (current dialect: ${this.dialect.name})`);
    }
  }

  // ---- Errors ----

  protected error(msg: string): never {
    const tok = this.current();
    throw new ParseError(msg, tok.line, tok.column);
  }

  // ---- Position calculation ----

  protected posOf(tok: Token): Position {
    return { line: tok.line, column: tok.column };
  }

  /** Computes the loc/range spanning from startTok to the "last consumed token". */
  protected finishRange(startTok: Token, endTok: Token = this.previous()): {
    range: [number, number];
    loc: SourceLocation;
  } {
    return {
      range: [startTok.range[0], endTok.range[1]],
      loc: {
        start: this.posOf(startTok),
        end: { line: endTok.line, column: endTok.column + (endTok.raw?.length ?? 0) },
      },
    };
  }
}
