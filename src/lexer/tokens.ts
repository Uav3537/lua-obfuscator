// Token kinds. Modeled as bit flags like luaparse does, so checks like "is
// this token some kind of literal?" can later be done with a single bitwise op.
export enum TokenType {
  EOF = 1 << 0,
  StringLiteral = 1 << 1,
  Keyword = 1 << 2,
  Identifier = 1 << 3,
  NumericLiteral = 1 << 4,
  Punctuator = 1 << 5,
  BooleanLiteral = 1 << 6,
  NilLiteral = 1 << 7,
  VarargLiteral = 1 << 8,
  // Luau extension: backtick string interpolation. Instead of splitting it
  // into Begin/Mid/End tokens, we carry all the pieces (parts) on a single
  // token — much easier for the parser to handle (see InterpolationPart below).
  InterpolatedStringLiteral = 1 << 9,
}

// Each piece of an interpolated string. 'string' is a literal piece as-is;
// 'expr' is the raw source text inside `{ }` — the parser later re-lexes/
// re-parses this text into an Expression node.
export type InterpolationPart =
  | { kind: 'string'; value: string }
  | { kind: 'expr'; source: string; line: number; column: number };

export const LiteralTypes =
  TokenType.StringLiteral |
  TokenType.NumericLiteral |
  TokenType.BooleanLiteral |
  TokenType.NilLiteral |
  TokenType.VarargLiteral;

export interface Token {
  type: TokenType;
  value: string | number | boolean | null;
  raw: string;
  line: number;
  column: number;
  // [start, end) offset into the source string. Used for error messages and slicing the original source.
  range: [number, number];
  // Only populated for InterpolatedStringLiteral tokens
  parts?: InterpolationPart[];
}

// Lua 5.1 reserved words. Note `goto` is deliberately excluded here: it was
// only reserved starting in Lua 5.2 (5.1 treats it as a plain identifier),
// and Luau — despite being based on 5.1 — never adopted the goto/label
// feature either. So under both dialects this project currently supports,
// `goto` is just an identifier. It's kept available as a toggle (like
// `continue`) so a future dialect that does support goto only has to flip
// the flag in dialect.ts.
export const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif',
  'end', 'false', 'for', 'function', 'if',
  'in', 'local', 'nil', 'not', 'or', 'repeat',
  'return', 'then', 'true', 'until', 'while',
]);

// `continue` isn't a reserved word in standard Lua (it's treated as a plain
// identifier), but it is an actual keyword in Luau. So it's kept in its own
// Set that can be toggled on/off via the dialect option.
export const LUAU_ONLY_KEYWORDS = new Set(['continue']);

// `goto` — reserved starting in Lua 5.2, not present in Lua 5.1 or Luau.
// Neither dialect this project supports enables it today; this exists so a
// future dialect (e.g. 'lua5.2') can turn it on without touching the lexer.
export const GOTO_KEYWORDS = new Set(['goto']);

/**
 * @param continueKeyword Whether to treat `continue` as a reserved word. Must
 *   be passed as false when the dialect is lua5.1 — otherwise 5.1 code like
 *   `local continue = 1` wouldn't lex correctly as an Identifier token.
 * @param gotoKeyword Whether to treat `goto` as a reserved word. Must be
 *   false for both lua5.1 and luaU — otherwise code like `local goto = 1`
 *   (valid in both) wouldn't lex correctly as an Identifier token.
 */
export function isKeyword(word: string, continueKeyword: boolean, gotoKeyword: boolean): boolean {
  if (KEYWORDS.has(word)) return true;
  if (continueKeyword && LUAU_ONLY_KEYWORDS.has(word)) return true;
  if (gotoKeyword && GOTO_KEYWORDS.has(word)) return true;
  return false;
}
