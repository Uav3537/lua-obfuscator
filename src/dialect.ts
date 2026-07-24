// dialect: the single source of truth the lexer/parser use to decide "what
// grammar am I parsing right now". The user only ever supplies 'lua5.1' or
// 'luaU', and this file expands that into detailed feature flags. The
// lexer/parser/type-parser only ever look at these flags — no code outside
// this file should compare the dialect name directly (that way, adding
// another dialect later only requires touching this file).

export type DialectName = 'lua5.1' | 'luaU';

export interface DialectFlags {
  readonly name: DialectName;

  /** Whether `continue` is a reserved word (in Lua 5.1 it can be used as a plain identifier) */
  readonly continueKeyword: boolean;
  /**
   * goto statement / ::label:: syntax. This is a Lua 5.2+ feature — it does
   * not exist in Lua 5.1, and Luau (despite basing its grammar on 5.1) never
   * adopted it either. So this is false for every dialect this project
   * currently supports; it exists as a flag (rather than being hardcoded
   * off) purely so a future dialect like 'lua5.2' can turn it on.
   */
  readonly gotoStatements: boolean;
  /** += -= *= /= //= %= ^= ..= */
  readonly compoundAssignment: boolean;
  /** `...` backtick string interpolation */
  readonly stringInterpolation: boolean;
  /** local x <const> / local x <close> */
  readonly attributes: boolean;
  /** local x: number, function f(x: number): boolean, type Foo = ... */
  readonly typeAnnotations: boolean;
  /** // integer division operator (absent in 5.1, present in Luau) */
  readonly floorDivision: boolean;
  /** function f<T>(x: T): T ... generic functions */
  readonly genericFunctions: boolean;
  /** if...then...else... expression (Luau-only, a value rather than a statement) */
  readonly ifExpression: boolean;
  /** a?.b / a?[b] optional chaining (Luau-only) */
  readonly optionalChaining: boolean;
}

const LUA51_FLAGS: DialectFlags = {
  name: 'lua5.1',
  continueKeyword: false,
  gotoStatements: false,
  compoundAssignment: false,
  stringInterpolation: false,
  attributes: false,
  typeAnnotations: false,
  floorDivision: false,
  genericFunctions: false,
  ifExpression: false,
  optionalChaining: false,
};

const LUAU_FLAGS: DialectFlags = {
  name: 'luaU',
  continueKeyword: true,
  gotoStatements: false,
  compoundAssignment: true,
  stringInterpolation: true,
  attributes: true,
  typeAnnotations: true,
  floorDivision: true,
  genericFunctions: true,
  ifExpression: true,
  optionalChaining: true,
};

export class UnknownDialectError extends Error {
  constructor(given: string) {
    super(`unknown dialect '${given}' (expected 'lua5.1' or 'luaU')`);
  }
}

export function resolveDialect(name: DialectName): DialectFlags {
  switch (name) {
    case 'lua5.1':
      return LUA51_FLAGS;
    case 'luaU':
      return LUAU_FLAGS;
    default:
      throw new UnknownDialectError(name as string);
  }
}
