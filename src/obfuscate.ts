import { Lexer } from './lexer/lexer';
import { Parser } from './parser/parser';
import { Chunk } from './ast/nodes';
import { generate } from './codegen/generator';
import { DialectName, resolveDialect } from './dialect';
import { resolveScopes } from './analysis/scope';
import { ObfuscateOptions, PassContext, StepConfig } from './passes/types';
import { renameVariables } from './passes/rename-variables';
import { numbersToExpressions } from './passes/numbers-to-expressions';
import { stringsToExpressions } from './passes/strings-to-expressions';
import { encryptStrings } from './passes/encrypt-strings';
import { constantArray } from './passes/constant-array';
import { vmify } from './passes/vmify';
import { insertJunk } from './passes/junk';
import { globalMapping } from './passes/global-mapping';
import { wrapInFunction } from './passes/wrap-function';
import { encryptNumbers } from './passes/encrypt-numbers';

export type { ObfuscateOptions, StepConfig } from './passes/types';

/**
 * Obfuscates Lua/Luau source code by parsing it and running the requested
 * pipeline of passes over the AST, in the order given, then re-emitting
 * source.
 *
 *   obfuscate(src, 'luaU', { steps: [
 *     { name: 'Vmify' },
 *     { name: 'RenameVariables' },
 *     { name: 'ConstantArray' },
 *     { name: 'EncryptStrings' },
 *     { name: 'StringsToExpressions', min: 5, max: 20 },
 *     { name: 'NumbersToExpressions', min: 5, max: 20 },
 *   ]})
 */
export function obfuscate(source: string, dialect: DialectName, options: ObfuscateOptions): string {
  const flags = resolveDialect(dialect);
  const ctx: PassContext = { dialect: flags };
  const tokens = new Lexer(source, flags).tokenize();
  let chunk: Chunk = new Parser(tokens, flags).parseChunk();
  resolveScopes(chunk); // every Identifier's .scope/.bindingId is accurate from here on

  for (const step of options.steps) {
    chunk = runStep(chunk, ctx, step);
    resolveScopes(chunk); // re-resolve after every step: passes can inject new
    // declarations (synthetic locals, hoisted decoders, etc.) that don't carry
    // accurate .scope/.bindingId on their own — later passes (esp. Vmify) must
    // never see stale/inert scope info.
  }

  return generate(chunk, { minify: options.minify });
}

function runStep(chunk: Chunk, ctx: PassContext, step: StepConfig) {
  switch (step.name) {
    case 'RenameVariables':
      return renameVariables(chunk, ctx, {});
    case 'NumbersToExpressions':
      return numbersToExpressions(chunk, ctx, { min: step.min, max: step.max });
    case 'StringsToExpressions':
      return stringsToExpressions(chunk, ctx, { min: step.min, max: step.max });
    case 'EncryptStrings':
      return encryptStrings(chunk, ctx, {});
    case 'EncryptNumbers':
      return encryptNumbers(chunk, ctx, {})
    case 'ConstantArray':
      return constantArray(chunk, ctx, {});
    case 'Vmify':
      return vmify(chunk, ctx, {});
    case 'InsertJunk':
      return insertJunk(chunk, ctx, { probability: step.probability, maxPerBlock: step.maxPerBlock })
    case 'GlobalMapping':
      return globalMapping(chunk, ctx, { globalTableName: step.globalTableName })
    case 'WrapInFunction':
      return wrapInFunction(chunk, ctx, {})
    default: {
      const _exhaustive: never = step;
      throw new Error(`obfuscate: unknown step ${JSON.stringify(_exhaustive)}`);
    }
  }
}