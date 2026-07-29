// EncryptStrings: every StringLiteral is XOR-encrypted (symmetric key,
// generated fresh per obfuscate() call) at build time. A small decrypt()
// runtime helper is injected at the top of the chunk; each string literal
// site is replaced with a call `decryptFn("<encrypted bytes>")` that
// recovers the original text when the script actually runs.
import * as N from '../ast/nodes';
import { transformExpressions } from '../utils/walk';
import { parseSnippet } from '../utils/parse-snippet';
import { callExpr, ident, strLit } from '../ast/builders';
import { randInt, randomVarName } from '../utils/random';
import { Pass, PassContext } from './types';

function buildDecryptHelper(fnName: string, keyName: string, key: number[], dialect: PassContext['dialect']): N.Statement[] {
  const keyLiteral = `{${key.join(', ')}}`;
  // This grammar doesn't expose a bitwise-xor infix operator (Luau only
  // reaches bitwise ops through the bit32 library), so the cipher uses
  // modular add/sub instead of xor — still a symmetric keyed cipher.
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

function modEncrypt(value: string, key: number[]): string {
  const bytes = Array.from(value).map((c) => c.codePointAt(0)! & 0xff);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const k = key[i % key.length];
    const enc = (bytes[i] + k) % 256;
    out += String.fromCharCode(enc);
  }
  return out;
}

export const encryptStrings: Pass<Record<string, never>> = (chunk, ctx) => {
  const key: number[] = Array.from({ length: randInt(4, 8) }, () => randInt(1, 255));
  const names = new Set<string>();
  const fnName = randomVarName(names);
  const keyName = randomVarName(names);

  let touched = false;

  transformExpressions(chunk, (expr) => {
    if (expr.type === 'StringLiteral' && !expr.synthetic) {
      touched = true;
      const enc = modEncrypt(expr.value, key);
      return callExpr(ident(fnName), [strLit(enc, true)]);
    }
    return null;
  });

  if (touched) {
    const helper = buildDecryptHelper(fnName, keyName, key, ctx.dialect);
    chunk.body = [...helper, ...chunk.body];
  }
  return chunk;
};
