// EncryptNumbers: every NumericLiteral is encrypted (symmetric key, generated
// fresh per obfuscate() call) at build time. A small decrypt() runtime helper
// is injected at the top of the chunk; each numeric literal site is replaced
// with a call `decryptFn(<encoded value>, <slot>)` that recovers the original
// number when the script actually runs. Mirrors EncryptStrings' approach —
// same shared-key-array + injected-helper shape — just adapted for numbers
// instead of byte strings.
import * as N from '../ast/nodes';
import { transformExpressions } from '../utils/walk';
import { parseSnippet } from '../utils/parse-snippet';
import { callExpr, ident, numLit } from '../ast/builders';
import { randInt, randomVarName } from '../utils/random';
import { Pass, PassContext } from './types';

function buildDecryptHelper(fnName: string, keyName: string, key: number[], dialect: PassContext['dialect']): N.Statement[] {
  const keyLiteral = `{${key.join(', ')}}`;
  // `_slot` picks which key element ciphered this particular literal (same
  // rotating-key-by-position idea EncryptStrings uses per byte, just once
  // per literal here instead of once per character).
  const src = `
    local ${keyName} = ${keyLiteral}
    local function ${fnName}(_enc, _slot)
      local _k = ${keyName}[((_slot - 1) % #${keyName}) + 1]
      return _enc - _k
    end
  `;
  return parseSnippet(src, dialect.name).body;
}

export const encryptNumbers: Pass<Record<string, never>> = (chunk, ctx) => {
  const key: number[] = Array.from({ length: randInt(4, 8) }, () => randInt(1000, 999999));
  const names = new Set<string>();
  const fnName = randomVarName(names);
  const keyName = randomVarName(names);

  let slot = 0;
  let touched = false;

  transformExpressions(chunk, (expr) => {
    if (expr.type === 'NumericLiteral' && Number.isFinite(expr.value) && !expr.synthetic) {
      touched = true;
      slot += 1;
      const k = key[(slot - 1) % key.length];
      return callExpr(ident(fnName), [numLit(expr.value + k, true), numLit(slot, true)]);
    }
    return null;
  });

  if (touched) {
    const helper = buildDecryptHelper(fnName, keyName, key, ctx.dialect);
    chunk.body = [...helper, ...chunk.body];
  }
  return chunk;
};