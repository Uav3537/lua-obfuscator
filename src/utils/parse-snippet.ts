// Thin re-implementation of the top-level `parse()` for internal use by
// passes that need to synthesize runtime helper code from a Lua source
// template. Kept separate from src/index.ts to avoid a circular import
// (index.ts re-exports obfuscate(), which pulls in the passes).
import { Lexer } from '../lexer/lexer';
import { Parser } from '../parser/parser';
import { Chunk } from '../ast/nodes';
import { DialectName, resolveDialect } from '../dialect';
import { resolveScopes } from '../analysis/scope';

export function parseSnippet(source: string, dialect: DialectName): Chunk {
  const flags = resolveDialect(dialect);
  const tokens = new Lexer(source, flags).tokenize();
  const chunk = new Parser(tokens, flags).parseChunk();
  resolveScopes(chunk);
  return chunk;
}
