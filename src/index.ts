import { Lexer, LexError } from './lexer/lexer';
import { Parser } from './parser/parser';
import { ParseError } from './parser/cursor';
import { resolveDialect, DialectName, UnknownDialectError } from './dialect';
import { Chunk } from './ast/nodes';
import { resolveScopes } from './analysis/scope';

export type { DialectName } from './dialect';
export { LexError } from './lexer/lexer';
export { ParseError } from './parser/cursor';
export { UnknownDialectError } from './dialect';
export type * from './ast/nodes';
export { resolveScopes } from './analysis/scope';
export type { Binding, BindingKind } from './analysis/scope';

/**
 * Parses source code and returns an AST (Chunk) with lexical scope already
 * resolved: every Identifier's `.scope` ('local' | 'parameter' | 'upvalue' |
 * 'global') and `.bindingId` accurately reflect where it's actually bound,
 * not just the parser's syntactic guess at the declaration site.
 *
 *   parse(source, 'lua5.1')  -> parse as standard Lua 5.1 syntax
 *   parse(source, 'luaU')    -> parse as Luau syntax (types, continue, string interpolation, attributes, etc.)
 *
 * Throws a ParseError when it encounters syntax the dialect doesn't support
 * (e.g. parsing `local x <const> = 1` while the dialect is lua5.1).
 */
export function parse(source: string, dialect: DialectName): Chunk {
  const flags = resolveDialect(dialect);
  const tokens = new Lexer(source, flags).tokenize();
  const parser = new Parser(tokens, flags);
  const chunk = parser.parseChunk();
  resolveScopes(chunk);
  return chunk;
}

export { generate } from './codegen/generator';
export type { GeneratorOptions } from './codegen/generator';
export { obfuscate } from './obfuscate';
export type { ObfuscateOptions, StepConfig } from './obfuscate';
